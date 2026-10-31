import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Project } from '../../kernel.js';
import { assertProjectDirectory } from '../../project-directory.js';
import type {
  ApprovalDecision,
  ApprovalOption,
  ApprovalRequest,
  HarnessAdapter,
  HarnessCapabilities,
  HarnessEvent,
  StopReason,
} from '../harness.js';
import { SubmitOutcomeUnknownError } from '../harness.js';
import type { CodexLaunch } from '../../connection.js';
import {
  CodexRpcClient,
  CodexRpcError,
  type RpcNotification,
  type RpcServerRequest,
} from './rpc-client.js';

const DEFAULT_INITIALIZE_TIMEOUT_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_CLOSE_TERMINAL_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 5_000;
const TOOL_TITLE_LIMIT = 200;

export interface CodexAppServerAdapterOptions {
  readonly launch: CodexLaunch;
  readonly initializeTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly closeTerminalTimeoutMs?: number;
  readonly stopTimeoutMs?: number;
}

interface ActiveExecution {
  readonly executionId: string;
  turnId?: string;
}

interface ThreadState {
  readonly cwd: string;
  active: ActiveExecution | undefined;
}

interface PendingApproval {
  readonly resolve: (result: unknown) => void;
  readonly threadId: string;
  readonly executionId: string;
}

const APPROVAL_OPTIONS: readonly ApprovalOption[] = [
  { id: 'accept', kind: 'allow_once', label: 'Allow once' },
  { id: 'decline', kind: 'reject_once', label: 'Reject' },
];

/**
 * Codex adapter over `codex app-server` stdio (JSON-RPC without the `jsonrpc`
 * field). Native semantics preserved here: one turn per submission, approvals
 * relayed as server requests, cancellation through `turn/interrupt`, and the
 * native thread id kept as the conversation identity.
 */
export class CodexAppServerAdapter implements HarnessAdapter {
  readonly capabilities: HarnessCapabilities = {
    approval: 'interactive',
    cancel: true,
    streaming: true,
    // thread/resume exists upstream, but this adapter does not implement or
    // test a resume operation, so it must not advertise one.
    resume: false,
  };

  private readonly launch: CodexLaunch;
  private readonly initializeTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly closeTerminalTimeoutMs: number;
  private readonly stopTimeoutMs: number;
  private readonly listeners = new Set<(event: HarnessEvent) => void>();
  private readonly threads = new Map<string, ThreadState>();
  private readonly closing = new Set<string>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly deltaItems = new Set<string>();
  private readonly stderrLines: string[] = [];
  private child: ChildProcessWithoutNullStreams | undefined;
  private client: CodexRpcClient | undefined;
  private started = false;
  private stopping = false;

