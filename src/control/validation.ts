import type { LoadGraphOptions } from '../daemon/graph-host.js';
import type { GraphBindings } from '../graph/binding.js';
import type { Project } from '../project/kernel.js';
import { parseComposition, type GuardDecision, type Value } from '../runtime/index.js';
import {
  MAX_GRAPH_REF_LENGTH,
  MAX_ID_LENGTH,
  MAX_TOKEN_LENGTH,
} from './server-constants.js';
import {
  HttpError,
  type AnswerRequest,
  type TriggerRequest,
} from './server-types.js';

export function parseGuardDecision(body: Record<string, unknown>): {
  readonly requestId: string;
  readonly decision: GuardDecision;
} {
  assertExactFields(body, ['requestId', 'decision'], 'guard decision');
  const requestId = requireStringField(body, 'requestId', 'requestId', MAX_ID_LENGTH);
  const decision = body['decision'];
  if (
    decision !== 'allow_once' &&
    decision !== 'reject_once' &&
    decision !== 'cancelled'
  ) {
    throw new HttpError(
      400,
      'bad-request',
      'decision must be allow_once, reject_once or cancelled',
    );
  }
  return { requestId, decision };
}

export function parseLoadBody(body: Record<string, unknown>): LoadGraphOptions {
  assertExactFields(
    body,
    ['definition', 'bindings', 'project', 'idleTtlMs', 'defaultHarness'],
    'load request',
  );
  const definition = parseComposition(requireBodyField(body, 'definition', 'load request'));
  const bindings = parseBindings(requireBodyField(body, 'bindings', 'load request'));
  const project = parseProject(requireBodyField(body, 'project', 'load request'));
  const idleTtlMs = parseOptionalNonNegativeInteger(body['idleTtlMs'], 'idleTtlMs');
  const defaultHarness = body['defaultHarness'];
  if (defaultHarness !== undefined && typeof defaultHarness !== 'string') {
    throw new HttpError(400, 'bad-request', 'defaultHarness must be a string');
  }
  return {
    definition,
    bindings,
    project,
    ...(idleTtlMs === undefined ? {} : { idleTtlMs }),
    ...(defaultHarness === undefined ? {} : { defaultHarness }),
  };
}

export function parseTriggerBody(body: Record<string, unknown>): TriggerRequest {
  const graphRef = body['graphRef'];
  assertExactFields(
    body,
    graphRef === undefined
      ? ['graphId', 'nodeId', 'value']
      : ['graphId', 'nodeId', 'value', 'graphRef'],
    'trigger request',
  );
  const graphId = requireStringField(body, 'graphId', 'graphId', MAX_ID_LENGTH);
  const nodeId = requireStringField(body, 'nodeId', 'nodeId', MAX_ID_LENGTH);
  if (!Object.hasOwn(body, 'value') || body['value'] === undefined) {
    throw new HttpError(400, 'bad-request', "missing field 'value' in trigger request");
  }
  let graphRefValue: string | undefined;
  if (graphRef !== undefined) {
    graphRefValue = requireStringField(body, 'graphRef', 'graphRef', MAX_GRAPH_REF_LENGTH);
    if (graphRefValue.trim() === '') {
      throw new HttpError(400, 'bad-request', 'graphRef must not be blank');
    }
  }
  return {
    graphId,
    nodeId,
    value: body['value'] as Value,
    ...(graphRefValue === undefined ? {} : { graphRef: graphRefValue }),
  };
}

export function parseAnswerBody(body: Record<string, unknown>): AnswerRequest {
  const token = body['token'];
  const graphRef = body['graphRef'];
  const allowed = ['graphId', 'nodeId', 'value'];
  if (token !== undefined) {
    allowed.push('token');
  }
  if (graphRef !== undefined) {
    allowed.push('graphRef');
  }
  assertExactFields(body, allowed, 'answer request');
  const graphId = requireStringField(body, 'graphId', 'graphId', MAX_ID_LENGTH);
  const nodeId = requireStringField(body, 'nodeId', 'nodeId', MAX_ID_LENGTH);
  if (!Object.hasOwn(body, 'value') || body['value'] === undefined) {
    throw new HttpError(400, 'bad-request', "missing field 'value' in answer request");
  }
  let tokenValue: string | undefined;
  if (token !== undefined) {
    tokenValue = requireStringField(body, 'token', 'token', MAX_TOKEN_LENGTH);
  }
  let graphRefValue: string | undefined;
  if (graphRef !== undefined) {
    graphRefValue = requireStringField(body, 'graphRef', 'graphRef', MAX_GRAPH_REF_LENGTH);
    if (graphRefValue.trim() === '') {
      throw new HttpError(400, 'bad-request', 'graphRef must not be blank');
    }
  }
  return {
    graphId,
    nodeId,
    value: body['value'] as Value,
    ...(tokenValue === undefined ? {} : { token: tokenValue }),
    ...(graphRefValue === undefined ? {} : { graphRef: graphRefValue }),
  };
}

