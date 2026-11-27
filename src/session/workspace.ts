import { randomUUID } from 'node:crypto';
import { cloneAttachment, type Attachment, type AttachmentDraft } from '../shared/content.js';
import type { Project } from '../project/kernel.js';
import { assertProjectDirectory } from '../project/project-directory.js';
import type {
  ApprovalDecisionKind,
  ApprovalRequest,
  ConversationOptions,
  ExecutionState,
  HarnessAdapter,
  HarnessEvent,
  StopReason,
} from '../adapters/harness.js';
import { SubmitOutcomeUnknownError } from '../adapters/harness.js';
import { ConversationResumer } from './conversation-resumer.js';
import { ExecutionLedger, type MutableExecution } from './execution-ledger.js';
import type { ExecutionCancelReason } from './execution-ledger.js';
import {
  CancelNotSupportedError,
  ConversationBusyError,
  ConversationClosingError,
  ReplaceTimeoutError,
  ReplaceUnknownError,
  SubmitFailedError,
  UnknownApprovalError,
  UnknownConversationError,
  UnknownExecutionError,
  UnsupportedApprovalError,
} from './session-errors.js';

export type { ExecutionCancelReason } from './execution-ledger.js';

export {
  CancelNotSupportedError,
  ConversationBusyError,
  ConversationClosingError,
  ReplaceTimeoutError,
  ReplaceUnknownError,
  ResumeNotSupportedError,
  SubmitFailedError,
  UnknownApprovalError,
  UnknownConversationError,
  UnknownExecutionError,
  UnsupportedApprovalError,
} from './session-errors.js';

export interface Conversation {
  readonly id: string;
  readonly project: Project;
  readonly nativeId: string;
  /** WAX display alias; falls back to the native id when none was requested. */
  readonly displayName: string;
}

export interface Execution {
  readonly id: string;
  readonly conversationId: string;
  readonly state: ExecutionState;
  readonly output: string;
  readonly attachments: readonly Attachment[];
  readonly stopReason?: StopReason;
  readonly error?: string;
  readonly cancelReason?: ExecutionCancelReason;
}

export type WorkspaceEvent =
  | {
      readonly type: 'execution/output';
      readonly executionId: string;
      readonly channel: 'assistant' | 'thought';
      readonly text: string;
    }
  | {
      readonly type: 'execution/tool';
      readonly executionId: string;
      readonly toolCallId: string;
      readonly title: string;
      readonly status: string;
    }
  | {
      readonly type: 'execution/attachment';
      readonly executionId: string;
      readonly attachment: Attachment;
    }
  | {
      readonly type: 'execution/approval-requested';
      readonly executionId: string;
      readonly request: ApprovalRequest;
    }
  | {
      readonly type: 'execution/approval-decided';
      readonly executionId: string;
      readonly requestId: string;
      readonly kind: ApprovalDecisionKind;
    }
  | {
      readonly type: 'execution/state';
      readonly executionId: string;
      readonly state: ExecutionState;
      readonly stopReason?: StopReason;
      readonly error?: string;
    }
  | { readonly type: 'adapter/error'; readonly message: string };

export interface WorkspaceOptions {
  /** How long replace() waits for a cancelled execution to settle. */
  readonly replaceTimeoutMs?: number;
}

interface PendingApproval {
  readonly request: ApprovalRequest;
}

const DEFAULT_REPLACE_TIMEOUT_MS = 10_000;

export class Workspace {
  private readonly adapter: HarnessAdapter;
  private readonly replaceTimeoutMs: number;
  private readonly conversations = new Map<string, Conversation>();
  private readonly resumer: ConversationResumer;
  private readonly ledger = new ExecutionLedger();
  private readonly closingConversations = new Set<string>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly listeners = new Set<(event: WorkspaceEvent) => void>();
  private readonly unsubscribe: () => void;
  private stopped = false;

  constructor(adapter: HarnessAdapter, options: WorkspaceOptions = {}) {
    this.adapter = adapter;
    this.replaceTimeoutMs = options.replaceTimeoutMs ?? DEFAULT_REPLACE_TIMEOUT_MS;
    if (!Number.isFinite(this.replaceTimeoutMs) || this.replaceTimeoutMs <= 0) {
      throw new Error(`replaceTimeoutMs must be a positive number: ${String(options.replaceTimeoutMs)}`);
    }
    this.unsubscribe = adapter.onEvent((event) => this.handleAdapterEvent(event));
    this.resumer = new ConversationResumer(
      adapter,
      this.conversations,
      new Set(),
      () => this.assertRunning(),
    );
  }

