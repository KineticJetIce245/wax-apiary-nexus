import type { NodeId, NodeState, RuntimeRunObserver } from './types.js';

export type TracePresenceState = 'present' | 'parked' | 'settled';

export interface TracePresenceHost {
  readonly states: ReadonlyMap<NodeId, NodeState>;
  readonly onRun?: RuntimeRunObserver;
  /** Recomputes the aggregate Rest flag after the field emptied. */
  refreshRest(): void;
}

/**
 * Tracks whether a trace still has live, parked or settled work, and reports
 * that classification through the run observer. The runtime owns the field;
 * this class owns only the trace-presence bookkeeping that used to live inline
 * in `PheromoneRuntime`.
 */
export class TracePresence {
  /**
   * Activations removed from a mailbox but not yet visible as `active`.
   * A trace with a non-zero count is present even before the executor runs.
   */
  private readonly inFlight = new Map<string, number>();

  constructor(private readonly host: TracePresenceHost) {}

  addInFlight(traceId: string): void {
    this.inFlight.set(traceId, (this.inFlight.get(traceId) ?? 0) + 1);
  }

  endInFlight(traceId: string): void {
    const count = (this.inFlight.get(traceId) ?? 0) - 1;
    if (count <= 0) {
      this.inFlight.delete(traceId);
    } else {
      this.inFlight.set(traceId, count);
    }
  }

  /**
   * Reports the trace's current classification and returns it. A trace with
   * no live or parked work is `settled`; callers use that edge to release
   * per-trace resources (the trace-limit budget).
   */
  notify(traceId: string): TracePresenceState {
    const state = this.stateOf(traceId);
    if (state === 'settled') {
      this.host.refreshRest();
      this.host.onRun?.settled?.(traceId);
    } else if (state === 'parked') {
      this.host.onRun?.parked?.(traceId);
    } else {
      this.host.onRun?.present?.(traceId);
    }
    return state;
  }

  stateOf(traceId: string): TracePresenceState {
    if ((this.inFlight.get(traceId) ?? 0) > 0 || this.traceInField(traceId)) {
      return 'present';
    }
    return this.traceParked(traceId) ? 'parked' : 'settled';
  }

  private traceInField(traceId: string): boolean {
    for (const state of this.host.states.values()) {
      if (this.nodeHoldsTrace(state, traceId)) {
        return true;
      }
    }
    return false;
  }

  private nodeHoldsTrace(state: NodeState, traceId: string): boolean {
    if (state.active?.traceId === traceId || state.pending?.traceId === traceId) {
      return true;
    }
    if ((state.queue ?? []).some((pheromone) => pheromone.traceId === traceId)) {
      return true;
    }
    if (state.joins === undefined) {
      return false;
    }
    for (const join of state.joins.values()) {
      for (const arrived of join.arrived.values()) {
        if (arrived.traceId === traceId) {
          return true;
        }
      }
    }
    return false;
  }

  private traceParked(traceId: string): boolean {
    for (const state of this.host.states.values()) {
      if (state.hoverPheromone?.traceId === traceId) {
        return true;
      }
    }
    return false;
  }
}