export function parseUnloadBody(body: Record<string, unknown>): string {
  assertExactFields(body, ['graphId'], 'unload request');
  return requireStringField(body, 'graphId', 'graphId', MAX_ID_LENGTH);
}

export function parseSessionCloseBody(body: Record<string, unknown>): string {
  assertExactFields(body, ['sessionId'], 'session close request');
  return requireStringField(body, 'sessionId', 'sessionId', MAX_ID_LENGTH);
}

export function parseJsonObject(body: Buffer): Record<string, unknown> {
  if (body.length === 0) {
    throw new HttpError(400, 'bad-request', 'request body must be a JSON object');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    throw new HttpError(400, 'bad-request', 'request body is not valid JSON');
  }
  if (!isRecord(parsed)) {
    throw new HttpError(400, 'bad-request', 'request body must be a JSON object');
  }
  return parsed;
}

export function parseBindings(value: unknown): GraphBindings {
  if (!isRecord(value)) {
    throw new HttpError(400, 'bad-request', 'bindings must be an object');
  }
  for (const raw of Object.values(value)) {
    if (!isRecord(raw)) {
      throw new HttpError(400, 'bad-request', 'each binding must be an object');
    }
    const kind = raw['kind'];
    if (kind === 'session') {
      assertExactFields(raw, ['kind', 'sessionId'], 'binding');
    } else if (kind === 'fresh') {
      assertExactFields(raw, ['kind', 'mode', 'model', 'reasoning', 'harness'], 'binding');
    } else {
      throw new HttpError(400, 'bad-request', "binding kind must be 'session' or 'fresh'");
    }
  }
  // Semantic validation stays in GraphHost's binding layer; this only
  // enforces the request schema before a session can be created.
  return value as unknown as GraphBindings;
}

export function requirePayload(
  payload: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (payload === undefined) {
    throw new HttpError(400, 'bad-request', 'request body must be a JSON object');
  }
  return payload;
}

export function assertExactFields(
  record: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      // The field name is not echoed: it is attacker-controlled and this
      // response is part of the no-body/no-token surface.
      throw new HttpError(400, 'bad-request', `${label}: unknown field`);
    }
  }
}

export function validatePort(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 65_535) {
    throw new TypeError('port must be an integer between 0 and 65535');
  }
  return value;
}

export function validateMaxBodyBytes(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError('maxBodyBytes must be a positive integer');
  }
  return value;
}

export function validateNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative integer`);
  }
  return value;
}

export function validatePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive integer`);
  }
  return value;
}

export function requireConfigString(value: unknown, field: string, maxLength: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new TypeError(
      `${field} must be a non-empty string of at most ${String(maxLength)} characters`,
    );
  }
  return value;
}

function parseProject(value: unknown): Project {
  if (!isRecord(value)) {
    throw new HttpError(400, 'bad-request', 'project must be an object');
  }
  assertExactFields(value, ['id', 'directory'], 'project');
  const id = requireStringField(value, 'id', 'project.id', 256);
  const directory = requireStringField(value, 'directory', 'project.directory', 4_096);
  return { id, directory };
}

function parseOptionalNonNegativeInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new HttpError(400, 'bad-request', `${field} must be a non-negative integer`);
  }
  return value;
}

function requireBodyField(
  body: Record<string, unknown>,
  key: string,
  label: string,
): unknown {
  if (!Object.hasOwn(body, key)) {
    throw new HttpError(400, 'bad-request', `${label}: missing field '${key}'`);
  }
  return body[key];
}

function requireStringField(
  record: Record<string, unknown>,
  key: string,
  field: string,
  maxLength: number,
): string {
  const value = record[key];
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new HttpError(
      400,
      'bad-request',
      `${field} must be a non-empty string of at most ${String(maxLength)} characters`,
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
