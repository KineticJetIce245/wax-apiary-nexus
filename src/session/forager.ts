import { extname } from 'node:path';

import type { ApprovalDecisionKind, ApprovalRequest } from '../adapters/harness.js';
import type { AttachmentDraft } from '../shared/content.js';
import {
  isAttachment,
  renderPrompt,
  type ExecutionContext,
  type ForagerNode,
  type GuardDecision,
  type GuardRequest,
  type NodeExecutor,
  type Value,
} from '../runtime/index.js';
import { ConversationBusyError, SessionBusyError } from './session-errors.js';
import type {
  Conversation,
  Execution,
  ExecutionCancelReason,
  Workspace,
  WorkspaceEvent,
} from './workspace.js';

/** Interactive approval decision supplied by the caller (CLI in Stage 2A). */
export type ApprovalHandler = (request: ApprovalRequest) => Promise<ApprovalDecisionKind>;

export interface WorkspaceForagerOptions {
  readonly workspace: Workspace;
  readonly conversation: Conversation;
  /**
   * Called for every approval request. Without a handler the bridge rejects
   * (or cancels), so an approval is never granted automatically.
   */
  readonly onApproval?: ApprovalHandler;
}

/**
 * Raised when a forager execution does not complete. `failed`, `cancelled` and
 * `unknown` are terminal states of the native execution; none of them is
 * retried or rewritten into a completed result. `cancelReason` carries the
 * Workspace's own provenance for a cancelled stop, when it has one.
 */
export class ForagerExecutionError extends Error {
  readonly cancelReason: ExecutionCancelReason | undefined;

  constructor(
    readonly nodeId: string,
    readonly state: 'failed' | 'cancelled' | 'unknown',
    detail: string,
    options?: { readonly cause?: unknown; readonly cancelReason?: ExecutionCancelReason },
  ) {
    super(`forager '${nodeId}' ended as ${state}${detail === '' ? '' : `: ${detail}`}`, options);
    this.name = 'ForagerExecutionError';
    this.cancelReason = options?.cancelReason;
  }
}

/**
 * Bridges one Workspace conversation into the pure runtime as a NodeExecutor.
 *
 * The runtime stays unaware of harnesses: this class renders `{{input}}`,
 * submits the prompt, waits for the terminal execution state, and maps
 * `completed` to a text Value. Approval requests are delegated to the caller;
 * a request without a handler is rejected, never allowed.
 */
export class WorkspaceForagerExecutor implements NodeExecutor {
  private readonly workspace: Workspace;
  private readonly conversation: Conversation;
  private readonly onApproval: ApprovalHandler | undefined;
  private readonly terminals = new Map<string, Execution>();
  private readonly waiters = new Map<string, (execution: Execution) => void>();
  /**
   * Executions submitted by this executor. The Workspace is shared by every
   * forager bound to it, so the event subscription must ignore executions that
   * belong to another forager even when they share one conversation.
   */
  private readonly ownedExecutionIds = new Set<string>();
  /** How many `submit()` calls are awaited, the window in which the id is unknown. */
  private pendingSubmissions = 0;
  private readonly unsubscribe: () => void;
  private lastProduced: Value | undefined;
  private activeContext: ExecutionContext | undefined;
  private disposed = false;

  constructor(options: WorkspaceForagerOptions) {
    this.workspace = options.workspace;
    this.conversation = options.conversation;
    this.onApproval = options.onApproval;
    this.unsubscribe = this.workspace.onEvent((event) => {
      this.handleEvent(event);
    });
  }

  /** The most recent completed text Value, for one-shot CLI reporting. */
  get lastOutput(): Value | undefined {
    return this.lastProduced;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.unsubscribe();
    this.waiters.clear();
  }

  async execute(node: ForagerNode, input: Value, context?: ExecutionContext): Promise<Value> {
    const { prompt, attachments } = renderForagerInput(node, input);
    this.activeContext = context;
    const submitted = await this.submitPrompt(node, prompt, attachments);
    let settled: Execution;
    try {
      settled = await this.waitForTerminal(submitted.id);
    } finally {
      this.activeContext = undefined;
    }
    if (settled.state === 'completed') {
      const output = completedValue(settled);
      this.lastProduced = output;
      return output;
    }
    if (settled.state === 'running') {
      throw new ForagerExecutionError(node.id, 'unknown', 'execution did not settle');
    }
    throw new ForagerExecutionError(node.id, settled.state, settled.error ?? '', {
      ...(settled.cancelReason === undefined ? {} : { cancelReason: settled.cancelReason }),
    });
  }

  private async submitPrompt(
    node: ForagerNode,
    prompt: string,
    attachments: readonly AttachmentDraft[],
  ): Promise<Execution> {
    this.pendingSubmissions += 1;
    try {
      const submitted = await this.workspace.submit(this.conversation.id, prompt, attachments);
      // A native adapter may emit the terminal state before `submit()`
      // resolves. That handler already released the id; re-adding it here would
      // let a late approval for the settled execution be adopted.
      if (!this.terminals.has(submitted.id)) {
        this.ownedExecutionIds.add(submitted.id);
      }
      return submitted;
    } catch (error) {
      this.activeContext = undefined;
      if (error instanceof ConversationBusyError) {
        // Another caller holds the same native conversation: a session-level
        // busy outcome, not a failed execution.
        throw new SessionBusyError(this.conversation.id);
      }
      throw new ForagerExecutionError(node.id, 'failed', messageOf(error), { cause: error });
    } finally {
      this.pendingSubmissions -= 1;
    }
  }

