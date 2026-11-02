import { randomUUID } from 'node:crypto';
import { cloneAttachment, type Attachment, type AttachmentDraft } from './content.js';
import type { Project } from './kernel.js';
import { assertProjectDirectory } from './project-directory.js';
import type {
  ApprovalDecisionKind,
  ApprovalRequest,
  ExecutionState,
  HarnessAdapter,
  HarnessEvent,
  StopReason,
} from './adapters/harness.js';
import { SubmitOutcomeUnknownError } from './adapters/harness.js';

export interface Conversation {
  readonly id: string;
  readonly project: Project;
  readonly nativeId: string;
}

export interface Execution {
  readonly id: string;
  readonly conversationId: string;
  readonly state: ExecutionState;
  readonly output: string;
  readonly attachments: readonly Attachment[];
  readonly stopReason?: StopReason;
  readonly error?: string;
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

export class ConversationBusyError extends Error {
  constructor(readonly executionId: string) {
    super(`Conversation already has a running execution: ${executionId}`);
    this.name = 'ConversationBusyError';
  }
}

export class ConversationClosingError extends Error {
  constructor(readonly conversationId: string) {
    super(`Conversation is closing and cannot accept new executions: ${conversationId}`);
    this.name = 'ConversationClosingError';
  }
}

export class UnknownConversationError extends Error {
  constructor(readonly conversationId: string) {
    super(`Unknown conversation: ${conversationId}`);
    this.name = 'UnknownConversationError';
  }
}

export class UnknownExecutionError extends Error {
  constructor(readonly executionId: string) {
    super(`Unknown execution: ${executionId}`);
    this.name = 'UnknownExecutionError';
  }
}

/** Cancel did not settle before the replace timeout; no second prompt is sent. */
export class ReplaceTimeoutError extends Error {
  constructor(
    readonly executionId: string,
    readonly timeoutMs: number,
  ) {
    super(
      `Execution ${executionId} did not stop within ${String(timeoutMs)}ms; refusing to submit a second prompt`,
    );
    this.name = 'ReplaceTimeoutError';
  }
}

/** The previous outcome is unknown, so a second prompt could overlap it. */
export class ReplaceUnknownError extends Error {
  constructor(readonly executionId: string) {
    super(`Execution ${executionId} has an unknown outcome; refusing to replace it`);
    this.name = 'ReplaceUnknownError';
  }
}

export class UnknownApprovalError extends Error {
  constructor(readonly requestId: string) {
    super(`Unknown or already settled approval request: ${requestId}`);
    this.name = 'UnknownApprovalError';
  }
}

export class UnsupportedApprovalError extends Error {
  constructor(readonly kind: ApprovalDecisionKind) {
    super(`The harness did not offer approval option: ${kind}`);
    this.name = 'UnsupportedApprovalError';
  }
}

export class CancelNotSupportedError extends Error {
  constructor() {
    super('The harness does not advertise cancellation support');
    this.name = 'CancelNotSupportedError';
  }
}

export class ResumeNotSupportedError extends Error {
  constructor() {
    super('The harness does not advertise resume support');
    this.name = 'ResumeNotSupportedError';
  }
}

/**
 * A definite refusal from the harness after an execution was created. The
 * execution is settled as `failed`; the id lets callers (e.g. the workbench
 * transfer log) keep the failed attempt associated with its execution.
 */
export class SubmitFailedError extends Error {
  constructor(
    message: string,
    readonly executionId: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
    this.name = 'SubmitFailedError';
  }
}

export interface WorkspaceOptions {
  readonly approvalTimeoutMs?: number;
  /** How long replace() waits for a cancelled execution to settle. */
  readonly replaceTimeoutMs?: number;
}

interface MutableExecution {
  readonly id: string;
  readonly conversationId: string;
  state: ExecutionState;
  output: string;
  readonly attachments: Attachment[];
  stopReason?: StopReason;
  error?: string;
}

interface PendingApproval {
  readonly request: ApprovalRequest;
  timer?: NodeJS.Timeout;
}

const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;
const DEFAULT_REPLACE_TIMEOUT_MS = 10_000;

export class Workspace {
  private readonly adapter: HarnessAdapter;
  private readonly approvalTimeoutMs: number;
  private readonly replaceTimeoutMs: number;
  private readonly conversations = new Map<string, Conversation>();
  private readonly resumingConversations = new Set<string>();
  private readonly executions = new Map<string, MutableExecution>();
  private readonly activeExecutionByConversation = new Map<string, string>();
  private readonly closingConversations = new Set<string>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly listeners = new Set<(event: WorkspaceEvent) => void>();
  private readonly unsubscribe: () => void;
  private stopped = false;