  constructor(options: CodexAppServerAdapterOptions) {
    this.launch = options.launch;
    this.initializeTimeoutMs = options.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.closeTerminalTimeoutMs = options.closeTerminalTimeoutMs ?? DEFAULT_CLOSE_TERMINAL_TIMEOUT_MS;
    this.stopTimeoutMs = options.stopTimeoutMs ?? STOP_TIMEOUT_MS;
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

    const child = spawn(this.launch.file, [...this.launch.args], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
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

    this.client = new CodexRpcClient(child);
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

    this.client.onNotification((notification) => this.handleNotification(notification));
    this.client.onRequest((request) => this.handleServerRequest(request));
    this.client.onError((error) => this.emit({ type: 'adapter/error', message: error.message }));
    this.client.onExit((code, signal) => this.handleExit(code, signal));

    try {
      await Promise.race([
        this.client.request(
          'initialize',
          {
            clientInfo: { name: 'unified-workspace', title: 'Unified Workspace', version: '0.0.0' },
          },
          this.initializeTimeoutMs,
        ),
        spawnFailure,
      ]);
      this.client.notify('initialized', {});
      const account = asRecord(
        await this.client.request('account/read', { refreshToken: false }, this.initializeTimeoutMs),
      );
      if (account?.requiresOpenaiAuth === true && (account.account === null || account.account === undefined)) {
        throw new Error(
          'Codex is not signed in. Sign in with the Codex app or run "codex login", then retry.',
        );
      }
      this.started = true;
    } catch (error) {
      this.started = false;
      this.client.close();
      child.kill();
      this.client = undefined;
      this.child = undefined;
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
      await Promise.race([exited, delay(this.stopTimeoutMs)]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
      }
    }
    for (const pending of this.pendingApprovals.values()) {
      pending.resolve({ decision: 'cancel' });
    }
    this.pendingApprovals.clear();
    this.threads.clear();
    this.closing.clear();
    this.deltaItems.clear();
    this.client?.close();
    this.client = undefined;
    this.child = undefined;
    this.started = false;
    this.stopping = false;
  }

  async createConversation(project: Project): Promise<string> {
    assertProjectDirectory(project.directory);
    const client = this.requireClient();
    const result = asRecord(
      await client.request('thread/start', { cwd: project.directory }, this.requestTimeoutMs),
    );
    const threadId = asString(asRecord(result?.thread)?.id);
    if (threadId === undefined) {
      throw new Error('Codex app-server thread/start did not return a thread id');
    }
    this.threads.set(threadId, { cwd: project.directory, active: undefined });
    return threadId;
  }

  async submit(nativeId: string, executionId: string, text: string): Promise<void> {
    const client = this.requireClient();
    if (this.closing.has(nativeId)) {
      throw new Error(`Codex thread is closing and cannot accept new work: ${nativeId}`);
    }
    const thread = this.threads.get(nativeId);
    if (thread === undefined) {
      throw new Error(`Unknown Codex thread: ${nativeId}`);
    }
    assertProjectDirectory(thread.cwd);
    if (thread.active !== undefined) {
      throw new Error(`Codex thread already has an active execution: ${nativeId}`);
    }
    thread.active = { executionId };
    this.emit({ type: 'execution/started', executionId });

    try {
      const result = asRecord(
        await client.request(
          'turn/start',
          { threadId: nativeId, input: [{ type: 'text', text }] },
          this.requestTimeoutMs,
        ),
      );
      const turnId = asString(asRecord(result?.turn)?.id);
      const active = this.threads.get(nativeId)?.active;
      if (active !== undefined && active.executionId === executionId && turnId !== undefined) {
        active.turnId = turnId;
      }
    } catch (error) {
      const current = this.threads.get(nativeId);
      const active = current?.active;
      if (current === undefined || active === undefined || active.executionId !== executionId) {
        // Connection loss already settled this execution and dropped the thread.
        throw error;
      }
      if (active.turnId !== undefined) {
        // turn/started was observed, so the native side accepted the turn even
        // though the turn/start response was lost. Keep waiting for the
        // terminal event instead of reporting a definite failure.
        return;
      }
      if (error instanceof CodexRpcError) {
        current.active = undefined;
        throw error;
      }
      // The native side may or may not have accepted the turn. Keep the active
      // association so another submit cannot overlap it; the Workspace settles
      // this execution as unknown and keeps the conversation busy until a
      // terminal event arrives.
      throw new SubmitOutcomeUnknownError(
        `Codex turn/start outcome is unknown: ${messageOf(error)}`,
      );
    }
  }

  async cancel(nativeId: string): Promise<void> {
    const client = this.requireClient();
    const thread = this.threads.get(nativeId);
    const active = thread?.active;
    if (thread === undefined || active === undefined) {
      return;
    }
    await this.interrupt(client, nativeId, active);
  }

  async respondToApproval(decision: ApprovalDecision): Promise<void> {
    const pending = this.pendingApprovals.get(decision.requestId);
    if (pending === undefined) {
      throw new Error(`Unknown Codex approval request: ${decision.requestId}`);
    }
    const mapped = mapApprovalDecision(decision.kind);
    this.pendingApprovals.delete(decision.requestId);
    pending.resolve({ decision: mapped });
  }

  async closeConversation(nativeId: string): Promise<void> {
    const client = this.requireClient();
    const thread = this.threads.get(nativeId);
    if (thread === undefined) {
      throw new Error(`Unknown Codex thread: ${nativeId}`);
    }
    this.closing.add(nativeId);
    this.cancelPendingApprovals(nativeId);

    const active = thread.active;
    if (active !== undefined) {
      if (active.turnId === undefined) {
        // Without a turn id the native turn cannot be interrupted, and
        // unsubscribing would release a turn that may still be running.
        throw new Error(
          `Cannot close Codex thread ${nativeId}: the active turn has no known turn id; ` +
            'wait for a terminal event or stop the adapter.',
        );
      }
      void this.interrupt(client, nativeId, active).catch(() => undefined);
      await this.waitForTurnTerminal(nativeId, active.turnId);
    }
    await client.request('thread/unsubscribe', { threadId: nativeId }, this.requestTimeoutMs);

    this.closing.delete(nativeId);
    this.threads.delete(nativeId);
  }

  /**
   * A turn/interrupt acknowledgement only proves the request was received.
   * Release the thread only after the native terminal notification arrives.
   */
  private async waitForTurnTerminal(nativeId: string, turnId: string): Promise<void> {
    const deadline = Date.now() + this.closeTerminalTimeoutMs;
    while (Date.now() < deadline) {
      const thread = this.threads.get(nativeId);
      if (thread === undefined || thread.active === undefined) {
        return;
      }
      await delay(50);
    }
    throw new Error(
      `Codex turn ${turnId} did not reach a terminal event within ${this.closeTerminalTimeoutMs}ms; ` +
        `thread ${nativeId} remains closing`,
    );
  }

  /** Recent stderr, for local diagnosis; callers must not assume it is secret-free. */
  recentStderr(): readonly string[] {
    return [...this.stderrLines];
  }

  private async interrupt(
    client: CodexRpcClient,
    nativeId: string,
    active: ActiveExecution,
  ): Promise<void> {
    if (active.turnId === undefined) {
      return;
    }
    await client.request(
      'turn/interrupt',
      { threadId: nativeId, turnId: active.turnId },
      this.requestTimeoutMs,
    );
  }

  private handleNotification(notification: RpcNotification): void {
    const params = asRecord(notification.params);
    if (params === undefined) {
      return;
    }
    const threadId = asString(params.threadId);
    const thread = threadId === undefined ? undefined : this.threads.get(threadId);
    const active = thread?.active;
    if (thread === undefined || threadId === undefined || active === undefined) {
      return;
    }
    const turnId = this.turnIdentity(notification.method, params);
    if (turnId === undefined) {
      return;
    }
    if (active.turnId === undefined) {
      // Only turn/started may establish the identity; a terminal or an item
      // from an older turn must not be adopted by a new execution.
      if (notification.method !== 'turn/started') {
        return;
      }
      active.turnId = turnId;
    } else if (active.turnId !== turnId) {
      return;
    }

    switch (notification.method) {
      case 'turn/started': {
        const turnId = asString(asRecord(params.turn)?.id);
        if (turnId !== undefined) {
          active.turnId = turnId;
        }
        return;
      }
      case 'item/agentMessage/delta': {
        const itemId = asString(params.itemId);
        const delta = asString(params.delta);
        if (itemId === undefined || delta === undefined) {
          return;
        }
        this.deltaItems.add(itemId);
        this.emit({ type: 'execution/output', executionId: active.executionId, channel: 'assistant', text: delta });
        return;
      }
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta': {
        const itemId = asString(params.itemId);
        const delta = asString(params.delta);
        if (itemId === undefined || delta === undefined) {
          return;
        }
        this.deltaItems.add(itemId);
        this.emit({ type: 'execution/output', executionId: active.executionId, channel: 'thought', text: delta });
        return;
      }
      case 'item/started':
      case 'item/completed': {
        this.handleItem(notification.method, params, active);
        return;
      }
      case 'turn/completed': {
        this.settleTurn(params, thread, active);
        return;
      }
      case 'error': {
        if (params.willRetry === true) {
          return;
        }
        const message = asString(asRecord(params.error)?.message) ?? 'Codex app-server reported an error';
        this.emit({ type: 'adapter/error', message });
        return;
      }
      default:
        return;
    }
  }

