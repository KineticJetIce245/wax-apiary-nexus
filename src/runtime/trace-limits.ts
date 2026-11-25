import type { GuardDecision } from './executor.js';
import { dropTraceFromMailbox, isJoinClosed } from './field.js';
import type { RuntimeLogEntry } from './log.js';
import type {
  CompositionDefinition,
  HoverSpec,
  NodeId,
  NodeState,
  RuntimeRunObserver,
} from './types.js';

/** Default ceiling on the number of activations one trace may start. */
export const DEFAULT_MAX_HOPS_PER_TRACE = 256;

/** Default ceiling on how long one trace may live, measured from admission. */
export const DEFAULT_MAX_DURATION_PER_TRACE_MS = 30 * 60 * 1000;

export type TraceLimitKind = 'hops' | 'duration';

/**
 * Test/daemon seam for the duration deadline. The runtime never holds its state
 * lock while the callback runs and never polls: the returned function cancels
 * the scheduled callback.
 */
export type TraceDeadlineTimer = (
  callback: () => void,
  delayMs: number,
) => () => void;

export interface TraceLimitOptions {
  /** Positive integer; one activation start counts as one hop. */
  readonly maxHopsPerTrace?: number;
  /** Positive integer; measured from trace admission, not first activation. */
  readonly maxDurationPerTraceMs?: number;
}

export interface ResolvedTraceLimitOptions {
  readonly maxHopsPerTrace: number;
  readonly maxDurationPerTraceMs: number;
}

/** Validates the two per-trace limits once, for both the host and the runtime. */
export function readTraceLimitOptions(
  options: TraceLimitOptions,
): ResolvedTraceLimitOptions {
  return {
    maxHopsPerTrace: positiveIntegerOption(
      options.maxHopsPerTrace,
      'maxHopsPerTrace',
      DEFAULT_MAX_HOPS_PER_TRACE,
    ),
    maxDurationPerTraceMs: positiveIntegerOption(
      options.maxDurationPerTraceMs,
      'maxDurationPerTraceMs',
      DEFAULT_MAX_DURATION_PER_TRACE_MS,
    ),
  };
}

/**
 * A trace was cancelled because it exceeded its own hop or duration budget.
 * It is reported as a cancellation, not a failure: `state` is the same
 * duck-typed field the run tracker uses for a cancelled native execution.
 */
export class TraceLimitError extends Error {
  readonly state = 'cancelled' as const;
  readonly reason = 'trace-limit' as const;

  constructor(
    readonly limit: TraceLimitKind,
    readonly max: number,
    readonly observed: number,
  ) {
    super(
      limit === 'hops'
        ? `trace hop limit exceeded (maxHopsPerTrace=${String(max)}, ` +
            `observed=${String(observed)})`
        : `trace duration limit exceeded (maxDurationPerTraceMs=${String(max)}, ` +
            `elapsedMs=${String(observed)})`,
    );
    this.name = 'TraceLimitError';
  }
}

interface GuardWaiter {
  readonly requestId: string;
  resolve(decision: GuardDecision): void;
}

/** What one trace's budget and the cancellation purge need from the runtime. */
export interface TraceLimitHost {
  readonly definition: CompositionDefinition;
  readonly states: ReadonlyMap<NodeId, NodeState>;
  readonly guardWaiters: Map<string, GuardWaiter>;
  readonly now: () => number;
  readonly onGuardExpired?: (requestId: string) => void;
  readonly onRun?: RuntimeRunObserver;
  readonly timer?: TraceDeadlineTimer;
  /** Runs a short synchronous batch under the runtime's state lock. */
  transaction<T>(action: () => T): T;
  log(entry: Omit<RuntimeLogEntry, 'at' | 'compositionId' | 'graphRevision'>): void;
  /** Reports present/parked/settled for the cancelled trace. */
  notifyTrace(traceId: string): void;
  /** True when the trace has no live or parked work left. */
  isSettled(traceId: string): boolean;
  /** Wakes block-policy admissions whose mailbox the purge emptied. */
  mailboxOverflowNotifyAll?(): void;
}

interface TraceBudgetState {
  hops: number;
  readonly startedAt: number;
  aborted: boolean;
  timer?: () => void;
}

/**
 * Per-trace hop/duration budgets.
 *
 * Hop accounting is deliberately per activation start: the initial admission
 * Pheromone is not a hop, every node activation (including fork and merge) is
 * one hop, and a fork's branch fan-out does not add hops by itself (each
 * branch's later activation does). Fork/merge branches share the same trace
 * budget because the budget is keyed only by `traceId`.
 *
 * Duration starts at admission (`admittedAt`, supplied by the runtime) and is
 * checked at activation starts, at the runtime's pump entry, and by the
 * injected deadline timer. The timer never runs under the state lock by
 * itself; it enters one short transaction in `onDeadline`.
 */