  onEvent(handler: (event: WorkspaceEvent) => void): () => void {
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }

  async createConversation(
    project: Project,
    options: ConversationOptions = {},
  ): Promise<Conversation> {
    assertProjectDirectory(project.directory);
    const storedProject: Project = { id: project.id, directory: project.directory };
    const nativeId = await this.adapter.createConversation(
      { ...storedProject },
      options.displayName === undefined ? undefined : { displayName: options.displayName },
    );
    const conversation: Conversation = {
      id: randomUUID(),
      project: storedProject,
      nativeId,
      displayName: options.displayName ?? nativeId,
    };
    this.conversations.set(conversation.id, conversation);
    return snapshotConversation(conversation);
  }

  /**
   * Reattach to a native conversation created by an earlier process. The
   * conversation id can be preserved by the caller (a persisted mapping);
   * otherwise a new local id is assigned.
   */
  async resumeConversation(
    project: Project,
    nativeId: string,
    conversationId?: string,
  ): Promise<Conversation> {
    const conversation = await this.resumer.resume(project, nativeId, conversationId);
    return snapshotConversation(conversation);
  }

  async submit(
    conversationId: string,
    text: string,
    attachments: readonly AttachmentDraft[] = [],
  ): Promise<Execution> {
    this.assertRunning();
    const conversation = this.conversations.get(conversationId);
    if (conversation === undefined) {
      throw new UnknownConversationError(conversationId);
    }
    if (this.closingConversations.has(conversationId)) {
      throw new ConversationClosingError(conversationId);
    }
    assertProjectDirectory(conversation.project.directory);
    if (text.trim() === '') {
      throw new Error('Prompt text must not be empty');
    }

    const active = this.ledger.activeId(conversationId);
    const queueing = this.adapter.capabilities.queue === true;
    if (!queueing && active !== undefined) {
      throw new ConversationBusyError(active);
    }
    // Admit before calling the adapter: a queue-capable adapter may emit
    // `execution/started` synchronously when the conversation is free.
    const execution = this.ledger.create(conversationId, queueing);

    try {
      await this.adapter.submit(
        conversation.nativeId,
        execution.id,
        text,
        attachments.length === 0 ? undefined : attachments,
      );
    } catch (error) {
      if (error instanceof SubmitOutcomeUnknownError) {
        // The native side may have accepted the turn. Keep the association so a
        // second submission cannot overlap it; a later terminal event releases it.
        this.finish(execution, 'unknown', undefined, messageOf(error), { preserveActive: true });
        // Re-throw with an execution id so the ledger can name a worker that
        // may already be running. Keep the adapter-provided id when it has one.
        throw new SubmitOutcomeUnknownError(messageOf(error), error.executionId ?? execution.id);
      }
      this.finish(execution, 'failed', undefined, messageOf(error));
      throw new SubmitFailedError(messageOf(error), execution.id, { cause: error });
    }

    return snapshot(execution);
  }

  async decideApproval(
    executionId: string,
    requestId: string,
    kind: ApprovalDecisionKind,
  ): Promise<void> {
    this.assertRunning();
    const pending = this.pendingApprovals.get(requestId);
    if (pending === undefined || pending.request.executionId !== executionId) {
      throw new UnknownApprovalError(requestId);
    }
    const execution = this.ledger.get(executionId);
    if (execution === undefined || execution.state !== 'running') {
      this.clearPending(requestId);
      throw new UnknownApprovalError(requestId);
    }
    if (kind !== 'cancelled' && !pending.request.options.some((option) => option.kind === kind)) {
      throw new UnsupportedApprovalError(kind);
    }

    await this.adapter.respondToApproval({ requestId, kind });
    this.clearPending(requestId);
    this.emit({ type: 'execution/approval-decided', executionId, requestId, kind });
  }

  async cancel(executionId: string): Promise<void> {
    await this.cancelExecution(executionId, 'explicit-cancel');
  }

