/**
 * Restore of the gather state persisted in `field.json` v2.
 *
 * `honey.ts` validates the JSON shape and fails closed on unknown fields. This
 * module cross-checks the saved state against the live gather config: strategy,
 * declared type names, queue bounds, group-key rules, tombstone shape and the
 * invariant that a completed group is emitted immediately and never persisted.
 * A mismatch fails closed; nothing is replayed.
 */

import { pruneGatherTombstones } from './gather-state.js';
import { FieldRestoreError } from './errors.js';
import type {
  AssembleGatherConfig,
  BatchGatherConfig,
  GatherGroup,
  GatherState,
  GatherStateSnapshot,
  GatherTombstone,
  GatherTypeConfig,
  JsonValue,
  NodeDefinition,
  NodeState,
} from './types.js';

/** Applies one persisted gather state to its node state, or fails closed. */
export function restoreGatherState(
  node: NodeDefinition,
  saved: GatherStateSnapshot,
  state: NodeState,
  now: number,
): void {
  if (node.kind !== 'gather') {
    fail(`persisted field has gather state for non-gather node '${node.id}'`);
  }
  if (!Array.isArray(saved.groups) || !Array.isArray(saved.tombstones)) {
    fail(`persisted gather '${node.id}' has a malformed group or tombstone list`);
  }
  if (saved.strategy !== node.config.strategy) {
    fail(
      `persisted gather '${node.id}' strategy '${saved.strategy}' ` +
        `does not match its config '${node.config.strategy}'`,
    );
  }
  state.gather =
    node.config.strategy === 'assemble'
      ? restoreAssemble(node.id, node.config, saved, now)
      : restoreBatch(node.id, node.config, saved);
}

function restoreAssemble(
  beeId: string,
  config: AssembleGatherConfig,
  saved: GatherStateSnapshot,
  now: number,
): GatherState {
  const groups = saved.groups.map((group, index) =>
    restoreGroup(beeId, config, group, index),
  );
  assertGroupKeys(beeId, config, groups);
  const tombstones = restoreTombstones(beeId, saved.tombstones);
  assertTombstoneKeys(beeId, config, groups, tombstones);
  assertTypeQueueTotals(beeId, config, groups);
  const state: GatherState = { strategy: 'assemble', groups, tombstones };
  pruneGatherTombstones(state, now);
  return state;
}

function restoreBatch(
  beeId: string,
  config: BatchGatherConfig,
  saved: GatherStateSnapshot,
): GatherState {
  if (saved.groups.length > 0 || saved.tombstones.length > 0) {
    fail(`persisted gather '${beeId}' is a batch accumulator but has groups or tombstones`);
  }
  const queues = saved.batch;
  if (queues === undefined) {
    fail(`persisted gather '${beeId}' has no batch queues`);
  }
  const restored = restoreQueues(beeId, config.types, queues, 'batch');
  assertBatchQueueBounds(beeId, config, restored);
  return {
    strategy: 'batch',
    groups: [],
    tombstones: [],
    batch: restored,
  };
}

function restoreGroup(
  beeId: string,
  config: AssembleGatherConfig,
  saved: GatherStateSnapshot['groups'][number],
  index: number,
): GatherGroup {
  const path = `persisted gather '${beeId}'.groups[${String(index)}]`;
  const entries = restoreQueues(beeId, config.types, saved.entries, path);
  assertGroupTypeCounts(beeId, config, entries, path);
  const group: GatherGroup = { entries };
  if (saved.key !== undefined) {
    if (typeof saved.key !== 'string' || saved.key.trim() === '') {
      fail(`${path}.key: expected a non-empty group key`);
    }
    group.key = saved.key;
  }
  if (isComplete(entries, config.types)) {
    fail(
      `${path}: every type already reached its count; a completed group is ` +
        'emitted immediately and is never persisted',
    );
  }
  return group;
}

function restoreQueues(
  beeId: string,
  types: Readonly<Record<string, GatherTypeConfig>>,
  saved: Readonly<Record<string, readonly JsonValue[]>>,
  path: string,
): Record<string, JsonValue[]> {
  const names = Object.keys(types);
  const savedNames = Object.keys(saved);
  if (savedNames.length !== names.length || names.some((name) => !Object.hasOwn(saved, name))) {
    fail(
      `persisted gather '${beeId}' (${path}): expected one queue per declared type ` +
        `(${names.join(', ')})`,
    );
  }
  const queues: Record<string, JsonValue[]> = {};
  for (const name of names) {
    const queue = saved[name];
    if (!Array.isArray(queue)) {
      fail(`persisted gather '${beeId}' (${path}.${name}): expected an entry array`);
    }
    queues[name] = structuredClone([...queue]);
  }
  return queues;
}

