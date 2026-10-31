import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Project } from '../../kernel.js';
import type {
  ApprovalDecision,
  ApprovalOption,
  ApprovalOptionKind,
  ApprovalRequest,
  HarnessAdapter,
  HarnessCapabilities,
  HarnessEvent,
  StopReason,
} from '../harness.js';
import { AcpRpcClient, AcpRpcError } from './client.js';

const DEFAULT_INITIALIZE_TIMEOUT_MS = 30_000;
const DEFAULT_SESSION_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 5_000;

export interface DshAcpAdapterOptions {
  readonly dshRoot: string;
  readonly nodePath?: string;
  readonly initializeTimeoutMs?: number;
  /** Extra launcher flags, for example ['--patch', path]. */
  readonly dshArgs?: readonly string[];
  /** Extra environment for the harness process; never logged. */
  readonly env?: NodeJS.ProcessEnv;
}

interface ActiveExecution {
  readonly sessionId: string;
  readonly executionId: string;
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
  readonly capabilities: HarnessCapabilities = {
    approval: 'interactive',
    cancel: true,
    streaming: true,
    resume: true,
  };

  private readonly dshRoot: string;
  private readonly nodePath: string;
  private readonly initializeTimeoutMs: number;
  private readonly dshArgs: readonly string[];
  private readonly env: NodeJS.ProcessEnv;
  private readonly listeners = new Set<(event: HarnessEvent) => void>();
  private readonly active = new Map<string, ActiveExecution>();
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
    this.dshArgs = options.dshArgs ?? [];
    this.env = options.env ?? {};
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

    this.started = true;
    try {
      await this.client.request(
        'initialize',
        {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: { name: 'unified-workspace', version: '0.0.0' },
        },
        this.initializeTimeoutMs,
      );
    } catch (error) {
      this.started = false;
      this.client.close();
      child.kill();
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (child !== undefined) {
      const exited = new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
      });
      try {
        child.stdin.end();
      } catch {
        // The child may already be gone.
      }
      await Promise.race([exited, delay(STOP_TIMEOUT_MS)]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
      }
    }
    for (const pending of this.pendingApprovals.values()) {
      pending.resolve(cancelledPermissionOutcome());
    }
    this.pendingApprovals.clear();
    this.active.clear();
    this.client?.close();
    this.client = undefined;
    this.child = undefined;
    this.started = false;
    this.stopping = false;
  }

  async createConversation(project: Project): Promise<string> {
    const client = this.requireClient();
    const result = await client.request(
      'session/new',
      { cwd: project.directory, mcpServers: [] },
      DEFAULT_SESSION_TIMEOUT_MS,
    );
    const sessionId = asString(asRecord(result)?.sessionId);
    if (sessionId === undefined) {
      throw new Error('ACP session/new did not return a sessionId');
    }
    return sessionId;
  }

  async submit(nativeId: string, executionId: string, text: string): Promise<void> {
    const client = this.requireClient();
    if (this.active.has(nativeId)) {
      throw new Error(`ACP session already has an active execution: ${nativeId}`);
    }
    this.active.set(nativeId, { sessionId: nativeId, executionId });
    this.emit({ type: 'execution/started', executionId });

    void client
      .request('session/prompt', {
        sessionId: nativeId,
        prompt: [{ type: 'text', text }],
      })
      .then((result) => {
        if (this.active.get(nativeId)?.executionId !== executionId) {
          return;
        }
        this.active.delete(nativeId);
        const stopReason = mapStopReason(asRecord(result)?.stopReason);
        switch (stopReason) {
          case 'end_turn':
            this.emit({ type: 'execution/completed', executionId, stopReason });
            return;
          case 'cancelled':
            this.emit({ type: 'execution/cancelled', executionId });
            return;
          case 'max_tokens':
          case 'max_turn_requests':
          case 'refusal':
            this.emit({
              type: 'execution/failed',
              executionId,
              error: `Prompt ended with stop reason: ${stopReason}`,
            });
            return;
          case 'unknown':
            this.emit({
              type: 'execution/unknown',
              executionId,
              reason: 'ACP returned an unknown stopReason',
            });
            return;
        }
      })
      .catch((error: unknown) => {
        if (this.active.get(nativeId)?.executionId !== executionId) {
          return;
        }
        this.active.delete(nativeId);
        if (error instanceof AcpRpcError) {
          this.emit({ type: 'execution/failed', executionId, error: error.message });
          return;
        }
        this.emit({
          type: 'execution/unknown',
          executionId,
          reason: error instanceof Error ? error.message : String(error),
        });
      });
  }

  async cancel(nativeId: string): Promise<void> {
    const client = this.requireClient();
    this.cancelPendingApprovals(nativeId);
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
    this.cancelPendingApprovals(nativeId);
    const active = this.active.get(nativeId);
    try {
      await client.request('session/close', { sessionId: nativeId }, DEFAULT_SESSION_TIMEOUT_MS);
    } finally {
      if (active !== undefined && this.active.get(nativeId)?.executionId === active.executionId) {
        this.active.delete(nativeId);
        this.emit({ type: 'execution/cancelled', executionId: active.executionId });
      }
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
    const active = this.active.get(sessionId);
    if (active === undefined) {
      return;
    }
    const executionId = active.executionId;
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
    const active = sessionId === undefined ? undefined : this.active.get(sessionId);
    if (active === undefined) {
      return Promise.resolve(cancelledPermissionOutcome());
    }
    const options = mapApprovalOptions(params?.options);
    if (options.length === 0) {
      return Promise.resolve(cancelledPermissionOutcome());
    }
    const requestId = String(request.id);
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

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    const wasStarted = this.started;
    this.started = false;
    for (const active of this.active.values()) {
      this.emit({
        type: 'execution/unknown',
        executionId: active.executionId,
        reason: `DSH ACP process exited (code=${String(code)}, signal=${String(signal)})`,
      });
    }
    this.active.clear();
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
