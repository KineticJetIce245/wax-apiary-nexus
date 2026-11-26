/**
 * Helpers for the gather state owned by one gather bee.
 *
 * Assemble keeps one open group per key (a single FIFO group when the config
 * has no `groupBy`), batch keeps one accumulated queue per declared type, and a
 * closed keyed group is remembered as a tombstone so its key cannot reopen.
 * Tombstone retention is the temporary §4.13 bound: the newest 64 markers, one
 * hour.
 */

import {
  DEFAULT_GATHER_TOMBSTONE_MAX,
  DEFAULT_GATHER_TOMBSTONE_TTL_MS,
} from './definition-constants.js';
import type {
  GatherState,
  GatherStateSnapshot,
  GatherTypeConfig,
  JsonValue,
} from './types.js';

/** The empty state for one strategy; a batch state starts with its queues. */
export function createGatherState(
  strategy: 'assemble' | 'batch',
  typeNames: readonly string[],
): GatherState {
  if (strategy === 'batch') {
    return { strategy, groups: [], tombstones: [], batch: createTypeQueues(typeNames) };
  }
  return { strategy, groups: [], tombstones: [] };
}

/** Creates one empty queue per declared type, in declaration order. */
export function createTypeQueues(typeNames: readonly string[]): Record<string, JsonValue[]> {
  const queues: Record<string, JsonValue[]> = {};
  for (const name of typeNames) {
    queues[name] = [];
  }
  return queues;
}

/** The declared type names, in config order. */
export function gatherTypeNames(types: Readonly<Record<string, GatherTypeConfig>>): string[] {
  return Object.keys(types);
}

/** True when the state carries nothing that must survive a snapshot. */
export function isEmptyGatherState(state: GatherState): boolean {
  return (
    state.groups.length === 0 &&
    state.tombstones.length === 0 &&
    !hasQueuedEntries(state.batch)
  );
}

/** True when at least one batch queue holds an entry. */
export function hasQueuedEntries(
  queues: Readonly<Record<string, readonly JsonValue[]>> | undefined,
): boolean {
  if (queues === undefined) {
    return false;
  }
  return Object.values(queues).some((queue) => queue.length > 0);
}

/** Rest is blocked by an open assemble group or a non-empty batch queue. */
export function gatherBlocksRest(state: GatherState | undefined): boolean {
  if (state === undefined) {
    return false;
  }
  return state.groups.length > 0 || hasQueuedEntries(state.batch);
}

/**
 * Gather records for inspect: open assemble groups plus closed tombstones; a
 * batch accumulator counts as one record while it holds input.
 */
export function gatherRecordCount(state: GatherStateSnapshot | undefined): number {
  if (state === undefined) {
    return 0;
  }
  if (state.strategy === 'batch') {
    return hasQueuedEntries(state.batch) ? 1 : 0;
  }
  return state.groups.length + state.tombstones.length;
}

/**
 * Drops closed-group markers past the temporary retention: older than one hour
 * or beyond the newest 64. Called on gather activity and on restore.
 */
export function pruneGatherTombstones(state: GatherState, now: number): void {
  const oldest = now - DEFAULT_GATHER_TOMBSTONE_TTL_MS;
  state.tombstones = state.tombstones.filter((tombstone) =>
    isRetained(tombstone.closedAt, oldest),
  );
  if (state.tombstones.length > DEFAULT_GATHER_TOMBSTONE_MAX) {
    state.tombstones = state.tombstones.slice(-DEFAULT_GATHER_TOMBSTONE_MAX);
  }
}

function isRetained(closedAt: string, oldest: number): boolean {
  const at = Date.parse(closedAt);
  return Number.isFinite(at) && at >= oldest;
}

/** Deep copy for the read-only snapshot and for `field.json`. */
export function cloneGatherState(state: GatherState): GatherStateSnapshot {
  return structuredClone(state) as GatherStateSnapshot;
}
