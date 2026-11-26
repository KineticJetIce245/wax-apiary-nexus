import type { NodeId, NodeKind } from './types.js';

export type RuntimeEvent =
  | 'pheromone.enqueued'
  | 'pheromone.pending'
  | 'pheromone.emitted'
  | 'pheromone.rejected'
  | 'pheromone.blocked'
  | 'pheromone.expired'
  | 'bee-receptor-blocked'
  | 'bee-receptor-block-timeout'
  | 'node.activated'
  | 'node.completed'
  | 'node.failed'
  | 'hover.opened'
  | 'hover.resolved'
  | 'hover.blocked'
  | 'hover.cancelled'
  | 'guard.opened'
  | 'guard.resolved'
  | 'guard.timeout'
  | 'gather.waiting'
  | 'gather.blocked'
  | 'gather.completed'
  | 'gather.timed-out'
  | 'gather.failed'
  | 'gather.optional-failed'
  | 'gather.optional-dropped'
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
  spreadId?: string;
  branchId?: string;
  queueDepth?: number;
  /** Per-bee receptor capacity for a limit entry. */
  limit?: number;
  /** Which overflow policy produced this entry. */
  policy?: 'reject' | 'block';
  /** How long a blocked admission waited before it was admitted or timed out. */
  waitedMs?: number;
  durationMs?: number;
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
