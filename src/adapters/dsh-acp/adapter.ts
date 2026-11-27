import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AttachmentDraft } from '../../shared/content.js';
import type { Project } from '../../project/kernel.js';
import { assertProjectDirectory } from '../../project/project-directory.js';
import { buildDshPrompt } from './content.js';
import { sessionTitleSidecarName } from './sidecar.js';
import type {
  ApprovalDecision,
  ApprovalOption,
  ApprovalOptionKind,
  ApprovalRequest,
  ConversationOptions,
  HarnessAdapter,
  HarnessCapabilities,
  HarnessEvent,
  StopReason,
} from '../harness.js';
import { AcpRpcClient, AcpRpcError } from './client.js';
import { killProcessTree } from './process-tree.js';
import { SessionPromptQueue } from './prompt-queue.js';
export { canonicalCwd, sessionTitleSidecarName } from './sidecar.js';

const DEFAULT_INITIALIZE_TIMEOUT_MS = 30_000;
const DEFAULT_SESSION_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 5_000;

export interface DshAcpAdapterOptions {
  readonly dshRoot: string;
  readonly nodePath?: string;
  readonly initializeTimeoutMs?: number;
  readonly sessionTimeoutMs?: number;
  /** Extra launcher flags, for example ['--patch', path]. */
  readonly dshArgs?: readonly string[];
  /** Extra environment for the harness process; never logged. */
  readonly env?: NodeJS.ProcessEnv;
  /** Optional ACP session/new MCP server declarations. */
  readonly mcpServers?: readonly Record<string, unknown>[];
  /**
   * Advertise native renaming and route titles through the WAX sidecar read by
   * the `wax-bridge` DSH plugin. Defaults to false.
   */
  readonly nativeTitles?: boolean;
  /** Directory holding `<sha256(canonicalCwd)>.json` title sidecars. */
  readonly sidecarDir?: string;
}

interface PendingApproval {
  readonly resolve: (result: unknown) => void;
  readonly sessionId: string;
  readonly executionId: string;
  readonly options: readonly ApprovalOption[];
}

interface ServerRequest {
  readonly id: number | string;
  readonly method: string;
  readonly params?: unknown;
}

export class DshAcpAdapter implements HarnessAdapter {
  readonly capabilities: HarnessCapabilities;

  private readonly dshRoot: string;
  private readonly nodePath: string;
  private readonly initializeTimeoutMs: number;
  private readonly sessionTimeoutMs: number;
  private readonly dshArgs: readonly string[];
  private readonly env: NodeJS.ProcessEnv;
  private readonly mcpServers: readonly Record<string, unknown>[];
  private readonly nativeTitles: boolean;
  private readonly sidecarDir: string | undefined;
  private readonly listeners = new Set<(event: HarnessEvent) => void>();
  private readonly prompts: SessionPromptQueue;
  private readonly closing = new Set<string>();
  private imagePrompts = false;
  private readonly cwdBySession = new Map<string, string>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly stderrLines: string[] = [];
  private child: ChildProcessWithoutNullStreams | undefined;
  private client: AcpRpcClient | undefined;
  private started = false;
  private stopping = false;

  constructor(options: DshAcpAdapterOptions) {
    this.dshRoot = options.dshRoot;
    this.nodePath = options.nodePath ?? process.execPath;
    this.initializeTimeoutMs = options.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS;
    this.sessionTimeoutMs = options.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;
    this.dshArgs = options.dshArgs ?? [];
    this.env = options.env ?? {};
    this.mcpServers = options.mcpServers ?? [];
    this.nativeTitles = options.nativeTitles === true;
    this.sidecarDir = options.sidecarDir;
    this.capabilities = {
      approval: 'interactive',
      cancel: true,
      streaming: true,
      // The DSH `wax-bridge` plugin promotes a per-cwd sidecar written by
      // createConversation into the native session/title event. Workspace
      // ownership stays on the DSH side; WAX only names its own session.
      rename: this.nativeTitles,
      // G016 verified session/resume across a process restart; the ACP server
      // has no session/load, and resume() below does not replay history.
      resume: true,
      // One native session accepts one WAX prompt at a time; overlapping
      // submits wait here in FIFO order instead of reaching ACP concurrently.
      queue: true,
    };
    this.prompts = new SessionPromptQueue({
      send: (nativeId, prompt) =>
        this.requireClient().request('session/prompt', prompt.params),
      emit: (event) => this.emit(event),
      terminal: (executionId, result) => terminalEventForResult(executionId, result),
      failure: (executionId, error) => failureEventForError(executionId, error),
    });
  }

