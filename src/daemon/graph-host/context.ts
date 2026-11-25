import { GraphRegistry, type LiveHiveId } from '../../graph/registry.js';
import { DEFAULT_IDLE_TTL_MS } from '../../graph/residency.js';
import type { GuardDecision, GuardRequest, PheromoneFieldSnapshot } from '../../runtime/index.js';
import { readMailboxOverflowOptions, readTraceLimitOptions } from '../../runtime/index.js';
import type { SessionRegistry } from '../../session/session-registry.js';
import type { HoneyStore } from '../../storage/honey.js';
import type { RunStore } from '../../storage/run-store.js';
import type { LiveHiveCatalog } from '../live-hive-catalog.js';
import { LiveHiveLock } from '../live-hive-lock.js';
import { SchedulerService } from '../scheduler-service.js';
import { RunTracker } from './run-tracker.js';
import {
  LiveHiveHostDisposedError,
  type LiveHiveHostEvent,
  type LiveHiveHostOptions,
  type LiveGraph,
} from './types.js';

export type UnloadHandler = (graphId: LiveHiveId, live: LiveGraph) => Promise<void>;

/**
 * Shared dependencies and mutable host state for the LiveHiveHost services. It is
 * assembled once; services receive it instead of reaching back into the facade.
 */
export class LiveHiveHostContext {
  readonly registry: SessionRegistry;
  readonly catalog: LiveHiveCatalog | undefined;
  readonly runStore: RunStore | undefined;
  readonly guardTimeoutMs: number | undefined;
  readonly schedulers: SchedulerService;
  readonly allowHoverUnload: boolean;
  readonly now: () => number;
  readonly defaultIdleTtlMs: number;
  readonly honeyForGraph: ((graphId: string) => HoneyStore) | undefined;
  readonly restoreHoney: boolean;
  readonly bindingStore: LiveHiveHostOptions['bindingStore'];
  readonly maxPumps: number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly maxWaitMs: number;
  readonly onGuard: ((request: GuardRequest) => Promise<GuardDecision>) | undefined;
  readonly onGuardExpired: ((requestId: string) => void) | undefined;
  readonly mailboxOverflowPolicy: 'reject' | 'block';
  readonly mailboxBlockTimeoutMs: number;
  readonly traceLimits: ReturnType<typeof readTraceLimitOptions>;
  readonly onEvent: ((event: LiveHiveHostEvent) => void) | undefined;
  readonly graphs: GraphRegistry<LiveGraph>;
  readonly runs: RunTracker;
  readonly lock = new LiveHiveLock();
  readonly loading = new Set<LiveHiveId>();

  disposed = false;
  disposePromise: Promise<void> | undefined;
  private unloadHandler: UnloadHandler = async () => {
    throw new Error('graph unload handler is not configured');
  };

  constructor(options: LiveHiveHostOptions) {
    this.registry = options.registry;
    this.catalog = options.catalog;    this.runStore = options.runStore;
    this.runs = createRunTracker(options, (event) => this.reportCleanupFailure(event));
    this.guardTimeoutMs = positiveIntegerOption(options.guardTimeoutMs, 'guardTimeoutMs');
    this.allowHoverUnload = readBooleanOption(
      options.allowHoverUnload,
      'allowHoverUnload',
      false,
    );
    this.now = options.now ?? (() => Date.now());
    this.honeyForGraph = options.honeyForGraph;
    this.restoreHoney = readBooleanOption(options.restoreHoney, 'restoreHoney', true);
    this.bindingStore = options.bindingStore;
    this.defaultIdleTtlMs =
      options.defaultIdleTtlMs ??
      (options.honeyForGraph === undefined ? 0 : DEFAULT_IDLE_TTL_MS);
    assertNonNegativeInteger(this.defaultIdleTtlMs, 'defaultIdleTtlMs');
    this.maxPumps = options.maxPumps ?? 50;
    assertNonNegativeInteger(this.maxPumps, 'maxPumps');
    this.sleep = options.sleep ?? defaultSleep;
    if (typeof this.sleep !== 'function') {
      throw new TypeError('sleep must be a function');
    }
    this.maxWaitMs = options.maxWaitMs ?? 30_000;
    assertNonNegativeInteger(this.maxWaitMs, 'maxWaitMs');
    this.onGuard = options.onGuard;
    if (this.onGuard !== undefined && typeof this.onGuard !== 'function') {
      throw new TypeError('onGuard must be a function');
    }
    this.onGuardExpired = options.onGuardExpired;
    if (this.onGuardExpired !== undefined && typeof this.onGuardExpired !== 'function') {
      throw new TypeError('onGuardExpired must be a function');
    }
    const mailbox = readMailboxOverflowOptions(options);
    this.mailboxOverflowPolicy = mailbox.policy;    this.mailboxBlockTimeoutMs = mailbox.blockTimeoutMs;
    this.traceLimits = readTraceLimitOptions(options);
    this.onEvent = options.onEvent;
    this.schedulers = new SchedulerService({
      now: this.now,
      ...(options.schedulerTimers === undefined
        ? {}
        : { timers: options.schedulerTimers }),
      onError: (graphId, error, trigger) => {
        this.reportCleanupFailure({
          type: 'scheduler.trigger-failed',
          graphId,
          triggerId: trigger?.id ?? '<unknown>',
          error: messageOf(error),
        });
      },
      onUnconfirmed: (graphId, trigger, occurrence) => {
        this.reportCleanupFailure({
          type: 'scheduler.unconfirmed',
          graphId,
          triggerId: trigger.id,
          scheduledFor: occurrence.scheduledFor,
        });
      },
    });
    this.graphs = new GraphRegistry<LiveGraph>({
      now: this.now,
      defaultIdleTtlMs: this.defaultIdleTtlMs,
      // Rest-only by default. With `allowHoverUnload`, a field parked on
      // hover(s) with no active/pending/queued work may be flushed and
      // released; Honey makes that hover replayable after a reload.
      isSafeToUnload: (_id, live) => {
        const snapshot = live.runtime.snapshot();
        return snapshot.rest || (this.allowHoverUnload && isQuiescentHover(snapshot));
      },
      onUnload: (id, live) => this.unloadHandler(id, live),
    });
  }