  /**
   * Turn identity lives in `params.turnId` for item/approval notifications and
   * in `params.turn.id` for turn/started and turn/completed.
   */
  private turnIdentity(method: string, params: Record<string, unknown>): string | undefined {
    const direct = asString(params.turnId);
    if (direct !== undefined) {
      return direct;
    }
    if (method === 'turn/started' || method === 'turn/completed') {
      return asString(asRecord(params.turn)?.id);
    }
    return undefined;
  }

  private handleItem(
    method: 'item/started' | 'item/completed',
    params: Record<string, unknown>,
    active: ActiveExecution,
  ): void {
    const item = asRecord(params.item);
    if (item === undefined) {
      return;
    }
    const type = asString(item.type);
    const itemId = asString(item.id);
    if (type === undefined || itemId === undefined) {
      return;
    }
    const started = method === 'item/started';

    if (type === 'agentMessage') {
      if (started) {
        return;
      }
      const text = asString(item.text) ?? '';
      if (!this.deltaItems.has(itemId) && text !== '') {
        this.emit({ type: 'execution/output', executionId: active.executionId, channel: 'assistant', text });
      }
      this.deltaItems.delete(itemId);
      return;
    }
    if (type === 'reasoning') {
      if (started) {
        return;
      }
      const hadDeltas = this.deltaItems.has(itemId);
      this.deltaItems.delete(itemId);
      if (hadDeltas) {
        return;
      }
      const summary = Array.isArray(item.summary) ? item.summary.filter(isString).join('\n') : '';
      if (summary !== '') {
        this.emit({ type: 'execution/output', executionId: active.executionId, channel: 'thought', text: summary });
      }
      return;
    }

    const title = toolTitle(type, item);
    if (title === undefined) {
      return;
    }
    this.emit({
      type: 'execution/tool',
      executionId: active.executionId,
      toolCallId: itemId,
      title,
      status: asString(item.status) ?? (started ? 'inProgress' : 'unknown'),
    });
  }