  onEvent(handler: (event: HarnessEvent) => void): () => void {
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    const bin = join(this.dshRoot, 'apps', 'cli', 'lib', 'bin.js');
    if (!existsSync(bin)) {
      throw new Error(`DSH CLI not found under dshRoot: ${bin}`);
    }

    const child = spawn(this.nodePath, [bin, '--profile', 'acp', ...this.dshArgs], {
      cwd: this.dshRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this.env },
      windowsHide: true,
    });
    this.child = child;

    let rejectSpawn: (error: Error) => void = () => undefined;
    const spawnFailure = new Promise<never>((_, reject) => {
      rejectSpawn = reject;
    });
    child.once('error', (error) => {
      rejectSpawn(error);
    });
    child.on('error', (error) => {
      this.handleChildError(error);
    });

    this.client = new AcpRpcClient(child);

    child.stderr.setEncoding('utf8');
    let buffer = '';
    child.stderr.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim() === '') {
          continue;
        }
        this.stderrLines.push(line);
        if (this.stderrLines.length > 20) {
          this.stderrLines.shift();
        }
      }
    });

    this.client.onNotification((notification) => this.handleNotification(notification.method, notification.params));
    this.client.onRequest((request) => this.handleServerRequest(request));
    this.client.onError((error) => this.emit({ type: 'adapter/error', message: error.message }));
    this.client.onExit((code, signal) => this.handleExit(code, signal));

    try {
      const initialized = await Promise.race([
        this.client.request(
          'initialize',
          {
            protocolVersion: 1,
            clientCapabilities: {
              fs: { readTextFile: false, writeTextFile: false },
              terminal: false,
            },
            clientInfo: { name: 'wax-apiary-nexus', version: '0.0.0' },
          },
          this.initializeTimeoutMs,
        ),
        spawnFailure,
      ]);
      const promptCapabilities = asRecord(
        asRecord(asRecord(initialized)?.agentCapabilities)?.promptCapabilities,
      );
      this.imagePrompts = promptCapabilities?.image === true;
      this.started = true;
    } catch (error) {
      this.started = false;
      this.client.close();
      killProcessTree(child);
      this.client = undefined;
      this.child = undefined;
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    // Settle waiting prompts before teardown so they report cancelled, not unknown.
    this.prompts.abortAll('cancelled', 'DSH ACP adapter stopped');
    const child = this.child;
    if (child !== undefined) {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      try {
        child.stdin.end();
      } catch {
        // The child may already be gone.
      }
      // Kill the whole tree; orphaned DSH tool children block the next start.
      killProcessTree(child);
      await Promise.race([exited, delay(STOP_TIMEOUT_MS)]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
      }
    }
    for (const pending of this.pendingApprovals.values()) {
      pending.resolve(cancelledPermissionOutcome());
    }
    this.pendingApprovals.clear();
    this.prompts.clearActive();
    this.closing.clear();
    this.cwdBySession.clear();
    this.client?.close();
    this.client = undefined;
    this.child = undefined;
    this.started = false;
    this.stopping = false;
  }

  async createConversation(
    project: Project,
    options: ConversationOptions = {},
  ): Promise<string> {
    assertProjectDirectory(project.directory);
    const client = this.requireClient();
    const params: Record<string, unknown> = {
      cwd: project.directory,
      mcpServers: this.mcpServers,
    };
    // The DSH plugin cannot see ACP `_meta`; the title travels through a
    // per-cwd sidecar written before session/new and removed afterwards.
    const displayName = options.displayName;
    const sidecar = this.nativeTitles && this.sidecarDir !== undefined
      && displayName !== undefined && displayName.length > 0
      ? join(this.sidecarDir, sessionTitleSidecarName(project.directory))
      : undefined;
    if (sidecar !== undefined && displayName !== undefined) {
      this.writeTitleSidecar(sidecar, displayName);
    }
    try {
      const result = await client.request('session/new', params, this.sessionTimeoutMs);
      const sessionId = asString(asRecord(result)?.sessionId);
      if (sessionId === undefined) {
        throw new Error('ACP session/new did not return a sessionId');
      }
      this.cwdBySession.set(sessionId, project.directory);
      return sessionId;
    } finally {
      if (sidecar !== undefined) {
        try {
          rmSync(sidecar, { force: true });
        } catch {
          // Title sidecars are best-effort; cleanup must not mask the outcome.
        }
      }
    }
  }

  /** Reattach to a session created by an earlier process (no history replay). */
  async resume(nativeId: string, cwd: string): Promise<void> {
    const client = this.requireClient();
    await client.request(
      'session/resume',
      { sessionId: nativeId, cwd },
      this.sessionTimeoutMs,
    );
    this.cwdBySession.set(nativeId, cwd);
  }

  async submit(
    nativeId: string,
    executionId: string,
    text: string,
    attachments?: readonly AttachmentDraft[],
  ): Promise<void> {
    this.requireClient();
    if (this.closing.has(nativeId)) {
      throw new Error(`ACP session is closing and cannot accept new work: ${nativeId}`);
    }
    const cwd = this.cwdBySession.get(nativeId);
    if (cwd === undefined) {
      throw new Error(`Unknown ACP session: ${nativeId}`);
    }
    assertProjectDirectory(cwd);
    this.prompts.submit(nativeId, {
      executionId,
      params: {
        sessionId: nativeId,
        prompt: buildDshPrompt(text, attachments, this.imagePrompts),
      },
    });
  }

  /**
   * Remove one not-yet-started prompt; the active prompt is untouched. The
   * execution still receives its one terminal event, so a forager waiting on a
   * queued prompt is never stranded by an explicit cancel.
   */
  readonly dropQueued = (nativeId: string, executionId: string): Promise<boolean> =>
    Promise.resolve(this.prompts.drop(nativeId, executionId));

  async cancel(nativeId: string): Promise<void> {
    const client = this.requireClient();
    this.cancelPendingApprovals(nativeId);
    // A native cancel cannot revive a queued prompt; WAX-cancelled queue items
    // are settled here so nothing is sent after the caller asked to stop.
    this.prompts.abortWaiting(nativeId, 'cancelled', 'ACP session cancelled');
    client.notify('session/cancel', { sessionId: nativeId });
  }

  async respondToApproval(decision: ApprovalDecision): Promise<void> {
    const pending = this.pendingApprovals.get(decision.requestId);
    if (pending === undefined) {
      throw new Error(`Unknown ACP approval request: ${decision.requestId}`);
    }
    if (decision.kind === 'cancelled') {
      this.pendingApprovals.delete(decision.requestId);
      pending.resolve(cancelledPermissionOutcome());
      return;
    }
    const option = pending.options.find((candidate) => candidate.kind === decision.kind);
    if (option === undefined) {
      throw new Error(`ACP did not offer approval option: ${decision.kind}`);
    }
    this.pendingApprovals.delete(decision.requestId);
    pending.resolve({
      outcome: { outcome: 'selected', optionId: option.id },
    });
  }

  async closeConversation(nativeId: string): Promise<void> {
    const client = this.requireClient();
    this.closing.add(nativeId);
    this.cancelPendingApprovals(nativeId);
    // Clear admitted prompts before asking the native side to close; a close
    // whose outcome is unknown must not leave work that could still be sent.
    this.prompts.abortWaiting(nativeId, 'cancelled', 'ACP session closed');
    const active = this.prompts.activeOf(nativeId);
    await client.request('session/close', { sessionId: nativeId }, this.sessionTimeoutMs);
    this.closing.delete(nativeId);
    this.cwdBySession.delete(nativeId);
    if (active !== undefined && this.prompts.activeOf(nativeId)?.executionId === active.executionId) {
      this.prompts.forgetActive(nativeId);
      this.emit({ type: 'execution/cancelled', executionId: active.executionId });
    }
  }

  /** Recent stderr, for local diagnosis; callers must not assume it is secret-free. */
  recentStderr(): readonly string[] {
    return [...this.stderrLines];
  }

  private handleNotification(method: string, params: unknown): void {
    if (method !== 'session/update') {
      return;
    }
    const record = asRecord(params);
    const sessionId = asString(record?.sessionId);
    const update = asRecord(record?.update);
    if (sessionId === undefined || update === undefined) {
      return;
    }
    const executionId = this.prompts.activeOf(sessionId)?.executionId;
    if (executionId === undefined) {
      return;
    }
    const kind = asString(update.sessionUpdate);
    if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') {
      const content = asRecord(update.content);
      const text = asString(content?.text);
      if (text !== undefined) {
        this.emit({
          type: 'execution/output',
          executionId,
          channel: kind === 'agent_message_chunk' ? 'assistant' : 'thought',
          text,
        });
      }
      return;
    }
    if (kind === 'tool_call' || kind === 'tool_call_update') {
      const toolCallId = asString(update.toolCallId);
      if (toolCallId === undefined) {
        return;
      }
      this.emit({
        type: 'execution/tool',
        executionId,
        toolCallId,
        title: asString(update.title) ?? '',
        status: asString(update.status) ?? '',
      });
    }
  }

  private handleServerRequest(request: ServerRequest): Promise<unknown> {
    if (request.method !== 'session/request_permission') {
      return Promise.reject(new Error(`Unsupported ACP server request: ${request.method}`));
    }
    const params = asRecord(request.params);
    const sessionId = asString(params?.sessionId);
    const active = sessionId === undefined ? undefined : this.prompts.activeOf(sessionId);
    if (active === undefined) {
      return Promise.resolve(cancelledPermissionOutcome());
    }
    const options = mapApprovalOptions(params?.options);
    if (options.length === 0) {
      return Promise.resolve(cancelledPermissionOutcome());
    }
    // ACP request ids are connection-scoped; two DSH processes both start at 0.
    const requestId = `${active.sessionId}:${String(request.id)}`;
    if (this.pendingApprovals.has(requestId)) {
      return Promise.resolve(cancelledPermissionOutcome());
    }
    const toolCall = asRecord(params?.toolCall);
    const summary =
      asString(toolCall?.title) ?? asString(toolCall?.toolCallId) ?? 'Tool permission request';
    const approval: ApprovalRequest = {
      requestId,
      executionId: active.executionId,
      summary,
      options,
    };

    return new Promise<unknown>((resolve) => {
      this.pendingApprovals.set(requestId, {
        resolve,
        sessionId: active.sessionId,
        executionId: active.executionId,
        options,
      });
      this.emit({ type: 'execution/approval-requested', executionId: active.executionId, request: approval });
    });
  }

  private handleChildError(error: Error): void {
    if (!this.started) {
      return;
    }
    this.started = false;
    const reason = `DSH ACP process error: ${error.message}`;
    for (const active of this.prompts.activeEntries()) {
      this.emit({
        type: 'execution/unknown',
        executionId: active.executionId,
        reason,
      });
    }
    this.prompts.clearActive();
    this.prompts.abortAll('unknown', reason);
    this.closing.clear();
    this.cwdBySession.clear();
    for (const pending of this.pendingApprovals.values()) {
      pending.resolve(cancelledPermissionOutcome());
    }
    this.pendingApprovals.clear();
    this.client?.close();
    if (!this.stopping) {
      this.emit({ type: 'adapter/error', message: `DSH ACP process error: ${error.message}` });
    }
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    const wasStarted = this.started;
    this.started = false;
    const reason = `DSH ACP process exited (code=${String(code)}, signal=${String(signal)})`;
    for (const active of this.prompts.activeEntries()) {
      this.emit({
        type: 'execution/unknown',
        executionId: active.executionId,
        reason,
      });
    }
    this.prompts.clearActive();
    this.prompts.abortAll('unknown', reason);
    this.closing.clear();
    this.cwdBySession.clear();
    for (const pending of this.pendingApprovals.values()) {
      pending.resolve(cancelledPermissionOutcome());
    }
    this.pendingApprovals.clear();
    if (wasStarted && !this.stopping) {
      this.emit({
        type: 'adapter/error',
        message: `DSH ACP process exited unexpectedly (code=${String(code)}, signal=${String(signal)})`,
      });
    }
  }

  private cancelPendingApprovals(sessionId: string): void {
    for (const [requestId, pending] of this.pendingApprovals) {
      if (pending.sessionId === sessionId) {
        this.pendingApprovals.delete(requestId);
        pending.resolve(cancelledPermissionOutcome());
      }
    }
  }

  private requireClient(): AcpRpcClient {
    if (this.client === undefined || !this.started) {
      throw new Error('DSH ACP adapter is not started');
    }
    return this.client;
  }

  private writeTitleSidecar(path: string, title: string): void {
    try {
      mkdirSync(this.sidecarDir as string, { recursive: true });
      writeFileSync(path, JSON.stringify({ title, createdAt: Date.now() }), 'utf8');
    } catch {
      // A missing writable home must not block session creation; the plugin
      // simply finds no sidecar and leaves the title to WAX.
    }
  }

  private emit(event: HarnessEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Observer failures must not break the adapter.
      }
    }
  }
}