  setUnloadHandler(handler: UnloadHandler): void {
    this.unloadHandler = handler;
  }

  updateCatalog(
    graphId: LiveHiveId,
    phase: 'load' | 'access' | 'unload' | 'sweep' | 'dispose',
    update: (catalog: LiveHiveCatalog) => void,
  ): void {
    const catalog = this.catalog;
    if (catalog === undefined) {
      return;
    }
    try {
      update(catalog);
      catalog.save();
    } catch (error) {
      this.reportCleanupFailure({
        type: 'graph.catalog-failed',
        graphId,
        phase,
        error: messageOf(error),
      });
    }
  }

  reportCleanupFailure(event: LiveHiveHostEvent): void {
    const handler = this.onEvent;
    if (handler === undefined) {
      return;
    }
    try {
      handler(event);
    } catch {
      // Observability must not change unload behavior.
    }
  }

  assertNotDisposed(): void {
    if (this.disposed) {
      throw new LiveHiveHostDisposedError();
    }
  }
}

function createRunTracker(
  options: LiveHiveHostOptions,
  report: (event: LiveHiveHostEvent) => void,
): RunTracker {
  return new RunTracker({
    now: options.now ?? Date.now,
    ...(options.runStore === undefined ? {} : { runStore: options.runStore }),
    onSaveError: (graphId, runId, error) =>
      report({
        type: 'graph.run-store-failed',
        graphId,
        runId,
        error: messageOf(error),
      }),
  });
}

export function snapshotHovered(snapshot: PheromoneFieldSnapshot): boolean {  for (const state of Object.values(snapshot.nodes)) {
    if (state.hover !== undefined) {
      return true;
    }
  }
  return false;
}

/**
 * A field may be flushed and released while parked on hover(s) only.
 *
 * At least one node hovers, and no node has active, pending or queued work. An
 * incomplete Merge join is allowed: the hover branch can still be waiting in
 * it, and Honey persists joins together with the hover. A guard hover is
 * allowed too, even though in practice it coexists with its own active
 * execution and therefore is not quiescent.
 */
export function isQuiescentHover(snapshot: PheromoneFieldSnapshot): boolean {
  let hovered = false;
  for (const state of Object.values(snapshot.nodes)) {
    if (
      state.active !== undefined ||
      state.pending !== undefined ||
      state.queue.length > 0
    ) {
      return false;
    }
    if (state.hover !== undefined) {
      hovered = true;
    }
  }
  return hovered;
}

export function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer: ${String(value)}`);
  }
}

function readBooleanOption(
  value: boolean | undefined,
  name: string,
  fallback: boolean,
): boolean {
  const resolved = value ?? fallback;
  if (typeof resolved !== 'boolean') {
    throw new TypeError(`${name} must be a boolean`);
  }
  return resolved;
}

function positiveIntegerOption(
  value: number | undefined,
  name: string,
): number | undefined {
  if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
