import type { ForagerNode, Value } from './types.js';

export type GuardDecision = 'allow_once' | 'reject_once' | 'cancelled';

/**
 * A native approval request that the runtime parks as a Guard hover.
 *
 * The attribution fields are optional because a request can be raised outside
 * a LiveHive or before the owning layer is known. An absent field means "not
 * known", never an empty id.
 */
export interface GuardRequest {
  readonly requestId: string;
  readonly executionId: string;
  readonly summary: string;
  readonly options: readonly string[];
  /** The LiveHive graph that owns the requesting forager. */
  readonly liveId?: string;
  /** The forager node (bee) that requested the approval. */
  readonly beeId?: string;
  /** The native session/conversation the approval came from. */
  readonly sessionId?: string;
}

/**
 * Handed to the executor for the duration of one activation. `requestGuard`
 * opens a Guard hover and resolves with the decision; a decision for a request
 * that is not the current one is rejected, never replayed.
 */
export interface ExecutionContext {
  requestGuard(
    request: GuardRequest,
    decide?: (request: GuardRequest) => Promise<GuardDecision>,
  ): Promise<GuardDecision>;
}

/**
 * The runtime never talks to a harness directly. A forager node delegates to an
 * injected executor, which is scripted in tests and wired to real adapters later.
 */
export interface NodeExecutor {
  execute(node: ForagerNode, input: Value, context?: ExecutionContext): Promise<Value>;
}

/**
 * Serializes a Value to the text carried by `{{input}}`. `message` is the
 * universal text field; any other object is rendered as JSON.
 */
export function serializeValue(value: Value): string {
  const message = value['message'];
  if (typeof message === 'string') {
    return message;
  }
  // An attachment-only value renders as empty text: the file convention is
  // carried by the attachments themselves, not by the prompt.
  if (Object.keys(value).every((key) => key === 'attachments')) {
    return '';
  }
  return JSON.stringify(value);
}

export function renderPrompt(template: string, input: Value): string {
  return template.split('{{input}}').join(serializeValue(input));
}