  private settleTurn(
    params: Record<string, unknown>,
    thread: ThreadState,
    active: ActiveExecution,
  ): void {
    const turn = asRecord(params.turn);
    const status = asString(turn?.status);
    const executionId = active.executionId;
    thread.active = undefined;
    const stopReason: StopReason = 'end_turn';

    switch (status) {
      case 'completed': {
        this.emit({ type: 'execution/completed', executionId, stopReason });
        return;
      }
      case 'interrupted': {
        this.emit({ type: 'execution/cancelled', executionId });
        return;
      }
      case 'failed': {
        const error = asString(asRecord(turn?.error)?.message) ?? 'Codex turn failed';
        this.emit({ type: 'execution/failed', executionId, error });
        return;
      }
      default: {
        this.emit({
          type: 'execution/unknown',
          executionId,
          reason: `Codex turn completed with unknown status: ${String(status)}`,
        });
      }
    }
  }

  private handleServerRequest(request: RpcServerRequest): Promise<unknown> {
    const method = request.method;
    if (method !== 'item/commandExecution/requestApproval' && method !== 'item/fileChange/requestApproval') {
      return Promise.reject(new Error(`Unsupported Codex app-server request: ${method}`));
    }
    const params = asRecord(request.params);
    const threadId = asString(params?.threadId);
    const turnId = asString(params?.turnId);
    const thread = threadId === undefined ? undefined : this.threads.get(threadId);
    const active = thread?.active;
    if (threadId === undefined || turnId === undefined || active === undefined || active.turnId !== turnId) {
      return Promise.resolve({ decision: 'decline' });
    }
    const requestId = String(request.id);
    if (this.pendingApprovals.has(requestId)) {
      return Promise.resolve({ decision: 'decline' });
    }
    const approval: ApprovalRequest = {
      requestId,
      executionId: active.executionId,
      summary: approvalSummary(method, params),
      options: APPROVAL_OPTIONS,
    };

    return new Promise<unknown>((resolve) => {
      this.pendingApprovals.set(requestId, {
        resolve,
        threadId,
        executionId: active.executionId,
      });
      this.emit({ type: 'execution/approval-requested', executionId: active.executionId, request: approval });
    });
  }

