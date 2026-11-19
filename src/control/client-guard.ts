import type { GuardDecision } from '../runtime/index.js';
import { ControlClient, ControlClientError } from './client.js';
import type { PendingGuardSummary } from './guard-broker.js';

const MAX_ID_LENGTH = 512;
const MAX_SUMMARY_LENGTH = 4_096;

/**
 * Typed native-guard client. It extends the established loopback-only,
 * single-attempt control client, so discovery, the bearer token and the
 * timeout stay in one place.
 *
 * `listGuards` exposes pending metadata only: the control surface never
 * carries a prompt, tool payload, output or token. `decideGuard` performs one
 * attempt; a conflict or an expired request is never retried.
 */
export class GuardClient extends ControlClient {
  async listGuards(): Promise<readonly PendingGuardSummary[]> {
    const body = await this.request('GET', '/guards');
    const value = body['guards'];
    if (!Array.isArray(value)) {
      throw protocolError("control response missing 'guards' array");
    }
    return value.map((entry) => parseGuardSummary(entry));
  }

  /** `POST /guard/decide`; the server confirms the exact request and decision. */
  async decideGuard(requestId: string, decision: GuardDecision): Promise<void> {
    const body = await this.request('POST', '/guard/decide', { requestId, decision });
    if (body['requestId'] !== requestId || body['decision'] !== decision) {
      throw protocolError('control response did not confirm the guard decision');
    }
  }
}

function parseGuardSummary(value: unknown): PendingGuardSummary {
  if (!isRecord(value)) {
    throw invalidGuardSummary();
  }
  const requestId = value['requestId'];
  const executionId = value['executionId'];
  const summary = value['summary'];
  const options = value['options'];
  const createdAt = value['createdAt'];
  if (
    !isBoundedString(requestId, MAX_ID_LENGTH) ||
    !isBoundedString(executionId, MAX_ID_LENGTH) ||
    !isSummary(summary) ||
    !isBoundedString(createdAt, MAX_ID_LENGTH) ||
    !Array.isArray(options)
  ) {
    throw invalidGuardSummary();
  }
  const parsedOptions: string[] = [];
  for (const option of options) {
    if (!isBoundedString(option, MAX_ID_LENGTH)) {
      throw invalidGuardSummary();
    }
    parsedOptions.push(option);
  }
  const liveId = optionalBoundedString(value, 'liveId');
  const beeId = optionalBoundedString(value, 'beeId');
  const sessionId = optionalBoundedString(value, 'sessionId');
  return {
    requestId,
    executionId,
    summary,
    options: parsedOptions,
    createdAt,
    ...(liveId === undefined ? {} : { liveId }),
    ...(beeId === undefined ? {} : { beeId }),
    ...(sessionId === undefined ? {} : { sessionId }),
  };
}

/**
 * Attribution is optional: an old daemon, or a guard raised outside a live,
 * omits it. A present but malformed id is a protocol error, not a missing id.
 */
function optionalBoundedString(
  value: Record<string, unknown>,
  field: string,
): string | undefined {
  const raw = value[field];
  if (raw === undefined) {
    return undefined;
  }
  if (!isBoundedString(raw, MAX_ID_LENGTH)) {
    throw invalidGuardSummary();
  }
  return raw;
}

/**
 * A summary is native tool metadata, so it may contain punctuation a native
 * harness put in a tool title. It must not carry NUL, and the CLI flattens
 * line breaks before printing it, so JSON stays the lossless form.
 */
function isSummary(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_SUMMARY_LENGTH &&
    !value.includes('\u0000')
  );
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function invalidGuardSummary(): ControlClientError {
  return protocolError('control response contained an invalid pending guard');
}

function protocolError(message: string): ControlClientError {
  return new ControlClientError(message, { code: 'protocol' });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
