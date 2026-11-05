import type { NodeId, NodeKind } from './types.js';

export type RuntimeEvent =
  | 'pheromone.enqueued'
  | 'pheromone.pending'
  | 'pheromone.emitted'
  | 'node.activated'
  | 'node.completed'
  | 'node.failed'
  | 'hover.opened'
  | 'hover.resolved'
  | 'input.queued'
  | 'runtime.restored'
  | 'runtime.rest';

export interface RuntimeLogEntry {
  at: string;
  event: RuntimeEvent;
  compositionId: string;
  graphRevision: string;
  nodeId?: NodeId;
  nodeKind?: NodeKind;
  pheromoneId?: string;
  traceId?: string;
  queueDepth?: number;
  durationMs?: number;
  outcome?: string;
  error?: string;
}

export type RuntimeLogSink = (entry: RuntimeLogEntry) => void;

/** In-memory log sink for tests and for the future daemon shim. */
export function createMemoryLog(): { entries: RuntimeLogEntry[]; sink: RuntimeLogSink } {
  const entries: RuntimeLogEntry[] = [];
  return {
    entries,
    sink: (entry) => {
      entries.push(entry);
    },
  };
}