/**
 * An assemble group holds at most `count` entries per type; paying more means
 * the persisted field cannot come from this gather and fails closed.
 */
function assertGroupTypeCounts(
  beeId: string,
  config: AssembleGatherConfig,
  entries: Readonly<Record<string, readonly JsonValue[]>>,
  path: string,
): void {
  for (const [name, type] of Object.entries(config.types)) {
    const length = entries[name]?.length ?? 0;
    if (length > type.count) {
      fail(
        `persisted gather '${beeId}' (${path}.${name}): ` +
          `${String(length)} entries exceed count ${String(type.count)}`,
      );
    }
  }
}

/** Batch has no groups and no count: its queues keep the typeQueueMax bound. */
function assertBatchQueueBounds(
  beeId: string,
  config: BatchGatherConfig,
  queues: Readonly<Record<string, readonly JsonValue[]>>,
): void {
  for (const [name, queue] of Object.entries(queues)) {
    if (queue.length > config.typeQueueMax) {
      fail(
        `persisted gather '${beeId}' (batch.${name}): ${String(queue.length)} entries ` +
          `exceed typeQueueMax ${String(config.typeQueueMax)}`,
      );
    }
  }
}

/** typeQueueMax bounds one type across every open assemble group. */
function assertTypeQueueTotals(
  beeId: string,
  config: AssembleGatherConfig,
  groups: readonly GatherGroup[],
): void {
  const held: Record<string, number> = {};
  for (const group of groups) {
    for (const [name, queue] of Object.entries(group.entries)) {
      held[name] = (held[name] ?? 0) + queue.length;
    }
  }
  for (const [name, total] of Object.entries(held)) {
    if (total > config.typeQueueMax) {
      fail(
        `persisted gather '${beeId}' type '${name}' holds ${String(total)} entries ` +
          `across open groups, over typeQueueMax ${String(config.typeQueueMax)}`,
      );
    }
  }
}

function restoreTombstones(beeId: string, saved: readonly GatherTombstone[]): GatherTombstone[] {
  const seen = new Set<string>();
  return saved.map((tombstone, index) => {
    const path = `persisted gather '${beeId}'.tombstones[${String(index)}]`;
    if (typeof tombstone.key !== 'string' || tombstone.key.trim() === '') {
      fail(`${path}.key: expected a non-empty group key`);
    }
    if (seen.has(tombstone.key)) {
      fail(`${path}.key: duplicate closed group '${tombstone.key}'`);
    }
    if (
      typeof tombstone.closedAt !== 'string' ||
      !Number.isFinite(Date.parse(tombstone.closedAt))
    ) {
      fail(`${path}.closedAt: expected an ISO timestamp`);
    }
    seen.add(tombstone.key);
    return { key: tombstone.key, closedAt: tombstone.closedAt };
  });
}

function assertGroupKeys(
  beeId: string,
  config: AssembleGatherConfig,
  groups: readonly GatherGroup[],
): void {
  if (config.groupBy === undefined) {
    if (groups.length > 1 || groups.some((group) => group.key !== undefined)) {
      fail(`persisted gather '${beeId}' has keyed groups but its config has no groupBy`);
    }
    return;
  }
  const seen = new Set<string>();
  for (const group of groups) {
    if (group.key === undefined || seen.has(group.key)) {
      fail(
        `persisted gather '${beeId}' has a missing or duplicate group key ` +
          `('${group.key ?? ''}'); the config groups by key`,
      );
    }
    seen.add(group.key);
  }
}

function assertTombstoneKeys(
  beeId: string,
  config: AssembleGatherConfig,
  groups: readonly GatherGroup[],
  tombstones: readonly GatherTombstone[],
): void {
  if (config.groupBy === undefined && tombstones.length > 0) {
    fail(`persisted gather '${beeId}' has tombstones but its config has no groupBy`);
  }
  const closed = new Set(tombstones.map((tombstone) => tombstone.key));
  for (const group of groups) {
    if (group.key !== undefined && closed.has(group.key)) {
      fail(`persisted gather '${beeId}' has an open and closed group for key '${group.key}'`);
    }
  }
}

function isComplete(
  entries: Readonly<Record<string, readonly JsonValue[]>>,
  types: Readonly<Record<string, GatherTypeConfig>>,
): boolean {
  return Object.entries(types).every(
    ([name, type]) => (entries[name]?.length ?? 0) === type.count,
  );
}

function fail(message: string): never {
  throw new FieldRestoreError(message);
}
