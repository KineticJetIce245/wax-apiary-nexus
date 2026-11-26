import type {
  RuntimeLogEntry,
  RuntimeLogFields,
  RuntimeLogFieldsSink,
} from './log.js';
import type { NodeDefinition, NodeId } from './types.js';
import { WorkerExecutionError } from './worker.js';
import { workerLogFields } from './runtime-values.js';

export function logActivated(
  log: RuntimeLogFieldsSink,
  node: NodeDefinition,
  queueDepth: number,
): void {
  log({
    event: 'node.activated',
    nodeId: node.id,
    nodeKind: node.kind,
    queueDepth,
  });
}

export function logCompleted(
  log: RuntimeLogFieldsSink,
  node: NodeDefinition,
  durationMs: number,
  outcome: string,
  extra?: Partial<RuntimeLogEntry>,
): void {
  log({
    event: 'node.completed',
    nodeId: node.id,
    nodeKind: node.kind,
    outcome,
    durationMs,
    ...(extra ?? {}),
  });
}

export function logFailed(
  log: RuntimeLogFieldsSink,
  node: NodeDefinition,
  startedAt: number,
  now: number,
  error: unknown,
): void {
  log({
    event: 'node.failed',
    nodeId: node.id,
    nodeKind: node.kind,
    outcome: 'failed',
    durationMs: now - startedAt,
    error: error instanceof Error ? error.message : String(error),
    ...(error instanceof WorkerExecutionError ? workerLogFields(error) : {}),
  });
}

/** Records an item dropped because its target was full (§9.2); never a body. */
export function logDropped(
  log: RuntimeLogFieldsSink,
  nodeId: NodeId,
  nodeKind: NodeDefinition['kind'],
  reason: string,
  details: {
    readonly enqueuedAt?: string;
    readonly queueDepth?: number;
    readonly limit?: number;
  } = {},
): void {
  log({
    event: 'pheromone.dropped',
    nodeId,
    nodeKind,
    outcome: reason,
    ...(details.enqueuedAt === undefined ? {} : { enqueuedAt: details.enqueuedAt }),
    ...(details.queueDepth === undefined ? {} : { queueDepth: details.queueDepth }),
    ...(details.limit === undefined ? {} : { limit: details.limit }),
  });
}

export function logHoverBlocked(
  log: RuntimeLogFieldsSink,
  reported: Set<string>,
  node: NodeDefinition,
  target: NodeId,
  details: { readonly queueDepth: number; readonly hoverOutcome: string },
): void {
  const key = `hover\0${node.id}\0${target}`;
  if (reported.has(key)) {
    return;
  }
  reported.add(key);
  log({
    event: 'hover.blocked',
    nodeId: node.id,
    nodeKind: node.kind,
    queueDepth: details.queueDepth,
    reason: `${details.hoverOutcome}:queue-max:${target}`,
  });
}

/** Records paths removed by a Bee filter; paths only, never values. */
export function logFiltered(
  log: RuntimeLogFieldsSink,
  node: NodeDefinition,
  paths: readonly string[],
): void {
  if (paths.length === 0) {
    return;
  }
  log({
    event: 'value.filtered',
    nodeId: node.id,
    nodeKind: node.kind,
    paths,
  });
}

/** Records paths whose drop found nothing; paths only, never values. */
export function logDropMissing(
  log: RuntimeLogFieldsSink,
  node: NodeDefinition,
  paths: readonly string[],
): void {
  if (paths.length === 0) {
    return;
  }
  log({
    event: 'value.drop-missing',
    nodeId: node.id,
    nodeKind: node.kind,
    paths,
    outcome: 'no-op',
  });
}

/** The partial log shape a module writes; the facade stamps the rest. */
export type PartialLogEntry = RuntimeLogFields;
