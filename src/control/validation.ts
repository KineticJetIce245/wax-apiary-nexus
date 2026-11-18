import type { GuardDecision } from '../runtime/index.js';
import {
  MAX_ID_LENGTH,
  MAX_TOKEN_LENGTH,
} from './server-constants.js';
import {
  HttpError,
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