  constructor(adapter: HarnessAdapter, options: WorkspaceOptions = {}) {
    this.adapter = adapter;
    this.approvalTimeoutMs = options.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
    if (!Number.isFinite(this.approvalTimeoutMs) || this.approvalTimeoutMs <= 0) {
      throw new Error(`approvalTimeoutMs must be a positive number: ${String(options.approvalTimeoutMs)}`);
    }
    this.replaceTimeoutMs = options.replaceTimeoutMs ?? DEFAULT_REPLACE_TIMEOUT_MS;
    if (!Number.isFinite(this.replaceTimeoutMs) || this.replaceTimeoutMs <= 0) {
      throw new Error(`replaceTimeoutMs must be a positive number: ${String(options.replaceTimeoutMs)}`);
    }
    this.unsubscribe = adapter.onEvent((event) => this.handleAdapterEvent(event));
  }

  get approvalTimeout(): number {
    return this.approvalTimeoutMs;
  }

  onEvent(handler: (event: WorkspaceEvent) => void): () => void {
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }

  async createConversation(project: Project): Promise<Conversation> {
    assertProjectDirectory(project.directory);
    const storedProject: Project = { id: project.id, directory: project.directory };
    const nativeId = await this.adapter.createConversation({ ...storedProject });
    const conversation: Conversation = { id: randomUUID(), project: storedProject, nativeId };
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
    this.assertRunning();
    assertProjectDirectory(project.directory);
    if (this.adapter.capabilities.resume !== true || this.adapter.resume === undefined) {
      throw new ResumeNotSupportedError();
    }
    if (
      conversationId !== undefined &&
      (this.conversations.has(conversationId) || this.resumingConversations.has(conversationId))
    ) {
      throw new Error(`Conversation already exists or is being resumed: ${conversationId}`);
    }
    if (conversationId !== undefined) {
      // Reserve the id before awaiting the native call so two concurrent
      // resumes of the same id cannot both succeed.
      this.resumingConversations.add(conversationId);
    }
    const storedProject: Project = { id: project.id, directory: project.directory };
    try {
      await this.adapter.resume(nativeId, storedProject.directory);
    } catch (error) {
      if (conversationId !== undefined) {
        this.resumingConversations.delete(conversationId);
      }
      throw error;
    }
    const conversation: Conversation = {
      id: conversationId ?? randomUUID(),
      project: storedProject,
      nativeId,
    };
    this.conversations.set(conversation.id, conversation);
    if (conversationId !== undefined) {
      this.resumingConversations.delete(conversationId);
    }
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

    const active = this.activeExecutionByConversation.get(conversationId);
    if (active !== undefined) {
      throw new ConversationBusyError(active);
    }

    const execution: MutableExecution = {
      id: randomUUID(),
      conversationId,
      state: 'running',
      output: '',
      attachments: [],
    };
    this.executions.set(execution.id, execution);
    this.activeExecutionByConversation.set(conversationId, execution.id);

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
    const execution = this.executions.get(executionId);
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
    this.assertRunning();
    const execution = this.executions.get(executionId);
    if (execution === undefined) {
      throw new UnknownExecutionError(executionId);
    }
    if (execution.state !== 'running') {
      return;
    }
    if (!this.adapter.capabilities.cancel) {
      throw new CancelNotSupportedError();
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
    const execution = this.executions.get(executionId);
    if (execution === undefined) {
      throw new UnknownExecutionError(executionId);
    }
    if (execution.state === 'unknown') {
      throw new ReplaceUnknownError(executionId);
    }
    if (execution.state === 'running') {
      await this.cancel(executionId);
      const deadline = Date.now() + this.replaceTimeoutMs;
      while (Date.now() < deadline) {
        const current = this.executions.get(executionId);
        if (current === undefined || current.state !== 'running') {
          break;
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
      }
      const current = this.executions.get(executionId);
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

    // Mark the conversation before awaiting anything: a close whose native
    // outcome is still unknown must not accept a new execution.
    this.closingConversations.add(conversationId);
    const activeId = this.activeExecutionByConversation.get(conversationId);

    try {
      if (activeId !== undefined) {
        const pending = this.pendingApprovalFor(activeId);
        if (pending !== undefined) {
          await this.decideApproval(activeId, pending.request.requestId, 'cancelled');
        }
      }
      await this.adapter.closeConversation(conversation.nativeId);
    } catch (error) {
      if (activeId !== undefined) {
        const execution = this.executions.get(activeId);
        if (execution !== undefined && execution.state === 'running') {
          this.finish(
            execution,
            'unknown',
            undefined,
            `Conversation close failed: ${messageOf(error)}`,
            { preserveActive: true },
          );
        }
      }
      throw error;
    }

    this.conversations.delete(conversationId);
    this.activeExecutionByConversation.delete(conversationId);
    this.closingConversations.delete(conversationId);
    if (activeId !== undefined) {
      const execution = this.executions.get(activeId);
      if (execution !== undefined) {
        this.finish(execution, 'cancelled');
      }
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;

    for (const execution of this.executions.values()) {
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

  getExecution(executionId: string): Execution | undefined {
    const execution = this.executions.get(executionId);
    return execution === undefined ? undefined : snapshot(execution);
  }

  private handleAdapterEvent(event: HarnessEvent): void {
    switch (event.type) {
      case 'execution/output': {
        const execution = this.runningExecution(event.executionId);
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
        if (this.runningExecution(event.executionId) === undefined) {
          return;
        }
        this.emit(event);
        return;
      }
      case 'execution/attachment': {
        const execution = this.runningExecution(event.executionId);
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
        const execution = this.runningExecution(event.executionId);
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
        this.startApprovalTimer(event.executionId, event.request.requestId);
        this.emit(event);
        return;
      }
      case 'execution/completed': {
        const execution = this.executions.get(event.executionId);
        if (execution === undefined) {
          return;
        }
        if (execution.state === 'running') {
          this.finish(execution, 'completed', event.stopReason);
        } else {
          this.releasePreservedActive(execution);
        }
        return;
      }
      case 'execution/failed': {
        const execution = this.executions.get(event.executionId);
        if (execution === undefined) {
          return;
        }
        if (execution.state === 'running') {
          this.finish(execution, 'failed', undefined, event.error);
        } else {
          this.releasePreservedActive(execution);
        }
        return;
      }
      case 'execution/cancelled': {
        const execution = this.executions.get(event.executionId);
        if (execution === undefined) {
          return;
        }
        if (execution.state === 'running') {
          this.finish(execution, 'cancelled');
        } else {
          this.releasePreservedActive(execution);
        }
        return;
      }
      case 'execution/unknown': {
        const execution = this.executions.get(event.executionId);
        if (execution === undefined) {
          return;
        }
        if (execution.state === 'running') {
          this.finish(execution, 'unknown', undefined, event.reason);
        } else {
          this.releasePreservedActive(execution);
        }
        return;
      }
      case 'execution/started': {
        return;
      }
      case 'adapter/error': {
        this.emit(event);
        return;
      }
    }
  }

  private startApprovalTimer(executionId: string, requestId: string): void {
    const timer = setTimeout(() => {
      const pending = this.pendingApprovals.get(requestId);
      if (pending === undefined) {
        return;
      }
      this.pendingApprovals.delete(requestId);
      this.emit({ type: 'execution/approval-decided', executionId, requestId, kind: 'cancelled' });
      void this.adapter
        .respondToApproval({ requestId, kind: 'cancelled' })
        .then(() => {
          const execution = this.executions.get(executionId);
          const conversation =
            execution === undefined ? undefined : this.conversations.get(execution.conversationId);
          if (conversation !== undefined) {
            return this.adapter.cancel(conversation.nativeId);
          }
          return undefined;
        })
        .catch((error: unknown) => {
          this.emit({ type: 'adapter/error', message: `Approval timeout handling failed: ${messageOf(error)}` });
        });
    }, this.approvalTimeoutMs);
    timer.unref();
    const pending = this.pendingApprovals.get(requestId);
    if (pending !== undefined) {
      pending.timer = timer;
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
    const pending = this.pendingApprovals.get(requestId);
    if (pending?.timer !== undefined) {
      clearTimeout(pending.timer);
    }
    this.pendingApprovals.delete(requestId);
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
      this.activeExecutionByConversation.delete(execution.conversationId);
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

  private runningExecution(executionId: string): MutableExecution | undefined {
    const execution = this.executions.get(executionId);
    return execution?.state === 'running' ? execution : undefined;
  }

  /**
   * An execution that was settled as unknown while its conversation stayed
   * busy has now received a native terminal event; release the association so
   * the conversation can accept new work. The execution state is not rewritten.
   */
  private releasePreservedActive(execution: MutableExecution): void {
    if (this.activeExecutionByConversation.get(execution.conversationId) === execution.id) {
      this.activeExecutionByConversation.delete(execution.conversationId);
    }
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
  };
}

function snapshotConversation(conversation: Conversation): Conversation {
  return {
    id: conversation.id,
    nativeId: conversation.nativeId,
    project: { ...conversation.project },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