  /**
   * Settles an approval that the runtime's guard deadline expired. It uses the
   * same cancel path as an explicit cancel so the native response and the
   * execution terminal state are not written by a second control point.
   */
  async cancelForApprovalTimeout(executionId: string): Promise<void> {
    await this.cancelExecution(executionId, 'approval-timeout');
  }

  /**
   * Shared cancel path. The reason is recorded only after the execution and
   * capability checks, so a refused or unsupported cancel leaves no claim.
   */
  private async cancelExecution(
    executionId: string,
    reason: ExecutionCancelReason,
  ): Promise<void> {
    this.assertRunning();
    const execution = this.ledger.get(executionId);
    if (execution === undefined) {
      throw new UnknownExecutionError(executionId);
    }
    if (execution.state !== 'running') {
      return;
    }
    if (!this.adapter.capabilities.cancel) {
      throw new CancelNotSupportedError();
    }

    this.markCancelled(executionId, reason);
    if (!execution.started) {
      await this.cancelQueued(execution);
      return;
    }
    const pending = this.pendingApprovalFor(executionId);
    if (pending !== undefined) {
      await this.decideApproval(executionId, pending.request.requestId, 'cancelled');
    }

    const conversation = this.conversations.get(execution.conversationId);
    if (conversation !== undefined) {
      await this.adapter.cancel(conversation.nativeId);
    }
  }

  /**
   * Remove one admitted-but-unsent execution. A per-execution drop never
   * touches the active prompt; without it the adapter's native cancel is the
   * only fallback and may also stop the prompt in front. Either way the caller
   * must not be left waiting, so the execution is settled here if the adapter
   * did not already emit its terminal event.
   */
  private async cancelQueued(execution: MutableExecution): Promise<void> {
    const conversation = this.conversations.get(execution.conversationId);
    if (conversation !== undefined && this.adapter.dropQueued !== undefined) {
      const dropped = await this.adapter.dropQueued(conversation.nativeId, execution.id);
      if (dropped) {
        if (execution.state === 'running') {
          this.finish(execution, 'cancelled');
        }
        return;
      }
    }
    if (conversation !== undefined) {
      await this.adapter.cancel(conversation.nativeId);
    }
    if (execution.state === 'running') {
      this.finish(execution, 'cancelled');
    }
  }

