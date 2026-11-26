import type { RuntimeLogEntry, RuntimeLogFieldsSink } from './log.js';
import { ReceptorFullError } from './receptor-overflow.js';
import { isEntryExpired } from './runtime-expiry.js';
import type {
  CompositionDefinition,
  NodeDefinition,
  NodeId,
  NodeState,
  Pheromone,
  QueueEntry,
  Value,
} from './types.js';

/** What a queue operation needs from the field engine. */
export interface QueueContext {
  readonly definition: CompositionDefinition;
  readonly states: ReadonlyMap<NodeId, NodeState>;
  readonly now: () => number;
  readonly log: RuntimeLogFieldsSink;
  /** Notified when capacity frees (block-policy waiters). */
  readonly notifyOverflow?: (nodeId: NodeId) => void;
}

/** The partial entry shape the runtime log accepts. */
export type PartialLogEntry = Omit<
  RuntimeLogEntry,
  'at' | 'compositionId' | 'graphRevision'
>;

export function stateOf(ctx: QueueContext, nodeId: NodeId): NodeState {
  const state = ctx.states.get(nodeId);
  if (state === undefined) {
    throw new Error(`unknown node '${nodeId}'`);
  }
  return state;
}

export function requireNode(ctx: QueueContext, nodeId: NodeId): NodeDefinition {
  const node = ctx.definition.nodes.get(nodeId);
  if (node === undefined) {
    throw new Error(`unknown node '${nodeId}'`);
  }
  return node;
}

/** Waiting receptor entries only; active and pending never count. */
export function receptorDepth(state: NodeState): number {
  return state.receptor?.length ?? 0;
}

/** Waiting entries plus output reservations; the queueMax comparison basis. */
export function queueDepth(state: NodeState): number {
  return receptorDepth(state) + (state.reserved ?? 0);
}

/** Creates one queue entry; the entry is a Pheromone plus its enqueue instant. */
export function createEntry(value: Value, enqueuedAt: string): QueueEntry {
  return { value, enqueuedAt };
}

/**
 * Moves the receptor head into `pending` by reference: the pending slot holds
 * the very same object (and therefore the same `enqueuedAt`) until activation.
 */
export function stagePending(
  ctx: QueueContext,
  node: NodeDefinition,
  state: NodeState,
  waiting: boolean,
): boolean {
  if (state.pending !== undefined || (state.receptor?.length ?? 0) === 0) {
    return false;
  }
  const head = (state.receptor as QueueEntry[]).shift();
  if (head === undefined) {
    return false;
  }
  state.pending = head;
  if (waiting) {
    ctx.log({
      event: 'pheromone.pending',
      nodeId: node.id,
      nodeKind: node.kind,
      enqueuedAt: head.enqueuedAt,
      queueDepth: state.receptor?.length ?? 0,
    });
  }
  ctx.notifyOverflow?.(node.id);
  return true;
}

/**
 * Appends one entry and logs the handoff. A full receptor throws the typed
 * failure; the caller decides whether that is an HTTP 429 or a dropped move.
 */
export function appendEntry(
  ctx: QueueContext,
  nodeId: NodeId,
  entry: QueueEntry,
  event: 'pheromone.enqueued' | 'pheromone.emitted',
): void {
  const node = requireNode(ctx, nodeId);
  const state = stateOf(ctx, nodeId);
  const depth = queueDepth(state);
  if (depth >= ctx.definition.defaults.queueMax) {
    ctx.log({
      event: 'pheromone.rejected',
      nodeId,
      nodeKind: node.kind,
      enqueuedAt: entry.enqueuedAt,
      queueDepth: depth,
      limit: ctx.definition.defaults.queueMax,
      policy: 'reject',
      outcome: 'queue-max',
    });
    throw new ReceptorFullError(nodeId, ctx.definition.defaults.queueMax, depth, {
      liveId: ctx.definition.id,
    });
  }
  (state.receptor ?? (state.receptor = [])).push(entry);
  ctx.log({
    event,
    nodeId,
    nodeKind: node.kind,
    enqueuedAt: entry.enqueuedAt,
    queueDepth: depth + 1,
  });
  ctx.notifyOverflow?.(nodeId);
}

/** Appends only when capacity exists; used by the block-policy waiter path. */
export function tryAppendEntry(ctx: QueueContext, nodeId: NodeId, entry: QueueEntry): boolean {
  const state = stateOf(ctx, nodeId);
  if (queueDepth(state) >= ctx.definition.defaults.queueMax) {
    return false;
  }
  appendEntry(ctx, nodeId, entry, 'pheromone.enqueued');
  return true;
}

