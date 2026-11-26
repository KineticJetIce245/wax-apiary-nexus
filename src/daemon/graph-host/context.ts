import { GraphRegistry, type LiveHiveId } from '../../graph/registry.js';
import { DEFAULT_IDLE_TTL_MS } from '../../graph/residency.js';
import type { GuardDecision, GuardRequest, PheromoneFieldSnapshot } from '../../runtime/index.js';
import { readReceptorOverflowOptions } from '../../runtime/index.js';
import type { SessionRegistry } from '../../session/session-registry.js';
import type { HoneyStore } from '../../storage/honey.js';
import type { LiveHiveCatalog } from '../live-hive-catalog.js';
import { LiveHiveLock } from '../live-hive-lock.js';
import { SchedulerService } from '../scheduler-service.js';
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
  readonly guardTimeoutMs: number | undefined;
  readonly schedulers: SchedulerService;
  readonly now: () => number;
  readonly defaultIdleTtlMs: number;
  readonly honeyForGraph: ((graphId: string) => HoneyStore) | undefined;
  readonly restoreHoney: boolean;
  readonly bindingStore: LiveHiveHostOptions['bindingStore'];
  readonly sleep: (ms: number) => Promise<void>;
  readonly maxWaitMs: number;
  readonly onGuard: ((request: GuardRequest) => Promise<GuardDecision>) | undefined;
  readonly onGuardExpired: ((requestId: string) => void) | undefined;
  readonly receptorOverflowPolicy: 'reject' | 'block';
  readonly receptorBlockTimeoutMs: number;
  readonly onEvent: ((event: LiveHiveHostEvent) => void) | undefined;
  readonly graphs: GraphRegistry<LiveGraph>;
  readonly lock = new LiveHiveLock();
  readonly loading = new Set<LiveHiveId>();

  disposed = false;
  disposePromise: Promise<void> | undefined;
  private unloadHandler: UnloadHandler = async () => {
    throw new Error('graph unload handler is not configured');
  };

  constructor(options: LiveHiveHostOptions) {
    this.registry = options.registry;
    this.catalog = options.catalog;
    this.guardTimeoutMs = positiveIntegerOption(options.guardTimeoutMs, 'guardTimeoutMs');
    this.now = options.now ?? (() => Date.now());
    this.honeyForGraph = options.honeyForGraph;
    this.restoreHoney = readBooleanOption(options.restoreHoney, 'restoreHoney', true);
    this.bindingStore = options.bindingStore;
    this.defaultIdleTtlMs =
      options.defaultIdleTtlMs ??
      (options.honeyForGraph === undefined ? 0 : DEFAULT_IDLE_TTL_MS);
    assertNonNegativeInteger(this.defaultIdleTtlMs, 'defaultIdleTtlMs');
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
    const receptor = readReceptorOverflowOptions(options);
    this.receptorOverflowPolicy = receptor.policy;
    this.receptorBlockTimeoutMs = receptor.blockTimeoutMs;
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
      // Idle unload is a snapshot: a user hover or an active activation may be
      // released. A pending Guard blocks it, because an approval cannot be
      // answered after its runtime is gone. Field changes renew the TTL.
      isSafeToUnload: (_id, live) => !hasPendingGuard(live),
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

export function snapshotHovered(snapshot: PheromoneFieldSnapshot): boolean {
  for (const state of Object.values(snapshot.nodes)) {
    if (state.hover !== undefined) {
      return true;
    }
  }
  return false;
}

/**
 * A pending Guard is the one hover that cannot be restored: its native request
 * and waiter are gone after an unload. It blocks idle unload; a user hover does
 * not, because it is persisted and answerable after a reload.
 */
export function hasPendingGuard(live: LiveGraph): boolean {
  for (const state of Object.values(live.runtime.snapshot().nodes)) {
    if (state.hover?.kind === 'guard') {
      return true;
    }
  }
  return false;
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
