import type { SweepSessionsReport } from '../session/session-registry.js';
import { ControlClientError } from './client-errors.js';

const MAX_ID_LENGTH = 512;

/**
 * One session as exposed by the control channel. It is deliberately routing
 * metadata only: a native id, project directory, prompt, output or token is
 * never part of this shape.
 */
export interface SessionSummary {
  readonly sessionId: string;
  readonly harness: string;
  readonly projectId: string;
  readonly busy: boolean;
  readonly bound: boolean;
}

export function parseSweepSessionsReport(value: unknown): SweepSessionsReport {
  if (!isRecord(value)) {
    throw invalidSweepReport();
  }
  const closed = parseSessionIdList(value['closed']);
  const skipped = parseSessionIdList(value['skipped']);
  if (!Array.isArray(value['failed'])) {
    throw invalidSweepReport();
  }
  const failed: { readonly sessionId: string; readonly error: string }[] = [];
  for (const entry of value['failed']) {
    if (!isRecord(entry)) {
      throw invalidSweepReport();
    }
    const sessionId = entry['sessionId'];
    const error = entry['error'];
    if (!isBoundedString(sessionId, MAX_ID_LENGTH) || !isBoundedString(error, 1_024)) {
      throw invalidSweepReport();
    }
    failed.push({ sessionId, error });
  }
  return { closed, skipped, failed };
}

function parseSessionIdList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw invalidSweepReport();
  }
  return value.map((entry) => {
    if (!isBoundedString(entry, MAX_ID_LENGTH)) {
      throw invalidSweepReport();
    }
    return entry;
  });
}

function invalidSweepReport(): ControlClientError {
  return new ControlClientError('control response contained an invalid session sweep report', {
    code: 'protocol',
  });
}

export function parseSessionSummary(value: unknown): SessionSummary {
  if (!isRecord(value)) {
    throw invalidSessionSummary();
  }
  const sessionId = value['sessionId'];
  const harness = value['harness'];
  const projectId = value['projectId'];
  const busy = value['busy'];
  const bound = value['bound'];
  if (
    !isBoundedString(sessionId, MAX_ID_LENGTH) ||
    !isBoundedString(harness, MAX_ID_LENGTH) ||
    !isBoundedString(projectId, MAX_ID_LENGTH) ||
    typeof busy !== 'boolean' ||
    typeof bound !== 'boolean'
  ) {
    throw invalidSessionSummary();
  }
  return { sessionId, harness, projectId, busy, bound };
}

function invalidSessionSummary(): ControlClientError {
  return new ControlClientError('control response contained an invalid session summary', {
    code: 'protocol',
  });
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
