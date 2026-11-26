import type { LiveHiveId, SweepReport } from '../../graph/registry.js';
import { GraphAlreadyLoadedError } from '../../graph/registry.js';
import {
  instantiateForagers,
  type InstantiatedForagers,
} from '../../session/instantiate-foragers.js';
import {
  PheromoneRuntime,
  type GuardRequest,
  type LateActivationOutcome,
  type NodeId,
  type PersistedField,
  type RecoveryReport,
  type RuntimeOptions,
} from '../../runtime/index.js';
import type { SchedulerState } from '../scheduler.js';
import { assertNonNegativeInteger, messageOf } from './context.js';
import type { LiveHiveHostContext } from './context.js';
import type { LiveHiveHostExecution } from './execution.js';
import type { LiveHiveHostRead } from './read.js';
import { handleRestTransition } from './rest.js';
import type { SessionOwnership } from './session-ownership.js';
import {
  flushAndRelease,
  lateResultHook,
  releaseGraphResources,
} from './unload.js';
import {
  LiveHiveHostDisposedError,
  LiveHiveHostLoadError,
  LiveHiveHostNotFoundError,
  type LiveHiveStatus,
  type LiveGraph,
  type LoadGraphOptions,
} from './types.js';

/** Load/unload/sweep/dispose, Honey flush and scheduler lifecycle. */
export class LiveHiveHostLifecycle {
  constructor(
    private readonly context: LiveHiveHostContext,
    private readonly read: LiveHiveHostRead,
    private readonly ownership: SessionOwnership,
    private readonly execution: LiveHiveHostExecution,
  ) {
    this.context.setUnloadHandler((graphId, live) =>
      flushAndRelease(this.context, this.ownership, graphId, live),
    );
  }

