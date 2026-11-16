import {
  Scheduler,
  type SchedulerState,
  type SchedulerTimers,
  type SchedulerUnconfirmedOccurrence,
} from './scheduler.js';
import type { CompositionDefinition, TriggerDefinition } from '../runtime/index.js';

export interface SchedulerServiceOptions {
  readonly now?: () => number;
  readonly timers?: SchedulerTimers;
  readonly onError?: (
    graphId: string,
    error: unknown,
    trigger: TriggerDefinition | undefined,
  ) => void;
  readonly onUnconfirmed?: (
    graphId: string,
    trigger: TriggerDefinition,
    occurrence: SchedulerUnconfirmedOccurrence,
  ) => void;
}

export interface SchedulerStartOptions {
  readonly state?: SchedulerState;
  /** Must durably record the marker before the scheduler emits the occurrence. */
  readonly persist: (state: SchedulerState) => void;
}

interface SchedulerEntry {
  scheduler: Scheduler;
  readonly inFlight: Set<Promise<void>>;
}

/**
 * One Scheduler per loaded LiveHive.
 *
 * A scheduled occurrence calls the supplied fire callback through a microtask,
 * so a trigger due during load cannot run before the host has registered the
 * graph. The occurrence marker is persisted by `Scheduler` before that
 * callback; a failed fire is reported and never replayed.
 */
export class SchedulerService {
  private readonly now: () => number;
  private readonly timers: SchedulerTimers | undefined;
  private readonly onError: SchedulerServiceOptions['onError'];
  private readonly onUnconfirmed: SchedulerServiceOptions['onUnconfirmed'];
  private readonly entries = new Map<string, SchedulerEntry>();

  constructor(options: SchedulerServiceOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.timers = options.timers;
    this.onError = options.onError;
    this.onUnconfirmed = options.onUnconfirmed;
  }

  /** Start one graph's scheduler, if the definition has triggers. */
  start(
    graphId: string,
    definition: CompositionDefinition,
    options: SchedulerStartOptions,
    fire: (trigger: TriggerDefinition) => Promise<void>,
  ): void {
    this.stop(graphId);
    if (definition.triggers.length === 0) {
      return;
    }

    const entry: SchedulerEntry = {
      scheduler: undefined as unknown as Scheduler,
      inFlight: new Set(),
    };
    const scheduler = new Scheduler({
      triggers: definition.triggers,
      ...(options.state === undefined ? {} : { state: options.state }),
      now: this.now,
      ...(this.timers === undefined ? {} : { timers: this.timers }),
      persist: options.persist,
      onTrigger: (trigger) => {
        const promise = Promise.resolve()
          .then(() => fire(trigger))
          .catch((error: unknown) => {
            this.onError?.(graphId, error, trigger);
          })
          .finally(() => {
            entry.inFlight.delete(promise);
          });
        entry.inFlight.add(promise);
      },
      onUnconfirmed: (trigger, occurrence) => {
        this.onUnconfirmed?.(graphId, trigger, occurrence);
      },
      onError: (error, trigger) => {
        this.onError?.(graphId, error, trigger);
      },
    });
    entry.scheduler = scheduler;
    this.entries.set(graphId, entry);
    try {
      scheduler.start();
    } catch (error) {
      this.entries.delete(graphId);
      throw error;
    }
  }

  /** Stop one graph's timer. In-flight triggers finish independently. */
  stop(graphId: string): void {
    const entry = this.entries.get(graphId);
    if (entry === undefined) {
      return;
    }
    this.entries.delete(graphId);
    entry.scheduler.stop();
  }

  /** Stop every timer; used by host dispose. */
  stopAll(): void {
    for (const graphId of [...this.entries.keys()]) {
      this.stop(graphId);
    }
  }

  has(graphId: string): boolean {
    return this.entries.has(graphId);
  }

  /** Current occurrence markers for a graph; undefined without a scheduler. */
  exportState(graphId: string): SchedulerState | undefined {
    return this.entries.get(graphId)?.scheduler.exportState();
  }
}
