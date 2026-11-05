import type { TriggerDefinition } from './runtime/index.js';

/**
 * One scheduled trigger's durable occurrence bookkeeping.
 *
 * `at` stores whether that exact instant has been consumed. `every` stores the
 * next instant the trigger is due; advancing it before enqueueing an occurrence
 * is what makes delivery at-most-once across a crash.
 */
export type SchedulerTriggerState =
  | { kind: 'at'; at: string; fired: boolean }
  | { kind: 'every'; everyMs: number; nextDueMs: number };

export interface SchedulerState {
  schemaVersion: 1;
  triggers: Record<string, SchedulerTriggerState>;
}

/** Test seam: the scheduler never reads the wall clock or global timers directly. */
export interface SchedulerTimers {
  setTimeout(handler: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface SchedulerOptions {
  triggers: readonly TriggerDefinition[];
  /** Previously persisted state; a mismatched schedule is treated as fresh. */
  state?: SchedulerState;
  now?: () => number;
  timers?: SchedulerTimers;
  /**
   * Called synchronously before any due occurrence is handed to `onTrigger`.
   * If it throws, no trigger is emitted, so a failed write cannot duplicate an
   * occurrence after a restart.
   */
  persist: (state: SchedulerState) => void;
  onTrigger: (trigger: TriggerDefinition) => void;
  /** A trigger callback error is reported after its occurrence was consumed. */
  onError?: (error: unknown, trigger?: TriggerDefinition) => void;
}

const MAX_TIMER_DELAY_MS = 2_147_483_647;

const DEFAULT_TIMERS: SchedulerTimers = {
  setTimeout: (handler, delayMs) => setTimeout(handler, delayMs),
  clearTimeout: (handle) => {
    clearTimeout(handle as NodeJS.Timeout);
  },
};

/**
 * A small foreground scheduler for one composition.
 *
 * Past `at` triggers fire once on start. An `every` trigger whose next due time
 * is already in the past fires once on start and is rescheduled from now; it
 * never emits a burst of missed intervals. The state is saved before the
 * callback runs, so a crash can lose an occurrence but cannot duplicate one.
 */
export class Scheduler {
  private readonly triggers: readonly TriggerDefinition[];
  private readonly now: () => number;
  private readonly timers: SchedulerTimers;
  private readonly persist: (state: SchedulerState) => void;
  private readonly onTrigger: (trigger: TriggerDefinition) => void;
  private readonly onError: ((error: unknown, trigger?: TriggerDefinition) => void) | undefined;
  private state: SchedulerState;
  private timer: unknown;
  private started = false;
  private stopped = false;

  constructor(options: SchedulerOptions) {
    const ids = new Set<string>();
    for (const trigger of options.triggers) {
      if (ids.has(trigger.id)) {
        throw new TypeError(`duplicate trigger id '${trigger.id}'`);
      }
      ids.add(trigger.id);
    }

    this.triggers = options.triggers;
    this.now = options.now ?? Date.now;
    this.timers = options.timers ?? DEFAULT_TIMERS;
    this.persist = options.persist;
    this.onTrigger = options.onTrigger;
    this.onError = options.onError;
    this.state = reconcileState(options.triggers, options.state, this.now());
  }

  start(): void {
    if (this.started) {
      throw new Error('scheduler has already started');
    }
    if (this.stopped) {
      throw new Error('scheduler has been stopped');
    }
    this.started = true;

    // Persist the reconciled schedule before anything can fire. This also
    // anchors a fresh `every` trigger so a restart keeps its first due time.
    this.persist(this.state);
    this.runDue();
    this.scheduleNext();
  }

  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    if (this.timer !== undefined) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  exportState(): SchedulerState {
    return structuredClone(this.state);
  }

  /** Fires every trigger whose occurrence is due at the injected clock time. */
  private runDue(): void {
    const now = this.now();
    const next = structuredClone(this.state);
    const due: TriggerDefinition[] = [];
    let changed = false;

    for (const trigger of this.triggers) {
      const entry = next.triggers[trigger.id];
      if (entry === undefined) {
        continue;
      }

      if (trigger.schedule.kind === 'at') {
        if (entry.kind !== 'at' || entry.fired) {
          continue;
        }
        const dueMs = Date.parse(entry.at);
        if (!Number.isFinite(dueMs) || dueMs > now) {
          continue;
        }
        entry.fired = true;
        due.push(trigger);
        changed = true;
        continue;
      }

      if (entry.kind !== 'every' || entry.nextDueMs > now) {
        continue;
      }
      // More than one whole interval late means the daemon was not running.
      // Fire this occurrence once and restart the cadence from now instead of
      // replaying every skipped interval.
      const missedAtLeastOne = now - entry.nextDueMs >= entry.everyMs;
      entry.nextDueMs = (missedAtLeastOne ? now : entry.nextDueMs) + entry.everyMs;
      due.push(trigger);
      changed = true;
    }

    if (changed) {
      // Commit only after the durable write succeeds. A crash between this
      // write and the callbacks below loses the occurrence; it never repeats it.
      this.persist(next);
      this.state = next;
    }

    for (const trigger of due) {
      try {
        this.onTrigger(trigger);
      } catch (error) {
        this.reportError(error, trigger);
      }
    }
  }

  private scheduleNext(): void {
    if (this.stopped) {
      return;
    }
    const nextDueMs = this.nextDueMs();
    if (nextDueMs === undefined) {
      return;
    }
    const delayMs = Math.max(0, nextDueMs - this.now());
    const chunk = Math.min(delayMs, MAX_TIMER_DELAY_MS);
    this.timer = this.timers.setTimeout(this.handleTimer, chunk);
  }

  private readonly handleTimer = (): void => {
    this.timer = undefined;
    if (this.stopped) {
      return;
    }
    try {
      this.runDue();
    } catch (error) {
      this.reportError(error);
      this.stop();
      return;
    }
    this.scheduleNext();
  };

  private nextDueMs(): number | undefined {
    let next: number | undefined;
    for (const trigger of this.triggers) {
      const entry = this.state.triggers[trigger.id];
      if (entry === undefined) {
        continue;
      }
      let candidate: number;
      if (entry.kind === 'at') {
        if (entry.fired) {
          continue;
        }
        candidate = Date.parse(entry.at);
        if (!Number.isFinite(candidate)) {
          continue;
        }
      } else {
        candidate = entry.nextDueMs;
      }
      if (next === undefined || candidate < next) {
        next = candidate;
      }
    }
    return next;
  }

  private reportError(error: unknown, trigger?: TriggerDefinition): void {
    if (this.onError === undefined) {
      return;
    }
    try {
      this.onError(error, trigger);
    } catch {
      // Reporting must never break the scheduler loop.
    }
  }
}

function reconcileState(
  triggers: readonly TriggerDefinition[],
  stored: SchedulerState | undefined,
  now: number,
): SchedulerState {
  const entries: Record<string, SchedulerTriggerState> = {};

  for (const trigger of triggers) {
    const existing = stored?.triggers[trigger.id];
    if (trigger.schedule.kind === 'at') {
      if (existing?.kind === 'at' && existing.at === trigger.schedule.at) {
        entries[trigger.id] = { kind: 'at', at: existing.at, fired: existing.fired };
      } else {
        entries[trigger.id] = { kind: 'at', at: trigger.schedule.at, fired: false };
      }
      continue;
    }

    if (
      existing?.kind === 'every' &&
      existing.everyMs === trigger.schedule.everyMs &&
      Number.isFinite(existing.nextDueMs)
    ) {
      entries[trigger.id] = {
        kind: 'every',
        everyMs: existing.everyMs,
        nextDueMs: existing.nextDueMs,
      };
    } else {
      entries[trigger.id] = {
        kind: 'every',
        everyMs: trigger.schedule.everyMs,
        nextDueMs: now + trigger.schedule.everyMs,
      };
    }
  }

  return { schemaVersion: 1, triggers: entries };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates `honey/scheduler.json`. A corrupt state file is an error, not a
 * reason to start from scratch: forgetting fired occurrences could duplicate
 * side effects.
 */
export function parseSchedulerState(input: unknown): SchedulerState {
  if (!isRecord(input)) {
    throw new Error('scheduler state: expected an object');
  }
  if (input['schemaVersion'] !== 1) {
    throw new Error(`scheduler state: unsupported schemaVersion ${String(input['schemaVersion'])}`);
  }
  const rawTriggers = input['triggers'];
  if (!isRecord(rawTriggers)) {
    throw new Error('scheduler state: triggers must be an object keyed by trigger id');
  }

  const triggers: Record<string, SchedulerTriggerState> = {};
  for (const [id, raw] of Object.entries(rawTriggers)) {
    if (id === '') {
      throw new Error('scheduler state: trigger id must be non-empty');
    }
    if (!isRecord(raw)) {
      throw new Error(`scheduler state trigger '${id}': expected an object`);
    }
    const kind = raw['kind'];
    if (kind === 'at') {
      const at = raw['at'];
      if (typeof at !== 'string' || at === '' || !Number.isFinite(Date.parse(at))) {
        throw new Error(`scheduler state trigger '${id}': at must be a timestamp`);
      }
      if (typeof raw['fired'] !== 'boolean') {
        throw new Error(`scheduler state trigger '${id}': fired must be a boolean`);
      }
      triggers[id] = { kind: 'at', at, fired: raw['fired'] };
      continue;
    }
    if (kind === 'every') {
      const everyMs = raw['everyMs'];
      if (typeof everyMs !== 'number' || !Number.isInteger(everyMs) || everyMs < 1000) {
        throw new Error(`scheduler state trigger '${id}': everyMs must be an integer >= 1000`);
      }
      const nextDueMs = raw['nextDueMs'];
      if (typeof nextDueMs !== 'number' || !Number.isFinite(nextDueMs)) {
        throw new Error(`scheduler state trigger '${id}': nextDueMs must be a finite number`);
      }
      triggers[id] = { kind: 'every', everyMs, nextDueMs };
      continue;
    }
    throw new Error(`scheduler state trigger '${id}': kind must be 'at' or 'every'`);
  }

  return { schemaVersion: 1, triggers };
}