  /**
   * Forced conversion: cancel the running execution, wait for it to settle,
   * then submit the new prompt on the same conversation. A confirmed terminal
   * state submits directly; `unknown` refuses, because the native side may
   * still be running the previous prompt. Empty text is rejected before any
   * cancel, so an invalid call cannot destroy the running turn.
   */
  async replace(
    executionId: string,
    text: string,
    attachments: readonly AttachmentDraft[] = [],
  ): Promise<Execution> {
    this.assertRunning();
    if (text.trim() === '') {
      throw new Error('Prompt text must not be empty');
    }
    const execution = this.ledger.get(executionId);
    if (execution === undefined) {
      throw new UnknownExecutionError(executionId);
    }
    if (execution.state === 'unknown') {
      throw new ReplaceUnknownError(executionId);
    }
    if (execution.state === 'running') {
      await this.cancelExecution(executionId, 'replace');
      const deadline = Date.now() + this.replaceTimeoutMs;
      while (Date.now() < deadline) {
        const current = this.ledger.get(executionId);
        if (current === undefined || current.state !== 'running') {
          break;
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
      }
      const current = this.ledger.get(executionId);
      if (current !== undefined && current.state === 'running') {
        throw new ReplaceTimeoutError(executionId, this.replaceTimeoutMs);
      }
      if (current !== undefined && current.state === 'unknown') {
        throw new ReplaceUnknownError(executionId);
      }
    }
    return this.submit(execution.conversationId, text, attachments);
  }

  async closeConversation(conversationId: string): Promise<void> {
    this.assertRunning();
    const conversation = this.conversations.get(conversationId);
    if (conversation === undefined) {
      throw new UnknownConversationError(conversationId);
    }
    // Mark before awaiting: a close with an unknown native outcome must not
    // accept a new execution.
    this.closingConversations.add(conversationId);
    const activeId = this.ledger.activeId(conversationId);
    this.settleQueuedForClose(conversationId, activeId);
    try {
      await this.closeNative(activeId, conversation.nativeId);
    } catch (error) {
      this.settleFailedClose(activeId, error);
      throw error;
    }
    this.conversations.delete(conversationId);
    this.ledger.forget(conversationId);
    this.closingConversations.delete(conversationId);
    const active = activeId === undefined ? undefined : this.ledger.get(activeId);
    if (active !== undefined) {
      this.finish(active, 'cancelled');
    }
  }

  /** Mark the active and queued executions closing; settle the queued ones now. */
  private settleQueuedForClose(conversationId: string, activeId: string | undefined): void {
    if (activeId !== undefined) {
      this.markCancelled(activeId, 'close');
    }
    for (const pendingId of this.ledger.pendingIds(conversationId)) {
      this.markCancelled(pendingId, 'close');
      const execution = this.ledger.get(pendingId);
      if (execution !== undefined && execution.state === 'running') {
        this.finish(execution, 'cancelled');
      }
    }
  }

  /** Cancel the active approval, then ask the adapter to close natively. */
  private async closeNative(activeId: string | undefined, nativeId: string): Promise<void> {
    if (activeId !== undefined) {
      const pending = this.pendingApprovalFor(activeId);
      if (pending !== undefined) {
        await this.decideApproval(activeId, pending.request.requestId, 'cancelled');
      }
    }
    await this.adapter.closeConversation(nativeId);
  }

  /** A failed close leaves a running active execution unknown but reserved. */
  private settleFailedClose(activeId: string | undefined, error: unknown): void {
    if (activeId === undefined) {
      return;
    }
    const execution = this.ledger.get(activeId);
    if (execution !== undefined && execution.state === 'running') {
      this.finish(execution, 'unknown', undefined, `Conversation close failed: ${messageOf(error)}`, {
        preserveActive: true,
      });
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;

    for (const execution of this.ledger.all()) {
      if (execution.state === 'running') {
        this.finish(execution, 'unknown', undefined, 'Workspace stopped before the execution settled');
      }
    }
    for (const [requestId, pending] of this.pendingApprovals) {
      this.clearPending(requestId);
      void this.adapter.respondToApproval({ requestId, kind: 'cancelled' }).catch(() => undefined);
    }
    this.closingConversations.clear();

    this.unsubscribe();
    await this.adapter.stop();
  }

  getConversation(conversationId: string): Conversation | undefined {
    const conversation = this.conversations.get(conversationId);
    return conversation === undefined ? undefined : snapshotConversation(conversation);
  }

  isConversationBusy(conversationId: string): boolean {
    return this.ledger.isBusy(conversationId);
  }

  readonly canQueue = (): boolean => this.adapter.capabilities.queue === true;

  getExecution(executionId: string): Execution | undefined {
    const execution = this.ledger.get(executionId);
    return execution === undefined ? undefined : snapshot(execution);
  }

  private handleAdapterEvent(event: HarnessEvent): void {
    switch (event.type) {
      case 'execution/output': {
        const execution = this.ledger.running(event.executionId);
        if (execution === undefined) {
          return;
        }
        if (event.channel === 'assistant') {
          execution.output += event.text;
        }
        this.emit(event);
        return;
      }
      case 'execution/tool': {
        if (this.ledger.running(event.executionId) === undefined) {
          return;
        }
        this.emit(event);
        return;
      }
      case 'execution/attachment': {
        const execution = this.ledger.running(event.executionId);
        if (execution === undefined || event.attachment.path.trim() === '') {
          return;
        }
        const attachment: Attachment = { ...event.attachment, id: randomUUID() };
        execution.attachments.push(attachment);
        this.emit({
          type: 'execution/attachment',
          executionId: event.executionId,
          attachment: cloneAttachment(attachment),
        });
        return;
      }
      case 'execution/approval-requested': {
        const execution = this.ledger.running(event.executionId);
        if (execution === undefined) {
          void this.adapter
            .respondToApproval({ requestId: event.request.requestId, kind: 'cancelled' })
            .catch(() => undefined);
          return;
        }
        if (this.adapter.capabilities.approval !== 'interactive') {
          void this.adapter
            .respondToApproval({ requestId: event.request.requestId, kind: 'cancelled' })
            .catch(() => undefined);
          this.emit({
            type: 'adapter/error',
            message: 'Harness sent an approval request but does not advertise interactive approval',
          });
          return;
        }
        if (this.pendingApprovals.has(event.request.requestId)) {
          return;
        }
        this.pendingApprovals.set(event.request.requestId, { request: event.request });
        this.emit(event);
        return;
      }
      case 'execution/completed':
        this.settleExecution(event.executionId, 'completed', event.stopReason);
        return;
      case 'execution/failed':
        this.settleExecution(event.executionId, 'failed', event.error);
        return;
      case 'execution/cancelled':
        this.settleExecution(event.executionId, 'cancelled');
        return;
      case 'execution/unknown':
        this.settleExecution(event.executionId, 'unknown', event.reason);
        return;
      case 'execution/started': {
        const execution = this.ledger.running(event.executionId);
        if (execution !== undefined) {
          this.ledger.markStarted(execution);
        }
        return;
      }
      case 'adapter/error': {
        this.emit(event);
        return;
      }
    }
  }

  /**
   * Apply one native terminal event. A running execution is settled; a late
   * event only releases the association preserved for an unknown outcome.
   */
  private settleExecution(
    executionId: string,
    state: 'completed' | 'failed' | 'cancelled' | 'unknown',
    detail?: string,
  ): void {
    const execution = this.ledger.get(executionId);
    if (execution === undefined) {
      return;
    }
    if (execution.state !== 'running') {
      this.ledger.dissociate(execution);
      return;
    }
    if (state === 'completed') {
      this.finish(execution, state, detail as StopReason | undefined);
    } else if (state === 'cancelled') {
      this.finish(execution, state);
    } else {
      this.finish(execution, state, undefined, detail);
    }
  }

  private pendingApprovalFor(executionId: string): PendingApproval | undefined {
    for (const pending of this.pendingApprovals.values()) {
      if (pending.request.executionId === executionId) {
        return pending;
      }
    }
    return undefined;
  }

  private clearPending(requestId: string): void {
    this.pendingApprovals.delete(requestId);
  }

  /** First initiator wins: a later timeout cannot rewrite an explicit cancel. */
  private markCancelled(executionId: string, reason: ExecutionCancelReason): void {
    const execution = this.ledger.get(executionId);
    if (execution !== undefined && execution.cancelReason === undefined) {
      execution.cancelReason = reason;
    }
  }

  private finish(
    execution: MutableExecution,
    state: Exclude<ExecutionState, 'running'>,
    stopReason?: StopReason,
    error?: string,
    options: { readonly preserveActive?: boolean } = {},
  ): void {
    if (execution.state !== 'running') {
      return;
    }
    execution.state = state;
    if (stopReason !== undefined) {
      execution.stopReason = stopReason;
    }
    if (error !== undefined) {
      execution.error = error;
    }
    if (options.preserveActive !== true) {
      this.ledger.dissociate(execution);
    }
    for (const requestId of [...this.pendingApprovals.keys()]) {
      const pending = this.pendingApprovals.get(requestId);
      if (pending?.request.executionId === execution.id) {
        this.clearPending(requestId);
      }
    }
    this.emit({
      type: 'execution/state',
      executionId: execution.id,
      state,
      ...(stopReason === undefined ? {} : { stopReason }),
      ...(error === undefined ? {} : { error }),
    });
  }

  private emit(event: WorkspaceEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A presentation listener must not break execution state transitions.
      }
    }
  }

  private assertRunning(): void {
    if (this.stopped) {
      throw new Error('Workspace has been stopped');
    }
  }
}

function snapshot(execution: MutableExecution): Execution {
  return {
    id: execution.id,
    conversationId: execution.conversationId,
    state: execution.state,
    output: execution.output,
    attachments: execution.attachments.map((attachment) => ({ ...attachment })),
    ...(execution.stopReason === undefined ? {} : { stopReason: execution.stopReason }),
    ...(execution.error === undefined ? {} : { error: execution.error }),
    ...(execution.state === 'cancelled' && execution.cancelReason !== undefined
      ? { cancelReason: execution.cancelReason }
      : {}),
  };
}

function snapshotConversation(conversation: Conversation): Conversation {
  return {
    id: conversation.id,
    nativeId: conversation.nativeId,
    displayName: conversation.displayName,
    project: { ...conversation.project },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
