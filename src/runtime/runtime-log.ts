import type { RuntimeLogEntry } from './log.js';
import type { RuntimeLogSink } from './runtime-expiry.js';
import { workerLogFields } from './runtime-values.js';
import type {
  MergeNode,
  NodeDefinition,
  NodeId,
  NodeState,
  Pheromone,
  UserNode,
} from './types.js';
import { WorkerExecutionError } from './worker.js';

export function logActivated(
  log: RuntimeLogSink,
  node: NodeDefinition,
  pheromone: Pheromone,
  state: NodeState,
): void {
  log({
    event: 'node.activated',
    nodeId: node.id,
    nodeKind: node.kind,
    pheromoneId: pheromone.id,
    traceId: pheromone.traceId,
    queueDepth: state.queue?.length ?? 0,
    ...(pheromone.forkId === undefined ? {} : { forkId: pheromone.forkId }),
    ...(pheromone.branchId === undefined ? {} : { branchId: pheromone.branchId }),
  });
}

export function logCompleted(
  log: RuntimeLogSink,
  node: NodeDefinition,
  pheromone: Pheromone,
  durationMs: number,
  outcome: string,
  extra?: Partial<RuntimeLogEntry>,
): void {
  log({
    event: 'node.completed',
    nodeId: node.id,
    nodeKind: node.kind,
    pheromoneId: pheromone.id,
    traceId: pheromone.traceId,
    outcome,
    durationMs,
    ...(extra ?? {}),
  });
}

export function logFailed(
  log: RuntimeLogSink,
  node: NodeDefinition,
  pheromone: Pheromone,
  startedAt: number,
  now: number,
  error: unknown,
): void {
  log({
    event: 'node.failed',
    nodeId: node.id,
    nodeKind: node.kind,
    pheromoneId: pheromone.id,
    traceId: pheromone.traceId,
    outcome: 'failed',
    durationMs: now - startedAt,
    error: error instanceof Error ? error.message : String(error),
    ...(error instanceof WorkerExecutionError ? workerLogFields(error) : {}),
  });
}

/**
 * Logs a deferred activation once per source Pheromone. Retrying every 100ms
 * must not append a Honey line per attempt.
 */
export function logActivationBlocked(
  log: RuntimeLogSink,
  reported: Set<string>,
  node: NodeDefinition,
  pheromone: Pheromone,
  target: NodeId,
  queueDepth: number,
): void {
  const key = `activation\0${pheromone.id}\0${target}`;
  if (reported.has(key)) {
    return;
  }
  reported.add(key);
  log({
    event: 'pheromone.blocked',
    nodeId: node.id,
    nodeKind: node.kind,
    pheromoneId: pheromone.id,
    traceId: pheromone.traceId,
    queueDepth,
    outcome: `queue-max:${target}`,
  });
}

export function logHoverBlocked(
  log: RuntimeLogSink,
  reported: Set<string>,
  node: UserNode,
  pheromone: Pheromone,
  target: NodeId,
  details: { readonly queueDepth: number; readonly hoverOutcome: string },
): void {
  const key = `hover\0${pheromone.id}\0${target}`;
  if (reported.has(key)) {
    return;
  }
  reported.add(key);
  log({
    event: 'hover.blocked',
    nodeId: node.id,
    nodeKind: 'user',
    pheromoneId: pheromone.id,
    traceId: pheromone.traceId,
    queueDepth: details.queueDepth,
    outcome: `${details.hoverOutcome}:queue-max:${target}`,
  });
}

export function logMergeBlocked(
  log: RuntimeLogSink,
  reported: Set<string>,
  node: MergeNode,
  forkId: string,
  target: NodeId,
  queueDepth: number,
): void {
  const key = `merge\0${node.id}\0${forkId}\0${target}`;
  if (reported.has(key)) {
    return;
  }
  reported.add(key);
  log({
    event: 'merge.blocked',
    nodeId: node.id,
    nodeKind: 'merge',
    forkId,
    queueDepth,
    outcome: `queue-max:${target}`,
  });
}
