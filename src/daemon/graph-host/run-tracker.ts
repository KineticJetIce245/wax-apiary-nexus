import type { Value, RuntimeRunObserver } from '../../runtime/index.js';
import type { RunOperation, RunOutput, RunRecord, RunStatus, RunStore } from '../../storage/run-store.js';
import type { LiveHiveId } from '../../graph/registry.js';
import type { NodeId } from '../../runtime/index.js';
import type { LiveHiveRunState, LiveHiveRunView } from './types.js';

export type RunObservation =
  | { readonly type: 'activated'; readonly traceId: string }
  | { readonly type: 'output'; readonly traceId: string; readonly nodeId: NodeId; readonly value: Value }
  | { readonly type: 'failed'; readonly traceId: string; readonly error: unknown }
  | { readonly type: 'settled'; readonly traceId: string }
  | { readonly type: 'parked'; readonly traceId: string }
  | { readonly type: 'present'; readonly traceId: string };

export interface RunTrackerOptions {
  readonly now: () => number;
  readonly runStore?: RunStore;
  readonly onSaveError?: (liveId: LiveHiveId, runId: string, error: unknown) => void;
}

export interface AcceptRunInput {
  readonly liveId: LiveHiveId;
  readonly runId: string;
  readonly traceId: string;
  readonly operation: RunOperation;
  readonly startedAt: string;
}

interface TrackedRun {
  readonly runId: string;
  readonly traceId: string;
  readonly liveId: LiveHiveId;
  readonly operation: RunOperation;
  readonly startedAt: string;
  state: LiveHiveRunState;
  outputs: RunOutput[];
  error?: string;
  failure?: unknown;
  finishedAt?: string;
  parked: boolean;
  traceSettled: boolean;
  readonly waiters: Set<() => void>;
  readonly settledWaiters: Set<() => void>;
}

const MAX_RETAINED_RUNS = 1_000;
const TERMINAL = new Set<LiveHiveRunState>(['completed', 'failed', 'cancelled', 'unknown']);

function isTerminalRun(state: LiveHiveRunState): boolean {
  return TERMINAL.has(state);
}

/** Wires a runtime's run observations into the tracker. */
export function createRunObserver(tracker: RunTracker): RuntimeRunObserver {
  return {
    activated: (traceId) => tracker.observe({ type: 'activated', traceId }),
    output: (traceId, nodeId, value) => tracker.observe({ type: 'output', traceId, nodeId, value }),
    failed: (traceId, error) => tracker.observe({ type: 'failed', traceId, error }),
    settled: (traceId) => tracker.observe({ type: 'settled', traceId }),
    parked: (traceId) => tracker.observe({ type: 'parked', traceId }),
    present: (traceId) => tracker.observe({ type: 'present', traceId }),
  };
}

/**
 * In-memory run state for admission-only wakes. A run is created at admission
 * (`accepted`), moves to `running` on the first activation, and is finalized
 * from the runtime's per-trace observations. The terminal record is written
 * through the existing RunStore; this class never creates a second durable
 * format.
 */
export class RunTracker {
  private readonly runs = new Map<string, TrackedRun>();
  private readonly byTrace = new Map<string, TrackedRun>();

  constructor(private readonly options: RunTrackerOptions) {}

  accept(input: AcceptRunInput): LiveHiveRunView {
    const existing = this.runs.get(input.runId);
    if (existing !== undefined) {
      throw new Error(`run '${input.runId}' already exists`);
    }
    const run: TrackedRun = {
      ...input,
      state: 'accepted',
      outputs: [],
      parked: false,
      traceSettled: false,
      waiters: new Set(),
      settledWaiters: new Set(),
    };
    this.runs.set(run.runId, run);
    this.byTrace.set(run.traceId, run);
    return viewOf(run);
  }

  observe(event: RunObservation): void {
    const run = this.byTrace.get(event.traceId);
    if (run === undefined) {
      return;
    }
    switch (event.type) {
      case 'activated':
        run.state = isTerminalRun(run.state) ? run.state : 'running';
        run.parked = false;
        break;
      case 'output':
        this.addOutput(run, event.nodeId, event.value);
        break;
      case 'failed': {
        run.failure = event.error;
        const state = failureState(event.error);
        this.finish(run, state, state === 'cancelled' ? 'run cancelled' : 'run failed');
        break;
      }
      case 'settled':
        this.markTraceSettled(run);
        this.finish(run, 'completed');
        break;
      case 'parked':
        run.parked = true;
        break;
      case 'present':
        run.parked = false;
        break;
    }
    this.release(run);
  }

  /** Backstop for traces removed without an activation notification (TTL). */
  reconcile(
    liveId: LiveHiveId,
    traceState: (traceId: string) => 'present' | 'settled',
  ): void {
    for (const run of this.runs.values()) {
      if (run.liveId !== liveId || isTerminalRun(run.state)) {
        continue;
      }
      if (traceState(run.traceId) === 'settled') {
        this.observe({ type: 'settled', traceId: run.traceId });
      }
    }
  }

