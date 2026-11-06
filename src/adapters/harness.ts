/**
 * Neutral contract between the Workspace kernel and a native Harness adapter.
 * ACP/DSH-specific types stay inside adapters; the kernel only sees these.
 */

import type { AttachmentDraft } from '../shared/content.js';
import type { Project } from '../project/kernel.js';

export type ExecutionState = 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';

export type StopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'max_turn_requests'
  | 'refusal'
  | 'cancelled'
  | 'unknown';

export type ApprovalOptionKind =
  | 'allow_once'
  | 'reject_once'
  | 'allow_always'
  | 'reject_always';

export type ApprovalDecisionKind = 'allow_once' | 'reject_once' | 'cancelled';

export interface ApprovalOption {
  readonly id: string;
  readonly kind: ApprovalOptionKind;
  readonly label: string;
}

export interface ApprovalRequest {
  readonly requestId: string;
  readonly executionId: string;
  readonly summary: string;
  readonly options: readonly ApprovalOption[];
}

export interface ApprovalDecision {
  readonly requestId: string;
  readonly kind: ApprovalDecisionKind;
}

export interface HarnessCapabilities {
  readonly approval: 'interactive' | 'policy-only' | 'none';
  readonly cancel: boolean;
  readonly streaming: boolean;
  /**
   * True only when this adapter can set a native session title. WAX always
   * keeps its own display alias; native names are a best-effort projection.
   */
  readonly rename: boolean;
  /**
   * True only when this adapter implements and has tested a resume operation.
   * An upstream harness supporting resume is not sufficient to advertise it.
   */
  readonly resume: boolean;
}

/** WAX-owned identity attached to a native conversation at creation time. */
export interface ConversationOptions {
  /**
   * Stable display alias, for example
   * `wax-apiary-nexus-session-<apiary>-<composition>`. Adapters that support
   * native naming project it; the rest keep it as the WAX-side alias.
   */
  readonly displayName?: string;
}

export type HarnessEvent =
  | { readonly type: 'execution/started'; readonly executionId: string }
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
      readonly attachment: AttachmentDraft;
    }
  | {
      readonly type: 'execution/approval-requested';
      readonly executionId: string;
      readonly request: ApprovalRequest;
    }
  | {
      readonly type: 'execution/completed';
      readonly executionId: string;
      readonly stopReason: StopReason;
    }
  | { readonly type: 'execution/failed'; readonly executionId: string; readonly error: string }
  | { readonly type: 'execution/cancelled'; readonly executionId: string }
  | { readonly type: 'execution/unknown'; readonly executionId: string; readonly reason: string }
  | { readonly type: 'adapter/error'; readonly message: string };

export interface HarnessAdapter {
  readonly capabilities: HarnessCapabilities;

  start(): Promise<void>;
  stop(): Promise<void>;

  /** Create a native conversation for the project and return its native id. */
  createConversation(project: Project, options?: ConversationOptions): Promise<string>;

  /**
   * Reattach to a native conversation created by an earlier process. Only
   * implemented when `capabilities.resume` is true.
   */
  resume?(nativeId: string, cwd: string): Promise<void>;

  /**
   * Start one prompt turn. The adapter must emit exactly one terminal event for
   * this execution; the Workspace enforces one active execution per conversation.
   * Optional attachments are local files already associated with a completed
   * execution (or staged by the user); an adapter may ignore types it cannot
   * carry natively.
   */
  submit(
    nativeId: string,
    executionId: string,
    text: string,
    attachments?: readonly AttachmentDraft[],
  ): Promise<void>;

  cancel(nativeId: string): Promise<void>;

  /** Resolve a pending approval request. Unknown request ids must reject. */
  respondToApproval(decision: ApprovalDecision): Promise<void>;

  closeConversation(nativeId: string): Promise<void>;

  onEvent(handler: (event: HarnessEvent) => void): () => void;
}

/**
 * Rejection from `submit` when the native side may have accepted the turn but
 * the client cannot tell (for example a response timeout after turn/started,
 * or a lost acknowledgement). The Workspace settles the execution as
 * `unknown` and keeps the conversation busy until a native terminal event
 * arrives or the conversation is closed/stopped. A definite rejection from the
 * native side must use a regular Error instead.
 */
export class SubmitOutcomeUnknownError extends Error {
  constructor(
    message: string,
    readonly executionId?: string,
  ) {
    super(message);
    this.name = 'SubmitOutcomeUnknownError';
  }
}
