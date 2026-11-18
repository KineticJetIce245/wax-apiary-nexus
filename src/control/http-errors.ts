import { LiveHiveServiceError } from '../b/live-hive-service-errors.js';
import {
  GraphAnswerError,
  GraphHostDisposedError,
  GraphLoadError,
  GraphNotFoundError,
  GraphSessionBusyError,
} from '../daemon/graph-host.js';
import { ProjectDirectoryError } from '../project/project-directory.js';
import { CompositionValidationError, QueueFullError } from '../runtime/index.js';
import { BindingValidationError } from '../session/instantiate-foragers.js';
import { HttpError } from './server-types.js';

/** Stable HTTP mapping; no native/prompt/output text is ever forwarded. */
export function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) {
    return error;
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
  if (error instanceof GraphNotFoundError) {
    return new HttpError(404, 'not-found', 'graph is not loaded');
  }
  if (error instanceof GraphSessionBusyError) {
    return new HttpError(409, 'session-busy', 'session is busy');
  }
  if (error instanceof GraphAnswerError) {
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
  if (error instanceof TypeError) {
    return new HttpError(400, 'bad-request', 'invalid request value');
  }
  if (error instanceof GraphHostDisposedError || error instanceof GraphLoadError) {
    return new HttpError(500, 'internal', 'internal error');
  }
  return new HttpError(500, 'internal', 'internal error');
}