export function mapStopReason(value: unknown): StopReason {
  switch (value) {
    case 'end_turn':
    case 'max_tokens':
    case 'max_turn_requests':
    case 'refusal':
    case 'cancelled':
      return value;
    default:
      return 'unknown';
  }
}

/** Exactly one terminal event for one ACP prompt result. */
function terminalEventForResult(executionId: string, result: unknown): HarnessEvent {
  const stopReason = mapStopReason(asRecord(result)?.stopReason);
  switch (stopReason) {
    case 'end_turn':
      return { type: 'execution/completed', executionId, stopReason };
    case 'cancelled':
      return { type: 'execution/cancelled', executionId };
    case 'max_tokens':
    case 'max_turn_requests':
    case 'refusal':
      return {
        type: 'execution/failed',
        executionId,
        error: `Prompt ended with stop reason: ${stopReason}`,
      };
    default:
      return {
        type: 'execution/unknown',
        executionId,
        reason: 'ACP returned an unknown stopReason',
      };
  }
}

/** A definite RPC failure is `failed`; a lost/unknown outcome is `unknown`. */
function failureEventForError(executionId: string, error: unknown): HarnessEvent {
  if (error instanceof AcpRpcError) {
    return { type: 'execution/failed', executionId, error: error.message };
  }
  return {
    type: 'execution/unknown',
    executionId,
    reason: error instanceof Error ? error.message : String(error),
  };
}

export function mapApprovalOptions(value: unknown): ApprovalOption[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const options: ApprovalOption[] = [];
  for (const raw of value) {
    const record = asRecord(raw);
    const id = asString(record?.optionId);
    const label = asString(record?.name);
    const kind = asString(record?.kind);
    if (id === undefined || label === undefined || !isApprovalOptionKind(kind)) {
      continue;
    }
    options.push({ id, label, kind });
  }
  return options;
}

function isApprovalOptionKind(value: string | undefined): value is ApprovalOptionKind {
  return (
    value === 'allow_once' ||
    value === 'reject_once' ||
    value === 'allow_always' ||
    value === 'reject_always'
  );
}

function cancelledPermissionOutcome(): unknown {
  return { outcome: { outcome: 'cancelled' } };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}
