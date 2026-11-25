import type { RuntimeLogEntry } from './log.js';
import type { RuntimeLogSink } from './runtime-expiry.js';
import { workerLogFields } from './runtime-values.js';
import type { NodeDefinition, NodeState, Pheromone } from './types.js';
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
