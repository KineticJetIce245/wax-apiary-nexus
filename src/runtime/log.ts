import type { NodeId, NodeKind } from './types.js';

export type RuntimeEvent =
  | 'pheromone.enqueued'
  | 'pheromone.pending'
  | 'pheromone.emitted'
  | 'pheromone.rejected'
  | 'pheromone.blocked'
  | 'pheromone.expired'
  | 'node.activated'
  | 'node.completed'
  | 'node.failed'
  | 'hover.opened'
  | 'hover.resolved'
  | 'hover.blocked'
  | 'hover.cancelled'
  | 'answer.applied'
  | 'answer.stale'
  | 'answer.malformed'
  | 'answer.blocked'
  | 'guard.opened'
  | 'guard.resolved'
  | 'guard.timeout'
  | 'input.queued'
  | 'merge.waiting'
  | 'merge.blocked'
  | 'merge.completed'
  | 'merge.timed-out'
  | 'merge.failed'
  | 'merge.optional-failed'
  | 'merge.optional-dropped'
  | 'runtime.restored'
  | 'runtime.attention'
  | 'runtime.rest'
  | 'scheduler.unconfirmed';

export interface RuntimeLogEntry {
  at: string;
  event: RuntimeEvent;
  compositionId: string;
  graphRevision: string;
  nodeId?: NodeId;
  nodeKind?: NodeKind;
  pheromoneId?: string;
  traceId?: string;
  forkId?: string;
  branchId?: string;
  queueDepth?: number;
  durationMs?: number;
  /** Answer-inbox id; the record's Value is never written to the log. */
  answerId?: string;
  /** Scheduled-trigger id for scheduler lifecycle entries. */
  triggerId?: string;
  /** The occurrence instant a scheduler entry refers to. */
  scheduledFor?: string;
  /** Worker program name only; never the full output body. */
  program?: string;
  pid?: number;
  stdoutBytes?: number;
  stderrBytes?: number;
  exitCode?: number;
  outcome?: string;
  error?: string;
  /** The composition log stores only this reference, never transcript bodies. */
  transcriptRef?: string;
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
