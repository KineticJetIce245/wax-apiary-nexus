/**
 * Gather: one receptor plus per-type queues, with two strategies (ARCH §4.13).
 *
 * `assemble` waits until every declared type reaches its count, then emits one
 * package `{ type: [entries] }` immediately. A group has an exact capacity of
 * `count` entries per type: a keyed group rejects a further entry for a full
 * type, and a FIFO input joins the oldest group that still needs that type.
 * `typeQueueMax` bounds one type across every open group.
 *
 * `batch` checks `batch.signal` first. A matching input is consumed as the flush
 * signal and one package is built from everything accumulated; otherwise the
 * input joins its type queue.
 *
 * Both strategies are field state: open groups/queues persist with the field and
 * a restored state continues waiting. A typed error drops only the incoming
 * input; the queues it did not enter are untouched.
 */

import type { EngineContext } from './engine-context.js';
import { evaluateGroupKey, matchesRule } from './definition-rules.js';
import { emitAlong } from './emit.js';
import { GatherInputError } from './errors.js';
import {
  createGatherState,
  createTypeQueues,
  gatherTypeNames,
  pruneGatherTombstones,
} from './gather-state.js';
import { stateOf } from './queue.js';
import { cloneJson, getPath, setReadPath } from './value-paths.js';
import type {
  AssembleGatherConfig,
  BatchGatherConfig,
  GatherGroup,
  GatherNode,
  GatherState,
  GatherTypeConfig,
  JsonValue,
  NodeState,
  Pheromone,
  Value,
} from './types.js';

/** Runs one gather activation: queue the input, or emit a completed package. */
export function runGather(
  ctx: EngineContext,
  node: GatherNode,
  pheromone: Pheromone,
): string {
  const nodeState = stateOf(ctx.queue, node.id);
  const existing = nodeState.gather;
  if (existing !== undefined && existing.strategy !== node.config.strategy) {
    throw new GatherInputError(
      `gather '${node.id}' state strategy '${existing.strategy}' does not match its config`,
    );
  }
  const gather =
    existing ?? createGatherState(node.config.strategy, gatherTypeNames(node.config.types));
  nodeState.gather = gather;
  pruneGatherTombstones(gather, ctx.now());
  return node.config.strategy === 'batch'
    ? runBatch(ctx, node, node.config, nodeState, gather, pheromone.value)
    : runAssemble(ctx, node, node.config, nodeState, gather, pheromone.value);
}

function runAssemble(
  ctx: EngineContext,
  node: GatherNode,
  config: AssembleGatherConfig,
  nodeState: NodeState,
  gather: GatherState,
  value: Value,
): string {
  const label = `gather '${node.id}'`;
  const key =
    config.groupBy === undefined ? undefined : evaluateGroupKey(config.groupBy, value, label);
  if (key !== undefined && gather.tombstones.some((tombstone) => tombstone.key === key)) {
    throw new GatherInputError(`${label} group '${key}' is closed`);
  }
  const typeName = matchOneType(config.types, value, label);
  const type = config.types[typeName];
  if (type === undefined) {
    throw new GatherInputError(`${label} has no type '${typeName}'`);
  }
  const entry = projectEntry(value, type.reads, `${label} type '${typeName}'`);
  // typeQueueMax bounds one type across every open group; a full type drops the
  // input before it can create or touch a group.
  assertTypeQueueRoom(gather, config.typeQueueMax, typeName, label);
  const group = placeInGroup(gather, config.types, typeName, type.count, key, label);
  requireTypeQueue(group, typeName, `${label} type '${typeName}'`).push(entry);
  if (!isGroupComplete(group, config.types)) {
    return 'queued';
  }
  closeGroup(gather, group, ctx.now(), ctx.iso());
  deliverPackage(ctx, node, nodeState, buildPackage(config.types, group.entries));
  return 'assembled';
}

function runBatch(
  ctx: EngineContext,
  node: GatherNode,
  config: BatchGatherConfig,
  nodeState: NodeState,
  gather: GatherState,
  value: Value,
): string {
  const label = `gather '${node.id}'`;
  if (matchesRule(config.batch.signal, value, `${label} batch signal`)) {
    const typeNames = gatherTypeNames(config.types);
    const packageValue = buildPackage(config.types, batchQueues(gather, typeNames));
    gather.batch = createTypeQueues(typeNames);
    deliverPackage(ctx, node, nodeState, packageValue);
    return 'flushed';
  }
  const typeName = matchOneType(config.types, value, label);
  const entry = projectEntry(
    value,
    config.types[typeName]?.reads ?? [],
    `${label} type '${typeName}'`,
  );
  const queues = batchQueues(gather, gatherTypeNames(config.types));
  const queue = queues[typeName];
  if (queue === undefined) {
    throw new GatherInputError(`${label} has no queue for type '${typeName}'`);
  }
  if (queue.length >= config.typeQueueMax) {
    throw new GatherInputError(
      `${label} type '${typeName}' queue is full (limit ${String(config.typeQueueMax)})`,
    );
  }
  queue.push(entry);
  return 'accumulated';
}