  private waitForTerminal(executionId: string): Promise<Execution> {
    const recorded = this.terminals.get(executionId);
    if (recorded !== undefined) {
      return Promise.resolve(recorded);
    }
    const current = this.workspace.getExecution(executionId);
    if (current !== undefined && current.state !== 'running') {
      return Promise.resolve(current);
    }
    return new Promise<Execution>((resolve) => {
      this.waiters.set(executionId, resolve);
    });
  }

  private handleEvent(event: WorkspaceEvent): void {
    if (event.type === 'adapter/error') {
      // Not attributable to an execution; this executor ignores adapter errors.
      return;
    }
    const execution = this.workspace.getExecution(event.executionId);
    if (
      execution === undefined ||
      execution.conversationId !== this.conversation.id ||
      !this.ownsExecution(execution.id)
    ) {
      return;
    }

    if (event.type === 'execution/state') {
      if (execution.state === 'running') {
        return;
      }
      this.terminals.set(execution.id, execution);
      // Ownership ends with the terminal event. Keeping the id would let this
      // executor adopt an approval that arrives after the execution settled.
      this.ownedExecutionIds.delete(execution.id);
      const waiter = this.waiters.get(execution.id);
      if (waiter !== undefined) {
        this.waiters.delete(execution.id);
        waiter(execution);
      }
      return;
    }

    if (event.type === 'execution/approval-requested') {
      void this.settleApproval(event.executionId, event.request);
    }
  }

  /**
   * Whether `executionId` was submitted by this executor. A native adapter may
   * emit an approval before `submit()` resolves, so the id is not known then;
   * the Workspace marks the conversation busy before it awaits the adapter, so
   * at most one submission is in flight per executor and that execution is
   * adopted while the window is open.
   */
  private ownsExecution(executionId: string): boolean {
    if (this.terminals.has(executionId)) {
      // Settled executions keep their terminal record for `waitForTerminal`,
      // but they are no longer eligible for ownership.
      return false;
    }
    if (this.ownedExecutionIds.has(executionId)) {
      return true;
    }
    if (this.pendingSubmissions === 0) {
      return false;
    }
    this.ownedExecutionIds.add(executionId);
    return true;
  }

  private async settleApproval(executionId: string, request: ApprovalRequest): Promise<void> {
    const guard: GuardRequest = {
      requestId: request.requestId,
      executionId,
      summary: request.summary,
      options: request.options.map((option) => option.kind),
      sessionId: this.conversation.id,
    };
    const handler = this.onApproval;
    const decide =
      handler === undefined ? undefined : async (): Promise<GuardDecision> => handler(request);

    let decision: GuardDecision;
    try {
      // The runtime parks the approval as a Guard hover (persisted, bounded by
      // its timeout) and only then returns the decision to the harness. When
      // the bridge is driven without a runtime context (direct executor use),
      // the local handler still owns the decision.
      decision =
        this.activeContext === undefined
          ? handler === undefined
            ? defaultDecision(request)
            : await handler(request)
          : await this.activeContext.requestGuard(guard, decide);
    } catch {
      decision = defaultDecision(request);
    }

    try {
      await this.workspace.decideApproval(executionId, request.requestId, decision);
    } catch {
      // The execution may have settled or the request expired while the user
      // was deciding; the native side still owns the outcome.
    }
  }
}

function defaultDecision(request: ApprovalRequest): ApprovalDecisionKind {
  const offered = new Set(request.options.map((option) => option.kind));
  return offered.has('reject_once') ? 'reject_once' : 'cancelled';
}

/** Stable non-empty prompt for an attachment-only input. */
const ATTACHMENT_ONLY_PROMPT = 'See attached input.';

/** Small extension map; never sniff or read the file. */
const MEDIA_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.md': 'text/markdown',
};

/** Renders `{{input}}` and the adapter drafts; empty-only input gets a sentence. */
function renderForagerInput(
  node: ForagerNode,
  input: Value,
): { readonly prompt: string; readonly attachments: readonly AttachmentDraft[] } {
  const attachments = attachmentsOf(input);
  const rendered = renderPrompt(node.config.prompt, input);
  const prompt =
    rendered.trim() === '' && attachments.length > 0 ? ATTACHMENT_ONLY_PROMPT : rendered;
  return { prompt, attachments };
}

/** Maps a completed execution to the universal `message`/`attachments` Value. */
function completedValue(execution: Execution): Value {
  return {
    message: execution.output,
    ...(execution.attachments.length === 0
      ? {}
      : {
          attachments: execution.attachments.map((attachment) => ({
            path: attachment.path,
            ...(attachment.mimeType === '' ? {} : { mediaType: attachment.mimeType }),
          })),
        }),
  };
}

/**
 * Runtime attachments are local path references. Every valid `{ path,
 * mediaType? }` entry becomes an AttachmentDraft; image/file is inferred from
 * the media-type prefix (or the file extension), never from a `kind` tag.
 */
function attachmentsOf(value: Value): AttachmentDraft[] {
  const raw = value['attachments'];
  if (!Array.isArray(raw)) {
    return [];
  }
  const drafts: AttachmentDraft[] = [];
  for (const entry of raw) {
    if (!isAttachment(entry)) {
      continue;
    }
    const mimeType =
      entry.mediaType ?? MEDIA_TYPES[extname(entry.path).toLowerCase()] ?? 'application/octet-stream';
    drafts.push({
      kind: mimeType.startsWith('image/') ? 'image' : 'file',
      path: entry.path,
      mimeType,
    });
  }
  return drafts;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
