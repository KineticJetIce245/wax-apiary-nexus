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

/** Logs a deferred activation once per (Bee, target); retries do not spam. */
export function logActivationBlocked(
  log: RuntimeLogFieldsSink,
  reported: Set<string>,
  node: NodeDefinition,
  target: NodeId,
  queueDepth: number,
  limit: number,
): void {
  const key = `activation\0${node.id}\0${target}`;
  if (reported.has(key)) {
    return;
  }
  reported.add(key);
  log({
    event: 'pheromone.blocked',
    nodeId: node.id,
    nodeKind: node.kind,
    queueDepth,
    limit,
    reason: `queue-max:${target}`,
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
