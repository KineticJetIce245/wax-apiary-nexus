import type { ApprovalDecisionKind, ApprovalRequest } from './adapters/harness.js';
import {
  renderPrompt,
  type ExecutionContext,
  type ForagerNode,
  type GuardDecision,
  type GuardRequest,
  type NodeExecutor,
  type Value,
} from './runtime/index.js';
import type { Conversation, Execution, Workspace, WorkspaceEvent } from './workspace.js';

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
 * retried or rewritten into a completed result.
 */
export class ForagerExecutionError extends Error {
  constructor(
    readonly nodeId: string,
    readonly state: 'failed' | 'cancelled' | 'unknown',
    detail: string,
    options?: { readonly cause?: unknown },
  ) {
    super(`forager '${nodeId}' ended as ${state}${detail === '' ? '' : `: ${detail}`}`, options);
    this.name = 'ForagerExecutionError';
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
    const prompt = renderPrompt(node.config.prompt, input);

    this.activeContext = context;
    let submitted: Execution;
    try {
      submitted = await this.workspace.submit(this.conversation.id, prompt);
    } catch (error) {
      this.activeContext = undefined;
      throw new ForagerExecutionError(node.id, 'failed', messageOf(error), { cause: error });
    }

    let settled: Execution;
    try {
      settled = await this.waitForTerminal(submitted.id);
    } finally {
      this.activeContext = undefined;
    }
    if (settled.state === 'completed') {
      const output: Value = { kind: 'text', text: settled.output };
      this.lastProduced = output;
      return output;
    }
    if (settled.state === 'running') {
      throw new ForagerExecutionError(node.id, 'unknown', 'execution did not settle');
    }
    throw new ForagerExecutionError(node.id, settled.state, settled.error ?? '');
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
    if (event.type === 'execution/state') {
      const execution = this.workspace.getExecution(event.executionId);
      if (execution === undefined || execution.state === 'running') {
        return;
      }
      this.terminals.set(execution.id, execution);
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

  private async settleApproval(executionId: string, request: ApprovalRequest): Promise<void> {
    const guard: GuardRequest = {
      requestId: request.requestId,
      executionId,
      summary: request.summary,
      options: request.options.map((option) => option.kind),
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
