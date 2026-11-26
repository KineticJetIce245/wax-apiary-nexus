import { BeeIoError } from './errors.js';
import type { ForagerNode, JsonValue, Value } from './types.js';
import { getPath } from './value-paths.js';

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
 * A Bee result: the reply value plus an independent `drop` list applied after
 * write-back (ARCHITECTURE.md §4.12). A plain Value is the common case; the
 * envelope is used only when there is a drop list (it may be empty).
 */
export interface BeeResult {
  readonly value: Value;
  readonly drop: readonly string[];
}

/**
 * The runtime never talks to a harness directly. A forager node delegates to an
 * injected executor, which is scripted in tests and wired to real adapters later.
 */
export interface NodeExecutor {
  execute(
    node: ForagerNode,
    input: Value,
    context?: ExecutionContext,
  ): Promise<Value | BeeResult>;
}

/**
 * True when an executor returned the explicit value+drop result shape. Both
 * keys are required, so an ordinary reply that happens to carry `value` is
 * still a Value.
 */
export function isBeeResult(output: Value | BeeResult): output is BeeResult {
  if (typeof output !== 'object' || output === null || Array.isArray(output)) {
    return false;
  }
  const record = output as Record<string, unknown>;
  return (
    Object.hasOwn(record, 'value') &&
    Object.hasOwn(record, 'drop') &&
    Array.isArray(record['drop']) &&
    (record['drop'] as unknown[]).every((entry) => typeof entry === 'string') &&
    typeof record['value'] === 'object' &&
    record['value'] !== null &&
    !Array.isArray(record['value'])
  );
}

/**
 * Serializes a Value to text: `message` when it is a string, otherwise its JSON
 * form. This is the single text projection for prompts and diagnostics.
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

/**
 * Renders a forager prompt. `{{dot.path}}` placeholders resolve against the
 * activation input; the parser guarantees each is declared in `reads` or
 * `fallback`. Strings render verbatim, other JSON renders as JSON.
 */
export function renderPrompt(template: string, value: Value): string {
  return template.replace(/\{\{([^}]*)\}\}/g, (_match, rawName: string) => {
    const path = rawName.trim();
    const found = getPath(value, path);
    if (!found.found) {
      throw new BeeIoError(
        'missing-read',
        `prompt placeholder '{{${path}}}' is missing from the value`,
      );
    }
    return formatTemplateValue(found.value as JsonValue);
  });
}

function formatTemplateValue(value: JsonValue): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
}