export interface OutputTarget {
  readonly targetId: NodeId;
  readonly count: number;
}

/**
 * Queue slots held for one activation's future output. Every target is
 * reserved before the source Pheromone is consumed, so a full queue can never
 * reject a result after its task already ran.
 */
export interface OutputReservation {
  readonly slots: Map<NodeId, number>;
}

export type ReserveOutcome =
  | { readonly ok: true; readonly reservation: OutputReservation }
  | { readonly ok: false; readonly target: NodeId; readonly queueDepth: number };

function queueAvailable(ctx: QueueContext, targetId: NodeId): number {
  return ctx.definition.defaults.queueMax - queueDepth(stateOf(ctx, targetId));
}

/**
 * Reserves every required slot atomically: if any target cannot take all of
 * its outputs, nothing is reserved and the caller keeps its input.
 */
export function tryReserve(
  ctx: QueueContext,
  targets: readonly OutputTarget[],
): ReserveOutcome {
  const needed = new Map<NodeId, number>();
  for (const { targetId, count } of targets) {
    if (!ctx.definition.nodes.has(targetId)) {
      throw new Error(`unknown edge target '${targetId}'`);
    }
    needed.set(targetId, (needed.get(targetId) ?? 0) + count);
  }
  for (const [targetId, count] of needed) {
    if (count > queueAvailable(ctx, targetId)) {
      return { ok: false, target: targetId, queueDepth: queueDepth(stateOf(ctx, targetId)) };
    }
  }
  const slots = new Map<NodeId, number>();
  for (const [targetId, count] of needed) {
    const state = stateOf(ctx, targetId);
    state.reserved = (state.reserved ?? 0) + count;
    slots.set(targetId, count);
  }
  return { ok: true, reservation: { slots } };
}

/** Gives back every slot this reservation still holds. */
export function releaseReservation(ctx: QueueContext, reservation: OutputReservation): void {
  for (const [targetId, count] of reservation.slots) {
    const state = stateOf(ctx, targetId);
    const reserved = (state.reserved ?? 0) - count;
    if (reserved <= 0) {
      delete state.reserved;
    } else {
      state.reserved = reserved;
    }
    ctx.notifyOverflow?.(targetId);
  }
  reservation.slots.clear();
}

/** Converts one reserved slot into an enqueued entry. */
export function consumeReservation(
  ctx: QueueContext,
  reservation: OutputReservation,
  targetId: NodeId,
): void {
  const held = reservation.slots.get(targetId);
  if (held === undefined || held <= 0) {
    throw new Error(`node '${targetId}' has no reserved output slot for this activation`);
  }
  const state = stateOf(ctx, targetId);
  const reserved = state.reserved ?? 0;
  if (reserved <= 0) {
    throw new Error(`node '${targetId}' lost its reserved output slot`);
  }
  if (reserved === 1) {
    delete state.reserved;
  } else {
    state.reserved = reserved - 1;
  }
  if (held === 1) {
    reservation.slots.delete(targetId);
  } else {
    reservation.slots.set(targetId, held - 1);
  }
}

/**
 * Drops receptor entries older than `defaults.queueTtlMs`, measured from the
 * queue entry's `enqueuedAt`. Pending and active are not receptor waits and are
 * never expired.
 */
export function expireOverdueQueues(ctx: QueueContext): void {
  for (const [nodeId, state] of ctx.states) {
    const node = ctx.definition.nodes.get(nodeId);
    if (node !== undefined) {
      expireReceptorOf(ctx, node, state);
    }
  }
}

function expireReceptorOf(
  ctx: QueueContext,
  node: NodeDefinition,
  state: NodeState,
): void {
  const receptor = state.receptor;
  if (receptor === undefined || receptor.length === 0) {
    return;
  }
  const ttlMs = ctx.definition.defaults.queueTtlMs;
  const now = ctx.now();
  const kept: QueueEntry[] = [];
  const expired: QueueEntry[] = [];
  for (const entry of receptor) {
    if (isEntryExpired(entry, now, ttlMs)) {
      expired.push(entry);
    } else {
      kept.push(entry);
    }
  }
  if (expired.length === 0) {
    return;
  }
  if (kept.length === 0) {
    delete state.receptor;
  } else {
    state.receptor = kept;
  }
  for (const entry of expired) {
    ctx.log({
      event: 'pheromone.expired',
      nodeId: node.id,
      nodeKind: node.kind,
      enqueuedAt: entry.enqueuedAt,
      queueDepth: kept.length,
      outcome: 'ttl',
    });
  }
  ctx.notifyOverflow?.(node.id);
}
