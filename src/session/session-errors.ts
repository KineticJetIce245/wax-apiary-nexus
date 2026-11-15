/**
 * Session-layer errors shared by the registry and its callers. They live in a
 * separate module so the record mapping helpers can reference the same classes
 * without importing the registry itself.
 */

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