function batchQueues(
  gather: GatherState,
  typeNames: readonly string[],
): Record<string, JsonValue[]> {
  const queues = gather.batch ?? createTypeQueues(typeNames);
  gather.batch = queues;
  return queues;
}

function matchOneType(
  types: Readonly<Record<string, GatherTypeConfig>>,
  value: Value,
  label: string,
): string {
  let matched: string | undefined;
  for (const [name, type] of Object.entries(types)) {
    if (!matchesRule(type.match, value, `${label} type '${name}'`)) {
      continue;
    }
    if (matched !== undefined) {
      throw new GatherInputError(
        `${label} input is ambiguous between '${matched}' and '${name}'`,
      );
    }
    matched = name;
  }
  if (matched === undefined) {
    throw new GatherInputError(`${label} input matches no declared type`);
  }
  return matched;
}

/** One read path yields the scalar; several yield a nested object. */
function projectEntry(value: Value, reads: readonly string[], label: string): JsonValue {
  if (reads.length === 1) {
    const path = reads[0];
    if (path !== undefined) {
      return readRequired(value, path, label);
    }
  }
  const entry: Value = {};
  for (const path of reads) {
    setReadPath(entry, path, readRequired(value, path, label));
  }
  return entry;
}

function readRequired(value: Value, path: string, label: string): JsonValue {
  const found = getPath(value, path);
  if (!found.found) {
    throw new GatherInputError(`${label} is missing read path '${path}'`);
  }
  return cloneJson(found.value as JsonValue);
}

/** Entries already held for one type, across every open group. */
function assertTypeQueueRoom(
  gather: GatherState,
  typeQueueMax: number,
  typeName: string,
  label: string,
): void {
  let held = 0;
  for (const group of gather.groups) {
    held += typeQueueLength(group, typeName);
  }
  if (held >= typeQueueMax) {
    throw new GatherInputError(
      `${label} type '${typeName}' queue is full (limit ${String(typeQueueMax)})`,
    );
  }
}

/**
 * Picks the group for one input with an exact per-type capacity: a keyed group
 * by key (a full type in it is a typed drop), otherwise the oldest FIFO group
 * that still needs the type, otherwise a new group. `count` is never exceeded,
 * so a completed package holds exactly `count` entries per type.
 */
function placeInGroup(
  gather: GatherState,
  types: Readonly<Record<string, GatherTypeConfig>>,
  typeName: string,
  count: number,
  key: string | undefined,
  label: string,
): GatherGroup {
  if (key !== undefined) {
    const existing = gather.groups.find((group) => group.key === key);
    if (existing === undefined) {
      return createAndPushGroup(gather, key, types);
    }
    if (typeQueueLength(existing, typeName) >= count) {
      throw new GatherInputError(
        `${label} keyed group '${key}' already holds ${String(count)} '${typeName}' entries`,
      );
    }
    return existing;
  }
  const candidate = gather.groups.find(
    (group) => typeQueueLength(group, typeName) < count,
  );
  return candidate ?? createAndPushGroup(gather, undefined, types);
}

function typeQueueLength(group: GatherGroup, typeName: string): number {
  return group.entries[typeName]?.length ?? 0;
}

function createAndPushGroup(
  gather: GatherState,
  key: string | undefined,
  types: Readonly<Record<string, GatherTypeConfig>>,
): GatherGroup {
  const group: GatherGroup = { entries: createTypeQueues(gatherTypeNames(types)) };
  if (key !== undefined) {
    group.key = key;
  }
  gather.groups.push(group);
  return group;
}

function requireTypeQueue(group: GatherGroup, typeName: string, label: string): JsonValue[] {
  const queue = group.entries[typeName];
  if (queue === undefined) {
    throw new GatherInputError(`${label} has no queue for type '${typeName}'`);
  }
  return queue;
}

function isGroupComplete(
  group: GatherGroup,
  types: Readonly<Record<string, GatherTypeConfig>>,
): boolean {
  return Object.entries(types).every(
    ([name, type]) => (group.entries[name]?.length ?? 0) >= type.count,
  );
}

/** Closes one group: it leaves the open list, and a key becomes a tombstone. */
function closeGroup(
  gather: GatherState,
  group: GatherGroup,
  now: number,
  closedAt: string,
): void {
  gather.groups = gather.groups.filter((entry) => entry !== group);
  if (group.key !== undefined) {
    gather.tombstones.push({ key: group.key, closedAt });
  }
  pruneGatherTombstones(gather, now);
}

/** One package: every declared type key maps to its accumulated entries. */
function buildPackage(
  types: Readonly<Record<string, GatherTypeConfig>>,
  queues: Readonly<Record<string, readonly JsonValue[]>>,
): Value {
  const packageValue: Value = {};
  for (const name of Object.keys(types)) {
    packageValue[name] = cloneJson([...(queues[name] ?? [])]);
  }
  return packageValue;
}

/** A package is the Bee's output; it then moves along the one outgoing edge. */
function deliverPackage(
  ctx: EngineContext,
  node: GatherNode,
  nodeState: NodeState,
  packageValue: Value,
): void {
  nodeState.lastOutput = cloneJson(packageValue);
  emitAlong(ctx, node, { value: packageValue });
}
