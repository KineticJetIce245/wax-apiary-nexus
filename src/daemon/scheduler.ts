import type { TriggerDefinition } from '../runtime/index.js';

/**
 * Durable evidence that an occurrence was consumed but its callback has not
 * returned yet. `scheduledFor` is the instant the occurrence was scheduled for,
 * not when the marker was written.
 */
export interface SchedulerUnconfirmedOccurrence {
  readonly scheduledFor: string;
}

/**
 * One scheduled trigger's durable occurrence bookkeeping.
 *
 * `at` stores whether that exact instant has been consumed. `every` stores the
 * next instant the trigger is due; advancing it before enqueueing an occurrence
 * is what makes delivery at-most-once across a crash.
 *
 * `unconfirmed` is written in the same durable update that consumes the
 * occurrence and is removed once the callback returns. A process that dies
 * inside that window reports the occurrence once on its next start; it never
 * replays it through `onTrigger`.
 */
export type SchedulerTriggerState =
  | {
      kind: 'at';
      at: string;
      fired: boolean;
      unconfirmed?: SchedulerUnconfirmedOccurrence;
    }
  | {
      kind: 'every';
      everyMs: number;
      nextDueMs: number;
      unconfirmed?: SchedulerUnconfirmedOccurrence;
    };

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
  /**
   * Called once on start for an occurrence that was consumed by a previous
   * process but whose callback never confirmed completion. The occurrence is
   * reported only; it is never passed to `onTrigger` again.
   */
  onUnconfirmed?: (
    trigger: TriggerDefinition,
    occurrence: SchedulerUnconfirmedOccurrence,
  ) => void;
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
 * never emits a burst of missed intervals. The consumed occurrence and an
 * `unconfirmed` marker are saved before the callback runs, so a crash cannot
 * duplicate an occurrence; the next start reports the marker once and clears
 * it without replaying the trigger.
 */
export class Scheduler {
  private readonly triggers: readonly TriggerDefinition[];
  private readonly now: () => number;
  private readonly timers: SchedulerTimers;
  private readonly persist: (state: SchedulerState) => void;
  private readonly onTrigger: (trigger: TriggerDefinition) => void;
  private readonly onUnconfirmed:
    | ((trigger: TriggerDefinition, occurrence: SchedulerUnconfirmedOccurrence) => void)
    | undefined;
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
    this.onUnconfirmed = options.onUnconfirmed;
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
    // A marker left by a previous process is reported exactly once. It is
    // cleared before runDue, so an unconfirmed occurrence is never replayed.
    this.reportUnconfirmed();
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
    const due: { trigger: TriggerDefinition; scheduledFor: string }[] = [];
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
        entry.unconfirmed = { scheduledFor: entry.at };
        due.push({ trigger, scheduledFor: entry.at });
        changed = true;
        continue;
      }

      if (entry.kind !== 'every' || entry.nextDueMs > now) {
        continue;
      }
      // More than one whole interval late means the daemon was not running.
      // Fire this occurrence once and restart the cadence from now instead of
      // replaying every skipped interval.
      const scheduledFor = new Date(entry.nextDueMs).toISOString();
      const missedAtLeastOne = now - entry.nextDueMs >= entry.everyMs;
      entry.nextDueMs = (missedAtLeastOne ? now : entry.nextDueMs) + entry.everyMs;
      entry.unconfirmed = { scheduledFor };
      due.push({ trigger, scheduledFor });
      changed = true;
    }

    if (!changed) {
      return;
    }

    // Commit the advanced occurrence and its marker before any callback runs.
    // A crash between this write and the clear write leaves durable evidence
    // for the next start but can never duplicate the occurrence.
    this.persist(next);
    this.state = next;

    for (const { trigger } of due) {
      try {
        this.onTrigger(trigger);
      } catch (error) {
        this.reportError(error, trigger);
      }
      // The callback was attempted, so the marker is cleared whether it
      // succeeded or threw. The occurrence is never replayed.
      this.clearUnconfirmed(trigger.id);
    }
  }

  /**
   * Reports every marker left by a previous process, then clears it.
   *
   * Reporting happens before the clear write: if that write fails the marker
   * stays on disk and the next start reports it again instead of replaying the
   * trigger.
   */
  private reportUnconfirmed(): void {
    const pending: {
      trigger: TriggerDefinition;
      occurrence: SchedulerUnconfirmedOccurrence;
    }[] = [];
    const next = structuredClone(this.state);
    for (const trigger of this.triggers) {
      const entry = next.triggers[trigger.id];
      if (entry === undefined || entry.unconfirmed === undefined) {
        continue;
      }
      pending.push({
        trigger,
        occurrence: { scheduledFor: entry.unconfirmed.scheduledFor },
      });
      delete entry.unconfirmed;
    }

    if (pending.length === 0) {
      return;
    }

    for (const { trigger, occurrence } of pending) {
      if (this.onUnconfirmed === undefined) {
        continue;
      }
      try {
        this.onUnconfirmed(trigger, occurrence);
      } catch (error) {
        this.reportError(error, trigger);
      }
    }

    this.persist(next);
    this.state = next;
  }

  private clearUnconfirmed(triggerId: string): void {
    const current = this.state.triggers[triggerId];
    if (current === undefined || current.unconfirmed === undefined) {
      return;
    }
    const next = structuredClone(this.state);
    const entry = next.triggers[triggerId];
    if (entry === undefined) {
      return;
    }
    delete entry.unconfirmed;
    this.persist(next);
    this.state = next;
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
        entries[trigger.id] = {
          kind: 'at',
          at: existing.at,
          fired: existing.fired,
          // A marker belongs to the old schedule; any schedule change above
          // resets the entry, so only an unchanged schedule keeps it.
          ...(existing.unconfirmed === undefined
            ? {}
            : { unconfirmed: { ...existing.unconfirmed } }),
        };
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
        ...(existing.unconfirmed === undefined
          ? {}
          : { unconfirmed: { ...existing.unconfirmed } }),
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
      const unconfirmed = parseUnconfirmed(raw['unconfirmed'], id);
      triggers[id] = {
        kind: 'at',
        at,
        fired: raw['fired'],
        ...(unconfirmed === undefined ? {} : { unconfirmed }),
      };
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
      const unconfirmed = parseUnconfirmed(raw['unconfirmed'], id);
      triggers[id] = {
        kind: 'every',
        everyMs,
        nextDueMs,
        ...(unconfirmed === undefined ? {} : { unconfirmed }),
      };
      continue;
    }
    throw new Error(`scheduler state trigger '${id}': kind must be 'at' or 'every'`);
  }

  return { schemaVersion: 1, triggers };
}

function parseUnconfirmed(
  input: unknown,
  triggerId: string,
): SchedulerUnconfirmedOccurrence | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (!isRecord(input)) {
    throw new Error(`scheduler state trigger '${triggerId}': unconfirmed must be an object`);
  }
  const scheduledFor = input['scheduledFor'];
  if (
    typeof scheduledFor !== 'string' ||
    scheduledFor === '' ||
    !Number.isFinite(Date.parse(scheduledFor))
  ) {
    throw new Error(
      `scheduler state trigger '${triggerId}': unconfirmed.scheduledFor must be a timestamp`,
    );
  }
  return { scheduledFor };
}
