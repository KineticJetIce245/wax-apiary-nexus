import { sweepErrorMessage } from './session-errors.js';
import type {
  SessionRecord,
  SweepSessionsOptions,
  SweepSessionsReport,
} from './session-types.js';

/** Read/close surface the idle sweep needs; the registry supplies it. */
export interface SessionSweepAccess {
  all(): readonly SessionRecord[];
  nowIso(): string;
  isBusy(sessionId: string): boolean;
  close(sessionId: string): Promise<void>;
}

/**
 * One idle sweep. It iterates a snapshot in insertion order and closes every
 * session that is not excluded, not busy and idle for at least `idleTtlMs`.
 * A close failure is collected and never aborts the rest of the pass, and an
 * unparsable timestamp is skipped rather than treated as expired.
 *
 * Bound sessions are not known here: the caller passes them in `exclude`.
 * `fresh_once` mappings are untouched; a stale mapping self-heals on the next
 * load (existing behavior).
 */
export async function sweepIdleSessions(
  access: SessionSweepAccess,
  options: SweepSessionsOptions,
): Promise<SweepSessionsReport> {
  const closed: string[] = [];
  const skipped: string[] = [];
  const failed: { sessionId: string; error: string }[] = [];
  if (!Number.isFinite(options.idleTtlMs) || options.idleTtlMs <= 0) {
    return { closed, skipped, failed };
  }

  const nowMs = Date.parse((options.now ?? (() => access.nowIso()))());
  const exclude = options.exclude;

  // Snapshot first: `close` mutates the record store. The snapshot keeps the
  // pass's decision order stable and lets a concurrent close surface as a
  // failure.
  for (const record of access.all()) {
    const sessionId = record.sessionId;
    if (exclude?.has(sessionId) === true) {
      skipped.push(sessionId);
      continue;
    }
    // Busy is checked before the TTL so a running session is never a candidate,
    // even if `close` would also refuse it.
    if (access.isBusy(sessionId)) {
      skipped.push(sessionId);
      continue;
    }
    const lastAccessMs = Date.parse(record.lastAccessAt);
    if (!Number.isFinite(nowMs) || !Number.isFinite(lastAccessMs)) {
      skipped.push(sessionId);
      continue;
    }
    if (nowMs - lastAccessMs < options.idleTtlMs) {
      skipped.push(sessionId);
      continue;
    }
    try {
      await access.close(sessionId);
      closed.push(sessionId);
    } catch (error) {
      failed.push({ sessionId, error: sweepErrorMessage(error) });
    }
  }

  return { closed, skipped, failed };
}