  private cancelPendingApprovals(threadId: string): void {
    for (const [requestId, pending] of this.pendingApprovals) {
      if (pending.threadId === threadId) {
        this.pendingApprovals.delete(requestId);
        pending.resolve({ decision: 'cancel' });
      }
    }
  }

  private handleChildError(error: Error): void {
    if (!this.started) {
      return;
    }
    this.failActiveExecutions(`Codex app-server process error: ${error.message}`);
    if (!this.stopping) {
      this.emit({ type: 'adapter/error', message: `Codex app-server process error: ${error.message}` });
    }
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    const wasStarted = this.started;
    this.started = false;
    this.failActiveExecutions(
      `Codex app-server process exited (code=${String(code)}, signal=${String(signal)})`,
    );
    if (wasStarted && !this.stopping) {
      this.emit({
        type: 'adapter/error',
        message: `Codex app-server process exited unexpectedly (code=${String(code)}, signal=${String(signal)})`,
      });
    }
  }

  private failActiveExecutions(reason: string): void {
    for (const thread of this.threads.values()) {
      const active = thread.active;
      if (active !== undefined) {
        thread.active = undefined;
        this.emit({ type: 'execution/unknown', executionId: active.executionId, reason });
      }
    }
    this.closing.clear();
    for (const pending of this.pendingApprovals.values()) {
      pending.resolve({ decision: 'cancel' });
    }
    this.pendingApprovals.clear();
    this.deltaItems.clear();
  }

  private requireClient(): CodexRpcClient {
    if (this.client === undefined || !this.started) {
      throw new Error('Codex app-server adapter is not started');
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

export function mapApprovalDecision(kind: ApprovalDecision['kind']): string {
  switch (kind) {
    case 'allow_once':
      return 'accept';
    case 'reject_once':
      return 'decline';
    case 'cancelled':
      return 'cancel';
  }
}

function approvalSummary(method: string, params: Record<string, unknown> | undefined): string {
  if (params === undefined) {
    return method === 'item/fileChange/requestApproval' ? 'Codex wants to apply file changes' : 'Codex wants to run a command';
  }
  const reason = asString(params.reason);
  if (method === 'item/fileChange/requestApproval') {
    return reason === undefined ? 'Codex wants to apply file changes' : `Codex wants to apply file changes: ${reason}`;
  }
  const command = asString(params.command);
  const base =
    command === undefined
      ? 'Codex wants to run a command'
      : `Codex wants to run: ${truncate(command, TOOL_TITLE_LIMIT)}`;
  return reason === undefined ? base : `${base} (${reason})`;
}

function toolTitle(type: string, item: Record<string, unknown>): string | undefined {
  switch (type) {
    case 'commandExecution': {
      const command = asString(item.command);
      return command === undefined ? 'command' : `run: ${truncate(command, TOOL_TITLE_LIMIT)}`;
    }
    case 'fileChange': {
      const changes = Array.isArray(item.changes) ? item.changes.length : 0;
      return `edit files (${String(changes)})`;
    }
    case 'mcpToolCall': {
      const server = asString(item.server);
      const tool = asString(item.tool);
      return server === undefined || tool === undefined ? 'MCP tool call' : `${server}/${tool}`;
    }
    default:
      return undefined;
  }
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}...`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}
