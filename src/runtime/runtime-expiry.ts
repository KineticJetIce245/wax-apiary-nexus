/**
 * Per-entry queue TTL helpers. The receptor entry owns `enqueuedAt`; pending
 * and active Pheromones carry no timestamp and are never expired.
 */
import type { QueueEntry } from './types.js';

/** True when a queue entry has waited at least `ttlMs` since `enqueuedAt`. */
export function isEntryExpired(entry: QueueEntry, now: number, ttlMs: number): boolean {
  const enqueuedAt = Date.parse(entry.enqueuedAt);
  if (!Number.isFinite(enqueuedAt)) {
    return false;
  }
  return now - enqueuedAt >= ttlMs;
}