export class TraceLimitManager {
  private readonly maxHopsPerTrace: number;
  private readonly maxDurationPerTraceMs: number;
  private readonly timer: TraceDeadlineTimer;
  private readonly traces = new Map<string, TraceBudgetState>();

  constructor(
    private readonly host: TraceLimitHost,
    options: TraceLimitOptions = {},
  ) {
    const resolved = readTraceLimitOptions(options);
    this.maxHopsPerTrace = resolved.maxHopsPerTrace;
    this.maxDurationPerTraceMs = resolved.maxDurationPerTraceMs;
    if (host.timer !== undefined && typeof host.timer !== 'function') {
      throw new TypeError('traceDeadlineTimer must be a function');
    }
    this.timer = host.timer ?? defaultTraceDeadlineTimer;
  }

  /** Starts a budget window; a duplicate trace id keeps its original window. */
  start(traceId: string, startedAt: number = this.host.now()): void {
    if (this.traces.has(traceId)) {
      return;
    }
    this.traces.set(traceId, { hops: 0, startedAt, aborted: false });
    this.schedule(traceId);
  }

  /**
   * Restored fields have no persisted admission instant, so their window starts
   * at the first pump after restore. This is explicit: we do not rewrite Honey.
   */
  adoptRestored(): void {
    const now = this.host.now();
    for (const traceId of collectTraceIds(this.host.states)) {
      if (!this.traces.has(traceId)) {
        this.start(traceId, now);
      }
    }
  }

  /**
   * Returns false when this activation must not start: the trace was already
   * aborted, or this attempt crossed a limit and was cancelled. Otherwise the
   * activation is charged one hop.
   */
  enterActivation(traceId: string): boolean {
    if (!this.traces.has(traceId)) {
      this.start(traceId);
    }
    const state = this.traces.get(traceId);
    if (state === undefined || state.aborted) {
      return false;
    }
    const exceeded = this.exceeded(state);
    if (exceeded !== undefined) {
      this.cancel(traceId, exceeded);
      return false;
    }
    state.hops += 1;
    return true;
  }

  /** Second check point: duration expiry even when no activation is starting. */
  sweep(): void {
    for (const traceId of [...this.traces.keys()]) {
      const state = this.traces.get(traceId);
      if (state === undefined || state.aborted) {
        continue;
      }
      if (this.host.isSettled(traceId)) {
        this.forget(traceId);
        continue;
      }
      const exceeded = this.durationError(state);
      if (exceeded !== undefined) {
        this.cancel(traceId, exceeded);
      }
    }
  }

  isAborted(traceId: string): boolean {
    return this.traces.get(traceId)?.aborted === true;
  }

  /** Releases the per-trace budget and its timer once the trace is terminal. */
  forget(traceId: string): void {
    const state = this.traces.get(traceId);
    if (state === undefined) {
      return;
    }
    this.clearTimer(state);
    this.traces.delete(traceId);
  }

  private exceeded(state: TraceBudgetState): TraceLimitError | undefined {
    const duration = this.durationError(state);
    if (duration !== undefined) {
      return duration;
    }
    if (state.hops >= this.maxHopsPerTrace) {
      return new TraceLimitError('hops', this.maxHopsPerTrace, state.hops);
    }
    return undefined;
  }

  private durationError(state: TraceBudgetState): TraceLimitError | undefined {
    const elapsed = this.host.now() - state.startedAt;
    if (elapsed < this.maxDurationPerTraceMs) {
      return undefined;
    }
    return new TraceLimitError('duration', this.maxDurationPerTraceMs, elapsed);
  }

  private cancel(traceId: string, error: TraceLimitError): void {
    const state = this.traces.get(traceId);
    if (state === undefined || state.aborted) {
      return;
    }
    state.aborted = true;
    this.clearTimer(state);
    purgeTrace(this.host, traceId);
    this.host.log({
      event: 'trace.cancelled',
      traceId,
      outcome: error.limit,
      limit: error.max,
      ...(error.limit === 'duration' ? { durationMs: error.observed } : {}),
      error: error.message,
    });
    try {
      this.host.onRun?.failed?.(traceId, error);
    } catch {
      // Observability must never change the cancellation outcome.
    }
    this.host.notifyTrace(traceId);
    this.host.mailboxOverflowNotifyAll?.();
  }

  private schedule(traceId: string): void {
    const state = this.traces.get(traceId);
    if (state === undefined || state.aborted) {
      return;
    }
    this.clearTimer(state);
    const elapsed = this.host.now() - state.startedAt;
    const remaining = Math.max(0, this.maxDurationPerTraceMs - elapsed);
    state.timer = this.timer(() => this.onDeadline(traceId), remaining);
  }