  get(liveId: LiveHiveId, runId: string): LiveHiveRunView | undefined {
    const run = this.runs.get(runId);
    return run !== undefined && run.liveId === liveId ? viewOf(run) : undefined;
  }

  wait(
    runId: string,
    options: { readonly stopAtParked?: boolean } = {},
  ): Promise<LiveHiveRunView> {
    const run = this.runs.get(runId);
    if (run === undefined) {
      return Promise.reject(new Error(`unknown run '${runId}'`));
    }
    return new Promise<LiveHiveRunView>((resolve) => {
      const check = (): void => {
        if (isTerminalRun(run.state) || (options.stopAtParked === true && run.parked)) {
          run.waiters.delete(check);
          resolve(viewOf(run));
        }
      };
      run.waiters.add(check);
      check();
    });
  }

  waitSettled(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (run === undefined || run.traceSettled) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      run.settledWaiters.add(resolve);
    });
  }

  failureOf(runId: string): unknown {
    return this.runs.get(runId)?.failure;
  }

  outputsForTrace(traceId: string): readonly RunOutput[] {
    return this.byTrace.get(traceId)?.outputs ?? [];
  }

  cancel(runId: string): boolean {
    const run = this.runs.get(runId);
    if (run === undefined) {
      return false;
    }
    this.finish(run, 'cancelled', 'run cancelled');
    this.release(run);
    return true;
  }

  /** Terminalizes every non-terminal run of an unloaded/disposed LiveHive. */
  abandonLive(liveId: LiveHiveId): void {
    for (const run of this.runs.values()) {
      if (run.liveId === liveId && !isTerminalRun(run.state)) {
        this.finish(run, 'unknown', 'run outcome is unknown');
        this.release(run);
      }
    }
  }

  private addOutput(run: TrackedRun, nodeId: string, value: Value): void {
    if (!isTerminalRun(run.state)) {
      run.outputs.push({ nodeId, value });
    }
  }

  private finish(run: TrackedRun, state: LiveHiveRunState, error?: string): void {    if (isTerminalRun(run.state)) {
      return;
    }
    run.state = state;
    run.finishedAt = this.iso();
    if (error !== undefined) {
      run.error = error;
    }
    if (state !== 'cancelled') {
      this.markTraceSettled(run);
    }
    this.prune();
    this.save(run);
  }

  private markTraceSettled(run: TrackedRun): void {
    if (run.traceSettled) {
      return;
    }
    run.traceSettled = true;
    for (const resolve of [...run.settledWaiters]) {
      resolve();
    }
    run.settledWaiters.clear();
  }

  private release(run: TrackedRun): void {
    for (const waiter of [...run.waiters]) {
      waiter();
    }
  }

  private save(run: TrackedRun): void {
    const store = this.options.runStore;
    if (store === undefined) {
      return;
    }
    const record: RunRecord = {
      schemaVersion: 1,
      runId: run.runId,
      requestId: run.runId,
      liveId: run.liveId,
      operation: run.operation,
      status: statusOf(run.state),
      outputs: [...run.outputs],
      startedAt: run.startedAt,
      traceId: run.traceId,
      ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
      ...(run.error === undefined ? {} : { error: run.error }),
    };
    try {
      store.save(record);
    } catch (error) {
      this.options.onSaveError?.(run.liveId, run.runId, error);
    }
  }

  private prune(): void {
    if (this.runs.size <= MAX_RETAINED_RUNS) {
      return;
    }
    for (const [runId, run] of this.runs) {
      if (this.runs.size <= MAX_RETAINED_RUNS) {
        return;
      }
      if (isTerminalRun(run.state)) {
        this.runs.delete(runId);
        this.byTrace.delete(run.traceId);
      }
    }
  }

  private iso(): string {
    return new Date(this.options.now()).toISOString();
  }
}

function viewOf(run: TrackedRun): LiveHiveRunView {
  return {
    runId: run.runId,
    traceId: run.traceId,
    state: run.state,
    outputs: [...run.outputs],
    ...(run.error === undefined ? {} : { error: run.error }),
    startedAt: run.startedAt,
    ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
  };
}

function statusOf(state: LiveHiveRunState): RunStatus {
  switch (state) {
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'unknown':
      return 'unknown';
    default:
      return 'incomplete';
  }
}

/** Duck-typed so the tracker does not depend on the session/workspace layer. */
function isCancellation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { state?: unknown }).state === 'cancelled'
  );
}

function failureState(error: unknown): LiveHiveRunState {
  if (isCancellation(error)) {
    return 'cancelled';
  }
  return typeof error === 'object' &&
    error !== null &&
    (error as { state?: unknown }).state === 'unknown'
    ? 'unknown'
    : 'failed';
}
