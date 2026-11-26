import type { NodeId, NodeKind } from './types.js';

export type RuntimeEvent =
  | 'pheromone.enqueued'
  | 'pheromone.pending'
  | 'pheromone.emitted'
  | 'pheromone.rejected'
  | 'pheromone.dropped'
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
  | 'value.filtered'
  | 'value.drop-missing'
  | 'runtime.restored'
  | 'runtime.attention'
  | 'runtime.rest'
  | 'scheduler.unconfirmed';

/**
 * One runtime log entry. It never carries a prompt, output, value body or
 * token: association is `compositionId` (the LiveHive), `nodeId` (the Bee),
 * the queue entry's `enqueuedAt`, a depth and a reason.
 */
export interface RuntimeLogEntry {
  at: string;
  event: RuntimeEvent;
  compositionId: string;
  graphRevision: string;
  nodeId?: NodeId;
  nodeKind?: NodeKind;
  /** The queue entry's enqueue instant; the only TTL clock. */
  enqueuedAt?: string;
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
  /** A short machine-readable reason; never a value body. */
  reason?: string;
  error?: string;
  /** Dot paths (never values) removed by a filter/drop. */
  paths?: readonly string[];
  /** The composition log stores only this reference, never transcript bodies. */
  transcriptRef?: string;
}

export type RuntimeLogSink = (entry: RuntimeLogEntry) => void;

/** The partial shape the runtime passes to a sink (filled by the facade). */
export type RuntimeLogFields = Omit<RuntimeLogEntry, 'at' | 'compositionId' | 'graphRevision'>;

/** A sink for partial entries; the facade stamps time/live/revision. */
export type RuntimeLogFieldsSink = (entry: RuntimeLogFields) => void;

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