  loadGraph(options: LoadGraphOptions): Promise<LiveHiveStatus> {
    if (this.context.disposed) {
      return Promise.reject(new LiveHiveHostDisposedError());
    }
    const graphId = options.definition.id;
    // A second lazy load must fail fast, not queue behind the first.
    if (this.context.loading.has(graphId) || this.context.graphs.peek(graphId) !== undefined) {
      return Promise.reject(
        new LiveHiveHostLoadError(graphId, `Graph is already loaded: ${graphId}`),
      );
    }
    // Reserve explicit sessions before the async load as ownership bookkeeping,
    // not as mutual exclusion. Shared explicit sessions are allowed and are
    // serialized later by the adapter FIFO. A failed load releases only the
    // sessions this call added; a duplicate graph id is refused by the earlier
    // loading/graphs check.
    let release: () => void;
    try {
      release = this.ownership.reserve(graphId, options.bindings);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.context.lock
      .run(graphId, () => loadGraphLocked(this.context, this.read, this.execution, options))
      .finally(() => {
        // A load that never became visible releases its reservations; a load
        // that registered keeps them until unload/dispose.
        if (this.context.graphs.peek(graphId) === undefined) {
          release();
        }
      });
  }

  /**
   * Flush Honey without releasing the graph. The live lock makes the snapshot
   * consistent with an in-flight trigger; a failed flush leaves memory intact.
   */
  save(graphId: LiveHiveId): Promise<LiveHiveStatus> {
    return this.context.lock.run(graphId, async () => {
      this.context.assertNotDisposed();
      const live = this.context.graphs.peek(graphId)?.value;
      if (live === undefined) {
        throw new LiveHiveHostNotFoundError(graphId);
      }
      // A quiet observation before the snapshot: a running drain (including a
      // native execution) is awaited within the host wait bound. A timeout does
      // not cancel the activation, so the saved field may still be active.
      await live.runtime.settle(this.context.maxWaitMs);
      if (live.honey !== undefined) {
        await live.honey.save(live.runtime.exportField());
        const schedulerState = this.context.schedulers.exportState(graphId);
        if (schedulerState !== undefined) {
          live.honey.saveScheduler(schedulerState);
        }
      }
      const status = this.read.statusOf(graphId);
      if (status === undefined) {
        throw new LiveHiveHostNotFoundError(graphId);
      }
      return status;
    });
  }

  /**
   * Explicit unload. Refused while pinned, busy or unsafe (a pending Guard).
   * The field is snapshotted immediately and a running activation is detached:
   * its late result loads the field again and completes the restored active.
   */
  async unload(graphId: LiveHiveId): Promise<boolean> {
    // A mutating operation never overlaps another one for the same id. It does
    // not queue behind a running native execution: admission already released
    // the live lock, so unload can snapshot and detach immediately.
    const outcome = await this.context.lock.tryRun(graphId, async () => {
      // An ephemeral dispatch graph never entered the catalog, so its unload
      // must not create an entry. Read the flag while the entry still exists.
      const ephemeral = this.context.graphs.peek(graphId)?.value.ephemeral === true;
      const unloaded = await this.context.graphs.unload(graphId);
      if (unloaded && !ephemeral) {
        this.context.updateCatalog(graphId, 'unload', (catalog) =>
          catalog.markUnloaded(graphId, 'unload'),
        );
      }
      return unloaded;
    });
    return outcome.acquired ? outcome.value : false;
  }

  /** One TTL pass; the registry skips unsafe entries and still needs no lock. */
  async sweep(): Promise<SweepReport> {
    // Dispatch graphs have TTL disabled, but a sweep racing an unload must
    // still avoid writing a catalog entry for an id that never had one.
    const ephemeral = new Set(
      this.context.graphs
        .list()
        .filter((entry) => entry.value.ephemeral)
        .map((entry) => entry.id),
    );
    const report = await this.context.graphs.sweep();
    for (const graphId of report.unloaded) {
      if (ephemeral.has(graphId)) {
        continue;
      }
      this.context.updateCatalog(graphId, 'sweep', (catalog) =>
        catalog.markUnloaded(graphId, 'sweep'),
      );
    }
    return report;
  }

  /** Idempotent best-effort shutdown; unsafe graphs and sessions are retained. */
  dispose(): Promise<void> {
    if (this.context.disposePromise !== undefined) {
      return this.context.disposePromise;
    }
    this.context.disposed = true;
    // Stop timers even for a non-Rest graph that dispose cannot unload.
    this.context.schedulers.stopAll();
    this.ownership.clear();
    this.context.disposePromise = disposeAll(this.context);
    return this.context.disposePromise;
  }
}

function isEphemeral(options: LoadGraphOptions): boolean {
  return options.ephemeral === true;
}

function runtimeLimitOptions(context: LiveHiveHostContext): {
  readonly receptorOverflowPolicy: 'reject' | 'block';
  readonly receptorBlockTimeoutMs: number;
} {
  return {
    receptorOverflowPolicy: context.receptorOverflowPolicy,
    receptorBlockTimeoutMs: context.receptorBlockTimeoutMs,
  };
}

function honeyForLoad(
  context: LiveHiveHostContext,
  graphId: LiveHiveId,
  ephemeral: boolean | undefined,
): ReturnType<NonNullable<LiveHiveHostContext['honeyForGraph']>> | undefined {
  return ephemeral === true ? undefined : context.honeyForGraph?.(graphId);
}

function markLoaded(
  context: LiveHiveHostContext,
  graphId: LiveHiveId,
  ephemeral: boolean | undefined,
): void {
  if (ephemeral !== true) {
    context.updateCatalog(graphId, 'load', (catalog) => catalog.markLoaded(graphId));
  }
}

async function loadGraphLocked(
  context: LiveHiveHostContext,
  read: LiveHiveHostRead,
  execution: LiveHiveHostExecution,
  options: LoadGraphOptions,
): Promise<LiveHiveStatus> {
  context.assertNotDisposed();
  const graphId = options.definition.id;
  if (context.loading.has(graphId) || context.graphs.peek(graphId) !== undefined) {
    throw new LiveHiveHostLoadError(graphId, `Graph is already loaded: ${graphId}`);
  }
  if (options.idleTtlMs !== undefined) {
    assertNonNegativeInteger(options.idleTtlMs, 'idleTtlMs');
  }
  const honey = honeyForLoad(context, graphId, options.ephemeral);
  let persisted: PersistedField | undefined;
  let schedulerState: SchedulerState | undefined;
  // A host that does not restore still keeps `honey` for trigger/unload flushes.
  if (honey !== undefined && (options.restoreHoney ?? context.restoreHoney)) {
    try {
      // Load before creating any session: a corrupt or unsupported Honey
      // file must not leave a fresh session behind.
      persisted = honey.load();
      if (options.definition.triggers.length > 0) {
        schedulerState = honey.loadScheduler();
      }
    } catch (error) {
      throw new LiveHiveHostLoadError(
        graphId,
        `Failed to load Honey for graph '${graphId}': ${messageOf(error)}`,
        { cause: error },
      );
    }
  }

  context.loading.add(graphId);
  let instantiated: InstantiatedForagers | undefined;
  let schedulerStarted = false;
  try {
    const harnesses = context.registry.harnesses();
    const defaultHarness =
      options.defaultHarness ?? (harnesses.length === 1 ? harnesses[0] : undefined);
    instantiated = await instantiateForagers({
      definition: options.definition,
      graphId,
      bindings: options.bindings,
      registry: context.registry,
      ...(defaultHarness === undefined ? {} : { defaultHarness }),
      project: options.project,
      ...(context.bindingStore === undefined ? {} : { bindingStore: context.bindingStore }),
    });

    // A dispose may have started while instantiation was in flight. The
    // graph must not become reachable after the host was disposed.
    if (context.disposed) {
      await releaseGraphResources(context, graphId, instantiated, options.bindings, 'rollback');
      instantiated = undefined;
      throw new LiveHiveHostDisposedError();
    }

    // The LiveHive id is known only here, so the host stamps it onto every
    // guard request before the control surface can list it. The expiry hook
    // and the decision itself are unchanged.
    const onLateResult = lateResultHook(
      context,
      options,
      instantiated,
      honey,
      (reloadOptions) =>
        loadGraphLocked(context, read, execution, reloadOptions).then(() => undefined),
    );
    const runtimeOptions = runtimeOptionsFor(
      context,
      graphId,
      options,
      instantiated,
      onLateResult,
    );
    let runtime: PheromoneRuntime;
    let recovery: RecoveryReport | undefined;
    if (persisted === undefined) {
      runtime = new PheromoneRuntime(options.definition, runtimeOptions);
    } else {
      try {
        const restored = PheromoneRuntime.restore(
          options.definition,
          persisted,
          runtimeOptions,
        );
        runtime = restored.runtime;
        recovery = restored.report;
      } catch (error) {
        // The outer catch releases the sessions and routing created above.
        throw new LiveHiveHostLoadError(
          graphId,
          `Failed to restore Honey for graph '${graphId}': ${messageOf(error)}`,
          { cause: error },
        );
      }
    }
    const live: LiveGraph = {
      definition: options.definition,
      bindings: options.bindings,
      project: options.project,
      instantiated,
      runtime,
      honey,
      recovery,
      ephemeral: isEphemeral(options),
    };
    // Start the scheduler before the registry load. Its fire callback is
    // deferred through a microtask, so it cannot run before the graph is
    // registered; a start/persist failure still rolls back the load.
    context.schedulers.start(
      graphId,
      options.definition,
      {
        ...(schedulerState === undefined ? {} : { state: schedulerState }),
        persist: (state) => {
          if (honey !== undefined) {
            honey.saveScheduler(state);
          }
        },
      },
      (trigger) =>
        execution.trigger(graphId, trigger.target, { message: '' }).then(
          () => undefined,
        ),
    );
    schedulerStarted = true;

    const residency =
      options.idleTtlMs === undefined ? {} : { idleTtlMs: options.idleTtlMs };
    try {
      context.graphs.load(graphId, live, residency);
    } catch (error) {
      await releaseGraphResources(context, graphId, instantiated, options.bindings, 'rollback');
      instantiated = undefined;
      if (error instanceof GraphAlreadyLoadedError) {
        throw new LiveHiveHostLoadError(graphId, `Graph is already loaded: ${graphId}`, {
          cause: error,
        });
      }
      throw error;
    }

    // Ownership has transferred to the registry; a failure after this point
    // must not clean up resources the registry is still serving.
    instantiated = undefined;
    const status = read.statusOf(graphId);
    if (status === undefined) {
      throw new LiveHiveHostLoadError(graphId, `Graph failed to register: ${graphId}`);
    }
    markLoaded(context, graphId, options.ephemeral);
    return status;
  } catch (error) {
    if (schedulerStarted) {
      context.schedulers.stop(graphId);
    }
    if (instantiated !== undefined) {
      await releaseGraphResources(context, graphId, instantiated, options.bindings, 'rollback');
      instantiated = undefined;
    }
    if (error instanceof GraphAlreadyLoadedError) {
      throw new LiveHiveHostLoadError(graphId, `Graph is already loaded: ${graphId}`, {
        cause: error,
      });
    }
    throw error;
  } finally {
    context.loading.delete(graphId);
  }
}

function runtimeOptionsFor(
  context: LiveHiveHostContext,
  graphId: LiveHiveId,
  options: LoadGraphOptions,
  instantiated: InstantiatedForagers,
  onLateResult: (nodeId: NodeId, outcome: LateActivationOutcome) => void,
): RuntimeOptions {
  const onGuard = context.onGuard;
  return {
    executeForager: instantiated.routing,
    projectDirectory: options.project.directory,
    now: context.now,
    sleep: context.sleep,
    onChange: () => {
      try {
        // The field's own last-change clock is mirrored onto residency, so the
        // idle TTL is measured from the last field mutation.
        context.graphs.touch(graphId);
      } catch {
        // The graph is not registered yet (restore) or already unloading.
      }
    },
    onRest: () => handleRestTransition(context, graphId),
    onLateResult,
    ...(onGuard === undefined
      ? {}
      : { onGuard: (request: GuardRequest) => onGuard({ ...request, liveId: graphId }) }),
    ...(context.onGuardExpired === undefined
      ? {}
      : { onGuardExpired: context.onGuardExpired }),
    ...(context.guardTimeoutMs === undefined
      ? {}
      : { guardTimeoutMs: context.guardTimeoutMs }),
    ...runtimeLimitOptions(context),
  };
}

async function disposeAll(context: LiveHiveHostContext): Promise<void> {
  for (const entry of context.graphs.list()) {
    try {
      // Non-blocking: release the field (a running activation hands its result
      // back to this host, which is already disposing, so it is dropped).
      await context.lock.tryRun(entry.id, async () => {
        const unloaded = await context.graphs.unload(entry.id);
        if (unloaded && !entry.value.ephemeral) {
          context.updateCatalog(entry.id, 'dispose', (catalog) =>
            catalog.markUnloaded(entry.id, 'dispose'),
          );
        }
        return unloaded;
      });
    } catch {
      // Registry unload reports failures itself; this is a defensive guard
      // so one broken graph cannot stop the others.
    }
  }
}