  private onDeadline(traceId: string): void {
    try {
      this.host.transaction(() => {
        const state = this.traces.get(traceId);
        if (state === undefined || state.aborted) {
          return;
        }
        const exceeded = this.durationError(state);
        if (exceeded === undefined) {
          // The injected clock may not have advanced with the timer yet.
          this.schedule(traceId);
          return;
        }
        this.cancel(traceId, exceeded);
      });
    } catch {
      // A deadline must never crash the runtime; the next pump retries.
    }
  }

  private clearTimer(state: TraceBudgetState): void {
    if (state.timer === undefined) {
      return;
    }
    state.timer();
    delete state.timer;
  }
}

/** Default unref'd timer: a per-trace deadline must not hold the process open. */
export function defaultTraceDeadlineTimer(
  callback: () => void,
  delayMs: number,
): () => void {
  const timer = setTimeout(callback, delayMs);
  timer.unref();
  return () => {
    clearTimeout(timer);
  };
}

function positiveIntegerOption(
  value: number | undefined,
  name: string,
  fallback: number,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return resolved;
}

/** Every trace id present anywhere in one field. */
function collectTraceIds(states: ReadonlyMap<NodeId, NodeState>): Set<string> {
  const traceIds = new Set<string>();
  for (const state of states.values()) {
    for (const pheromone of state.queue ?? []) {
      traceIds.add(pheromone.traceId);
    }
    if (state.pending !== undefined) {
      traceIds.add(state.pending.traceId);
    }
    if (state.active !== undefined) {
      traceIds.add(state.active.traceId);
    }
    if (state.hoverPheromone !== undefined) {
      traceIds.add(state.hoverPheromone.traceId);
    }
    if (state.joins !== undefined) {
      for (const join of state.joins.values()) {
        for (const arrived of join.arrived.values()) {
          traceIds.add(arrived.traceId);
        }
      }
    }
  }
  return traceIds;
}

/**
 * Removes every waiting item of one trace: mailboxes, pending slots, hovers and
 * incomplete joins. `active` is deliberately kept: a running native execution
 * cannot be force-killed, and its later output is suppressed by the runtime.
 */
function purgeTrace(host: TraceLimitHost, traceId: string): void {
  for (const [nodeId, state] of host.states) {
    dropTraceFromMailbox(state, traceId);
    if (state.pending?.traceId === traceId) {
      delete state.pending;
    }
    purgeHover(host, nodeId, state, traceId);
    purgeJoins(host, nodeId, state, traceId);
  }
}

function purgeHover(
  host: TraceLimitHost,
  nodeId: NodeId,
  state: NodeState,
  traceId: string,
): void {
  const pheromone =
    state.hoverPheromone ??
    (state.hover?.kind === 'guard' ? state.active : undefined);
  if (pheromone === undefined || pheromone.traceId !== traceId) {
    return;
  }
  const hover: HoverSpec | undefined = state.hover;
  if (hover?.kind === 'guard') {
    const waiter = host.guardWaiters.get(hover.token);
    if (waiter !== undefined) {
      host.guardWaiters.delete(hover.token);
      try {
        host.onGuardExpired?.(waiter.requestId);
      } catch {
        // Broker expiry is best effort; resolving `cancelled` is the hard part.
      }
      waiter.resolve('cancelled');
    }
  }
  delete state.hover;
  delete state.hoverPheromone;
  const node = host.definition.nodes.get(nodeId);
  host.log({
    event: 'hover.cancelled',
    nodeId,
    ...(node === undefined ? {} : { nodeKind: node.kind }),
    pheromoneId: pheromone.id,
    traceId,
    outcome: 'trace-limit',
  });
}

function purgeJoins(
  host: TraceLimitHost,
  nodeId: NodeId,
  state: NodeState,
  traceId: string,
): void {
  const joins = state.joins;
  if (joins === undefined) {
    return;
  }
  const node = host.definition.nodes.get(nodeId);
  for (const [forkId, join] of [...joins]) {
    if (isJoinClosed(join)) {
      continue;
    }
    let belongs = false;
    for (const arrived of join.arrived.values()) {
      if (arrived.traceId === traceId) {
        belongs = true;
        break;
      }
    }
    if (!belongs) {
      continue;
    }
    joins.delete(forkId);
    if (node?.kind === 'merge') {
      host.log({
        event: 'merge.failed',
        nodeId,
        nodeKind: 'merge',
        forkId,
        traceId,
        outcome: 'trace-limit',
      });
    }
  }
  if (joins.size === 0) {
    delete state.joins;
  }
}
