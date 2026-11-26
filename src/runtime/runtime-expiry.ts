import type { RuntimeLogEntry } from './log.js';
import type { CompositionDefinition, NodeKind, NodeState, Pheromone } from './types.js';

/** The partial event shape `PheromoneRuntime.log` accepts. */
export type RuntimeLogSink = (
  entry: Omit<RuntimeLogEntry, 'at' | 'compositionId' | 'graphRevision'>,
) => void;

/**
 * True when a queued Pheromone has waited at least `ttlMs` since its enqueue
 * instant (`Pheromone.at`). A timestamp that does not parse is never expired.
 */
function isOlderThan(pheromone: Pheromone, now: number, ttlMs: number): boolean {
  const enqueuedAt = Date.parse(pheromone.at);
  if (!Number.isFinite(enqueuedAt)) {
    return false;
  }
  return now - enqueuedAt >= ttlMs;
}

/**
 * Drops input that has waited at a node longer than `defaults.queueTtlMs`.
 *
 * Only the two wait slots can age out: `state.receptor` and `state.pending`.
 * `active`, hovers, merge arrivals and answers are live or externally bound
 * work and are never removed by the TTL. An expired Pheromone is dropped
 * outright - not failed and not retried - and its slot is released.
 * Reservations held for someone else's in-flight output are untouched.
 */
export function expireOverdueQueues(
  definition: CompositionDefinition,
  states: ReadonlyMap<string, NodeState>,
  now: number,
  log: RuntimeLogSink,
): void {
  const ttlMs = definition.defaults.queueTtlMs;
  for (const [id, state] of states) {
    const node = definition.nodes.get(id);
    if (node === undefined) {
      continue;
    }
    expireReceptor(node.id, node.kind, state, now, ttlMs, log);
    expirePending(node.id, node.kind, state, now, ttlMs, log);
  }
}

function expireReceptor(
  nodeId: string,
  nodeKind: NodeKind,
  state: NodeState,
  now: number,
  ttlMs: number,
  log: RuntimeLogSink,
): void {
  const receptor = state.receptor;
  if (receptor === undefined || receptor.length === 0) {
    return;
  }

  const kept: Pheromone[] = [];
  const expired: Pheromone[] = [];
  for (const pheromone of receptor) {
    if (isOlderThan(pheromone, now, ttlMs)) {
      expired.push(pheromone);
    } else {
      kept.push(pheromone);
    }
  }
  if (expired.length === 0) {
    return;
  }

  // The survivors keep their relative order: TTL cleanup never reorders the
  // FIFO, it only removes the aged-out entries.
  if (kept.length === 0) {
    delete state.receptor;
  } else {
    state.receptor = kept;
  }
  for (const pheromone of expired) {
    log({
      event: 'pheromone.expired',
      nodeId,
      nodeKind,
      pheromoneId: pheromone.id,
      queueDepth: kept.length,
      outcome: 'ttl',
    });
  }
}

function expirePending(
  nodeId: string,
  nodeKind: NodeKind,
  state: NodeState,
  now: number,
  ttlMs: number,
  log: RuntimeLogSink,
): void {
  const pending = state.pending;
  if (pending === undefined || !isOlderThan(pending, now, ttlMs)) {
    return;
  }
  delete state.pending;
  log({
    event: 'pheromone.expired',
    nodeId,
    nodeKind,
    pheromoneId: pending.id,
    queueDepth: state.receptor?.length ?? 0,
    outcome: 'ttl',
  });
}
