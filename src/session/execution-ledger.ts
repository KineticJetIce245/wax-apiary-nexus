import { randomUUID } from 'node:crypto';

import type { Attachment } from '../shared/content.js';
import type { ExecutionState, StopReason } from '../adapters/harness.js';

/**
 * Why the Workspace moved a running execution to `cancelled`. It is recorded
 * only when the Workspace itself initiated the stop; an unattributed native
 * cancel or an approval decision leaves it undefined. It never changes the
 * execution state and is only exposed once the state is `cancelled`.
 */
export type ExecutionCancelReason =
  | 'approval-timeout'
  | 'explicit-cancel'
  | 'replace'
  | 'close';

export interface MutableExecution {
  readonly id: string;
  readonly conversationId: string;
  state: ExecutionState;
  output: string;
  readonly attachments: Attachment[];
  /** False while a queue-capable adapter still holds this prompt unsent. */
  started: boolean;
  stopReason?: StopReason;
  error?: string;
  cancelReason?: ExecutionCancelReason;
}

/**
 * In-memory execution bookkeeping for one Workspace.
 *
 * A conversation has one active execution and, for a queue-capable adapter, a
 * FIFO of admitted executions that have not reached the native side yet. The
 * ledger owns those associations only; event emission, approvals and native
 * cancellation stay in the Workspace.
 */
export class ExecutionLedger {
  private readonly executions = new Map<string, MutableExecution>();
  private readonly activeByConversation = new Map<string, string>();
  private readonly pendingByConversation = new Map<string, Set<string>>();

  create(conversationId: string, queueing: boolean): MutableExecution {
    const execution: MutableExecution = {
      id: randomUUID(),
      conversationId,
      state: 'running',
      output: '',
      attachments: [],
      started: !queueing,
    };
    this.executions.set(execution.id, execution);
    if (queueing) {
      const pending = this.pendingByConversation.get(conversationId);
      if (pending === undefined) {
        this.pendingByConversation.set(conversationId, new Set([execution.id]));
      } else {
        pending.add(execution.id);
      }
    } else {
      this.activeByConversation.set(conversationId, execution.id);
    }
    return execution;
  }

  get(executionId: string): MutableExecution | undefined {
    return this.executions.get(executionId);
  }

  all(): Iterable<MutableExecution> {
    return this.executions.values();
  }

  running(executionId: string): MutableExecution | undefined {
    const execution = this.executions.get(executionId);
    return execution?.state === 'running' ? execution : undefined;
  }

  activeId(conversationId: string): string | undefined {
    return this.activeByConversation.get(conversationId);
  }

  pendingIds(conversationId: string): readonly string[] {
    return [...(this.pendingByConversation.get(conversationId) ?? [])];
  }

  /** Newest admitted execution, the legacy conversation-scoped cancel target. */
  isBusy(conversationId: string): boolean {
    if (this.activeByConversation.has(conversationId)) {
      return true;
    }
    const pending = this.pendingByConversation.get(conversationId);
    return pending !== undefined && pending.size > 0;
  }

  /** Promote a queued execution when the adapter actually starts sending it. */
  markStarted(execution: MutableExecution): void {
    execution.started = true;
    const pending = this.pendingByConversation.get(execution.conversationId);
    if (pending !== undefined) {
      pending.delete(execution.id);
      if (pending.size === 0) {
        this.pendingByConversation.delete(execution.conversationId);
      }
    }
    if (!this.activeByConversation.has(execution.conversationId)) {
      this.activeByConversation.set(execution.conversationId, execution.id);
    }
  }

  /** Forget every active/pending association this execution still holds. */
  dissociate(execution: MutableExecution): void {
    const pending = this.pendingByConversation.get(execution.conversationId);
    if (pending !== undefined && pending.delete(execution.id) && pending.size === 0) {
      this.pendingByConversation.delete(execution.conversationId);
    }
    if (this.activeByConversation.get(execution.conversationId) === execution.id) {
      this.activeByConversation.delete(execution.conversationId);
    }
  }

  /** Drop every association for one closed conversation. */
  forget(conversationId: string): void {
    this.activeByConversation.delete(conversationId);
    this.pendingByConversation.delete(conversationId);
  }
}
