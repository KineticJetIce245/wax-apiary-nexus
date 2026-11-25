import {
  DispatchConflictError,
  DispatchExecutionError,
  DispatchSessionNotFoundError,
  DispatchTimeoutError,
} from '../b/dispatch-service.js';
import { LiveHiveServiceError } from '../b/live-hive-service-errors.js';
import {
  LiveHiveHostAnswerError,
  LiveHiveHostDisposedError,
  LiveHiveHostLoadError,
  LiveHiveHostNotFoundError,
} from '../daemon/graph-host.js';
import { ProjectDirectoryError } from '../project/project-directory.js';
import { CompositionValidationError, QueueFullError } from '../runtime/index.js';
import { ForagerExecutionError } from '../session/forager.js';
import { BindingValidationError } from '../session/instantiate-foragers.js';
import { ConversationBusyError, SessionBusyError } from '../session/session-errors.js';
import { HttpError } from './server-types.js';

/** Stable HTTP mapping; no native/prompt/output text is ever forwarded. */
export function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) {
    return error;
  }
  const mapped = mapSessionAndDispatchError(error);
  if (mapped !== undefined) {
    return mapped;
  }
  if (error instanceof LiveHiveServiceError) {
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
  }
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
  if (error instanceof LiveHiveHostAnswerError) {
    switch (error.reason) {
      case 'unknown-node':
      case 'not-user-node':
        return new HttpError(400, 'bad-request', 'unknown or unanswerable node');
      case 'no-hover':
      case 'token-mismatch':
        return new HttpError(409, 'conflict', 'hover is not open');
    }
  }
  if (error instanceof QueueFullError) {
    return new HttpError(409, 'conflict', 'graph queue is full');
  }
  if (error instanceof ForagerExecutionError) {
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
  if (error instanceof TypeError) {
    return new HttpError(400, 'bad-request', 'invalid request value');
  }
  if (error instanceof LiveHiveHostDisposedError || error instanceof LiveHiveHostLoadError) {
    return new HttpError(500, 'internal', 'internal error');
  }
  return new HttpError(500, 'internal', 'internal error');
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
  if (error instanceof DispatchTimeoutError) {
    return new HttpError(409, 'dispatch-timeout', 'dispatch timed out');
  }
  if (error instanceof DispatchExecutionError) {
    return error.state === 'cancelled'
      ? new HttpError(409, 'execution-cancelled', 'execution was cancelled')
      : new HttpError(500, 'internal', 'internal error');
  }
  return undefined;
}
