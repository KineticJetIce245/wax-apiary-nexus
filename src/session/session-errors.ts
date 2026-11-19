/**
 * Session-layer errors shared by the workspace, the registry and their callers.
 * They live in a separate module so the record mapping helpers can reference the
 * same classes without importing the workspace or registry itself.
 */

import type { ApprovalDecisionKind } from '../adapters/harness.js';

export class SessionAlreadyRegisteredError extends Error {
  constructor(readonly nativeId: string) {
    super(`A session with native id '${nativeId}' is already registered`);
    this.name = 'SessionAlreadyRegisteredError';
  }
}

export class SessionNotFoundError extends Error {
  constructor(readonly sessionId: string) {
    super(`Unknown session: ${sessionId}`);
    this.name = 'SessionNotFoundError';
  }
}

export class SessionBusyError extends Error {
  constructor(readonly sessionId: string) {
    super(`Session is busy: ${sessionId}`);
    this.name = 'SessionBusyError';
  }
}

/**
 * A hydrated session could not be reattached to its native conversation. The
 * record is kept so the caller may retry; this error is never thrown by
 * `create`/`resume`, which surface the underlying failure.
 */
export class SessionAttachError extends Error {
  constructor(
    readonly sessionId: string,
    readonly nativeId: string,
    options?: { readonly cause?: unknown },
  ) {
    super(`Failed to attach session '${sessionId}' to native session '${nativeId}'`, options);
    this.name = 'SessionAttachError';
  }
}

/**
 * A harness name has no workspace in this registry. An omitted name is the
 * multi-workspace call form that requires an explicit harness.
 */
export class UnknownHarnessError extends Error {
  constructor(readonly harness: string | undefined) {
    super(
      harness === undefined
        ? 'An explicit harness is required when multiple workspaces are configured'
        : `Unknown harness: ${harness}`,
    );
    this.name = 'UnknownHarnessError';
  }
}

/**
 * Static sweep-failure text. A close error may come from the native adapter,
 * so its message is never forwarded: a control caller only learns that this
 * session could not be closed, not anything a native process said.
 */
export function sweepErrorMessage(error: unknown): string {
  if (error instanceof SessionBusyError) {
    return 'session is busy';
  }
  if (error instanceof SessionNotFoundError) {
    return 'session not found';
  }
  return 'close failed';
}

// Workspace lifecycle and approval errors. They stay in this shared module so
// `workspace.ts` stays under its line budget; they are re-exported there for
// callers that already import from the workspace module.

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
