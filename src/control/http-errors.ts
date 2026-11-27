import {
  DispatchConflictError,
  DispatchSessionNotFoundError,
} from '../b/dispatch-service.js';
import { LiveHiveServiceError } from '../b/live-hive-service-errors.js';
import {
  LiveHiveHostAnswerError,
  LiveHiveHostDisposedError,
  LiveHiveHostLoadError,
  LiveHiveHostNotFoundError,
} from '../daemon/graph-host.js';
import { ProjectDirectoryError } from '../project/project-directory.js';
import {
  CompositionValidationError,
  HoneyIncompatibleError,
  ReceptorBlockTimeoutError,
  ReceptorFullError,
} from '../runtime/index.js';
import { ForagerExecutionError } from '../session/forager.js';
import { BindingValidationError } from '../session/instantiate-foragers.js';
import { ConversationBusyError, SessionBusyError } from '../session/session-errors.js';
import { HttpError } from './server-types.js';

/** Stable HTTP mapping; no native/prompt/output text is ever forwarded. */
export function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) {
    return error;
  }
  const mapped = mapKnownError(error);
  if (mapped !== undefined) {
    return mapped;
  }
  if (error instanceof LiveHiveHostDisposedError || error instanceof LiveHiveHostLoadError) {
    return new HttpError(500, 'internal', 'internal error');
  }
  return new HttpError(500, 'internal', 'internal error');
}

function mapKnownError(error: unknown): HttpError | undefined {
  return (
    mapSessionAndDispatchError(error) ??
    mapLiveHiveServiceError(error) ??
    mapReceptorError(error) ??
    mapHostAnswerError(error) ??
    mapForagerExecutionError(error) ??
    mapDefinitionError(error) ??
    mapHoneyError(error)
  );
}

function mapHoneyError(error: unknown): HttpError | undefined {
  if (!isHoneyIncompatible(error)) {
    return undefined;
  }
  // A stale M18/schema-1 field is a client-visible incompatibility, not an
  // internal fault. The body stays generic; a path may appear only in logs.
  return new HttpError(
    409,
    'honey-incompatible',
    'honey snapshot is incompatible with this live hive',
  );
}

function mapHostAnswerError(error: unknown): HttpError | undefined {
  if (!(error instanceof LiveHiveHostAnswerError)) {
    return undefined;
  }
  switch (error.reason) {
    case 'unknown-node':
    case 'not-user-node':
      return new HttpError(400, 'bad-request', 'unknown or unanswerable node');
    case 'no-hover':
    case 'token-mismatch':
      return new HttpError(409, 'conflict', 'hover is not open');
  }
}

function mapForagerExecutionError(error: unknown): HttpError | undefined {
  if (!(error instanceof ForagerExecutionError)) {
    return undefined;
  }
  // A cancelled execution is a client-visible outcome, not an internal
  // fault. Only the Workspace's native approval timer is reported as
  // `approval-timeout`; an explicit cancel, close, replace or an
  // unattributed native cancel stays `execution-cancelled`. `failed` and
  // `unknown` stay internal 500 because neither proves a clean stop.
  if (error.state !== 'cancelled') {
    return new HttpError(500, 'internal', 'internal error');
  }
  return error.cancelReason === 'approval-timeout'
    ? new HttpError(409, 'approval-timeout', 'approval request timed out')
    : new HttpError(409, 'execution-cancelled', 'execution was cancelled');
}

function mapDefinitionError(error: unknown): HttpError | undefined {
  if (error instanceof CompositionValidationError) {
    return new HttpError(400, 'bad-request', 'invalid composition definition');
  }
  if (error instanceof BindingValidationError) {
    return new HttpError(400, 'bad-request', 'invalid graph bindings');
  }
  if (error instanceof ProjectDirectoryError) {
    return new HttpError(400, 'bad-request', 'invalid project directory');
  }
  if (error instanceof LiveHiveHostNotFoundError) {
    return new HttpError(404, 'not-found', 'graph is not loaded');
  }
  return undefined;
}

/** Walk the `cause` chain because the host wraps Honey load failures. */
function isHoneyIncompatible(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (current instanceof HoneyIncompatibleError) {
      return true;
    }
    if (!(current instanceof Error)) {
      return false;
    }
    current = current.cause;
  }
  return false;
}

function mapLiveHiveServiceError(error: unknown): HttpError | undefined {
  if (!(error instanceof LiveHiveServiceError)) {
    return undefined;
  }
  switch (error.kind) {
    case 'not-found':
      return new HttpError(404, 'not-found', error.message);
    case 'conflict':
      return new HttpError(409, 'conflict', error.message);
    case 'invalid':
    case 'project':
    case 'unsupported':
      return new HttpError(400, 'bad-request', error.message);
  }
  return undefined;
}

/** Structured receptor overflow errors; callers can read bee, depth and limit. */
function mapReceptorError(error: unknown): HttpError | undefined {
  if (error instanceof ReceptorFullError) {
    return new HttpError(429, 'bee-receptor-full', 'bee receptor is full', {
      body: {
        liveId: error.liveId,
        beeId: error.nodeId,
        pending: error.pending,
        limit: error.limit,
        policy: error.policy,
      },
    });
  }
  if (error instanceof ReceptorBlockTimeoutError) {
    return new HttpError(429, 'bee-receptor-block-timeout', 'bee receptor block wait timed out', {
      body: {
        liveId: error.liveId,
        beeId: error.beeId,
        pending: error.pending,
        limit: error.limit,
        policy: error.policy,
        waitedMs: error.waitedMs,
      },
    });
  }
  return undefined;
}

/**
 * Session-layer and dispatch errors. Both layers define their own classes and
 * otherwise fall through to `internal`, so they are mapped explicitly here.
 * A busy conversation and a busy session are the same client-visible outcome:
 * the caller must retry later, not treat the run as an internal fault.
 */
function mapSessionAndDispatchError(error: unknown): HttpError | undefined {
  if (error instanceof ConversationBusyError || error instanceof SessionBusyError) {
    return new HttpError(409, 'session-busy', 'session is busy');
  }
  if (error instanceof DispatchSessionNotFoundError) {
    return new HttpError(404, 'not-found', 'dispatch session is not registered');
  }
  if (error instanceof DispatchConflictError) {
    return new HttpError(409, 'conflict', 'dispatch session parameters conflict with the session');
  }
  return undefined;
}
