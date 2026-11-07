import type { GraphBindings } from '../graph/binding.js';
import {
  GraphAlreadyLoadedError,
  GraphNotLoadedError,
  GraphRegistry,
  GraphUnloadingError,
  type GraphId,
  type GraphLease,
  type ResidencySnapshot,
  type SweepReport,
} from '../graph/registry.js';
import { DEFAULT_IDLE_TTL_MS } from '../graph/residency.js';
import type { Project } from '../project/kernel.js';
import {
  PheromoneRuntime,
  type CompositionDefinition,
  type NodeId,
  type PersistedField,
  type PheromoneFieldSnapshot,
  type RecoveryReport,
  type Value,
} from '../runtime/index.js';
import {
  instantiateForagers,
  type InstantiatedForagers,
} from '../session/instantiate-foragers.js';
import type { SessionRegistry } from '../session/session-registry.js';
import type { Workspace } from '../session/workspace.js';
import type { HoneyStore } from '../storage/honey.js';

export interface GraphHostOptions {
  readonly workspace: Workspace;
  readonly registry: SessionRegistry;
  /** Residency clock; default `Date.now`. */
  readonly now?: () => number;
  /**
   * Default idle TTL; without Honey it defaults to 0 (automatic idle unload
   * disabled). When `honeyForGraph` is configured it defaults to 30 minutes:
   * the loaded field has a durable copy, so eviction is recoverable.
   */
  readonly defaultIdleTtlMs?: number;
  /**
   * Durable store per graph. When present, load restores the persisted field,
   * trigger flushes it, and unload/sweep flush before releasing resources.
   * Omit it for a purely in-memory host (M4a behavior).
   */
  readonly honeyForGraph?: (graphId: string) => HoneyStore;
  /** Max pump iterations for one trigger; default 50. */
  readonly maxPumps?: number;
  /**
   * Sleep seam for pacing waits (node `minIntervalMs` and merge deadlines).
   * Default setTimeout. A trigger never hot-spins while work is rate-limited.
   */
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * Total pacing wait allowed for one trigger; default 30_000. Non-negative
   * integer; 0 means no waiting (only the immediate pump rounds run).
   */
  readonly maxWaitMs?: number;
  /**
   * Optional observability for cleanup failures. Cleanup itself never rejects:
   * a failed close must not turn an unload into a residency failure.
   */
  readonly onEvent?: (event: GraphHostEvent) => void;
}

export interface LoadGraphOptions {
  readonly definition: CompositionDefinition;
  readonly bindings: GraphBindings;
  readonly project: Project;
  readonly idleTtlMs?: number;
}

export interface GraphNodeStatus {
  readonly nodeId: string;
  readonly kind: string;
  readonly queue: number;
  readonly pending: boolean;
  readonly active: boolean;
  readonly hovered: boolean;
  /** Join records, including closed tombstones (same as `wax inspect status`). */
  readonly joins: number;
}

export interface GraphStatus {
  readonly graphId: string;
  readonly graphRevision: string;
  readonly rest: boolean;
  readonly hovered: boolean;
  readonly nodes: readonly GraphNodeStatus[];
  /**
   * What a Honey restore could not keep running, keyed by node id only. It
   * never carries a prompt, output or Pheromone body.
   */
  readonly recovery?: {
    readonly resumedHovers: readonly string[];
    readonly unknownActive: readonly string[];
    readonly stuckActive: readonly string[];
  };
  readonly residency: {
    readonly state: 'loaded' | 'unloading';
    readonly loadedAt: number;
    readonly lastAccessAt: number;
    readonly idleTtlMs: number;
    readonly pinned: boolean;
    readonly refCount: number;
    readonly nextEvictionAt?: number;
  };
}

export interface GraphRunResult {
  readonly graphId: string;
  readonly rest: boolean;
  readonly hovered: boolean;
  readonly pumps: number;
  readonly status: GraphStatus;
  /**
   * Whether the field is durably saved after this run. `true` without Honey:
   * there is nothing to persist. A Honey save failure is reported here instead
   * of reloading or replaying the trigger.
   */
  readonly persisted: boolean;
  /** Honey save failure message; never contains a prompt or output body. */
  readonly persistError?: string;
}

/**
 * A cleanup failure is reported as metadata only: graph id, phase and the
 * session id when one was involved. It never carries a prompt or output body.
 */
export type GraphHostEvent =
  | {
      readonly type: 'graph.cleanup-failed';
      readonly graphId: GraphId;
      readonly phase: 'routing';
      readonly error: string;
    }
  | {
      readonly type: 'graph.cleanup-failed';
      readonly graphId: GraphId;
      readonly phase: 'session';
      readonly sessionId: string;
      readonly error: string;
    };

export class GraphNotFoundError extends Error {
  constructor(
    readonly graphId: GraphId,
    options?: ErrorOptions,
  ) {
    super(`Graph is not loaded: ${graphId}`, options);
    this.name = 'GraphNotFoundError';
  }
}

export class GraphLoadError extends Error {
  constructor(
    readonly graphId: GraphId,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'GraphLoadError';
  }
}

/** The host was disposed; it no longer accepts loads or triggers. */
export class GraphHostDisposedError extends Error {
  constructor() {
    super('Graph host is disposed');
    this.name = 'GraphHostDisposedError';
  }
}

/** The live, in-memory value the residency registry keeps for one graph. */
interface LiveGraph {
  readonly definition: CompositionDefinition;
  readonly bindings: GraphBindings;
  readonly project: Project;
  readonly instantiated: InstantiatedForagers;
  readonly runtime: PheromoneRuntime;
  /** Absent for a purely in-memory host. */
  readonly honey: HoneyStore | undefined;
  /** What Honey restore could not keep running; absent without a restore. */
  readonly recovery: RecoveryReport | undefined;
}

/**
 * In-memory graph host with optional Honey persistence.
 *
 * It composes the pieces landed in M1-M3b. Load creates fresh sessions through
 * `instantiateForagers`; trigger holds a residency lease across pumps and
 * pacing waits; unload closes only the sessions this graph created and leaves
 * borrowed sessions alone. Without Honey, M4a semantics are unchanged: unload
 * and sweep are Rest-only and the default idle TTL is 0. With Honey, the field
 * is restored on load and flushed on trigger and before every unload; a failed
 * flush keeps the graph loaded and its resources open.
 */
export class GraphHost {
  private readonly workspace: Workspace;
  private readonly sessionRegistry: SessionRegistry;
  private readonly now: () => number;
  private readonly defaultIdleTtlMs: number;
  private readonly honeyForGraph: ((graphId: string) => HoneyStore) | undefined;
  private readonly maxPumps: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxWaitMs: number;
  private readonly onEvent: ((event: GraphHostEvent) => void) | undefined;
  private readonly graphs: GraphRegistry<LiveGraph>;
  private readonly loading = new Set<GraphId>();
  private disposed = false;
  private disposePromise: Promise<void> | undefined;

  constructor(options: GraphHostOptions) {
    this.workspace = options.workspace;
    this.sessionRegistry = options.registry;
    this.now = options.now ?? (() => Date.now());
    this.honeyForGraph = options.honeyForGraph;
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
    this.onEvent = options.onEvent;
    this.graphs = new GraphRegistry<LiveGraph>({
      now: this.now,
      defaultIdleTtlMs: this.defaultIdleTtlMs,
      // Unload stays Rest-only. Non-Rest work would have to be drained (or
      // explicitly abandoned) first; Honey only makes a Rest field replayable.
      isSafeToUnload: (_id, live) => live.runtime.snapshot().rest,
      onUnload: (id, live) => this.flushAndRelease(id, live),
    });
  }

  async loadGraph(options: LoadGraphOptions): Promise<GraphStatus> {
    this.assertNotDisposed();
    const graphId = options.definition.id;
    if (this.loading.has(graphId) || this.graphs.peek(graphId) !== undefined) {
      throw new GraphLoadError(graphId, `Graph is already loaded: ${graphId}`);
    }
    if (options.idleTtlMs !== undefined) {
      assertNonNegativeInteger(options.idleTtlMs, 'idleTtlMs');
    }

    const honey = this.honeyForGraph?.(graphId);
    let persisted: PersistedField | undefined;
    if (honey !== undefined) {
      try {
        // Load before creating any session: a corrupt or unsupported Honey
        // file must not leave a fresh session behind.
        persisted = honey.load();
      } catch (error) {
        throw new GraphLoadError(
          graphId,
          `Failed to load Honey for graph '${graphId}': ${messageOf(error)}`,
          { cause: error },
        );
      }
    }

    this.loading.add(graphId);
    let instantiated: InstantiatedForagers | undefined;
    try {
      instantiated = await instantiateForagers({
        definition: options.definition,
        bindings: options.bindings,
        registry: this.sessionRegistry,
        workspace: this.workspace,
        project: options.project,
      });

      // A dispose may have started while instantiation was in flight. The
      // graph must not become reachable after the host was disposed.
      if (this.disposed) {
        await this.releaseGraphResources(graphId, instantiated, options.bindings);
        instantiated = undefined;
        throw new GraphHostDisposedError();
      }

      const runtimeOptions = {
        executeForager: instantiated.routing,
        projectDirectory: options.project.directory,
        now: this.now,
      };
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
          throw new GraphLoadError(
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
      };
      const residency =
        options.idleTtlMs === undefined ? {} : { idleTtlMs: options.idleTtlMs };
      try {
        this.graphs.load(graphId, live, residency);
      } catch (error) {
        await this.releaseGraphResources(graphId, instantiated, options.bindings);
        instantiated = undefined;
        if (error instanceof GraphAlreadyLoadedError) {
          throw new GraphLoadError(graphId, `Graph is already loaded: ${graphId}`, {
            cause: error,
          });
        }
        throw error;
      }

      // Ownership has transferred to the registry; a failure after this point
      // must not clean up resources the registry is still serving.
      instantiated = undefined;
      const status = this.statusOf(graphId);
      if (status === undefined) {
        throw new GraphLoadError(graphId, `Graph failed to register: ${graphId}`);
      }
      return status;
    } catch (error) {
      if (instantiated !== undefined) {
        await this.releaseGraphResources(graphId, instantiated, options.bindings);
        instantiated = undefined;
      }
      if (error instanceof GraphAlreadyLoadedError) {
        throw new GraphLoadError(graphId, `Graph is already loaded: ${graphId}`, {
          cause: error,
        });
      }
      throw error;
    } finally {
      this.loading.delete(graphId);
    }
  }

  async trigger(graphId: GraphId, nodeId: NodeId, value: Value): Promise<GraphRunResult> {
    this.assertNotDisposed();
    const lease = this.acquireLease(graphId);
    const live = lease.value;
    let pumps = 0;
    let waitedMs = 0;
    let snapshot: PheromoneFieldSnapshot | undefined;
    let persisted = true;
    let persistError: string | undefined;
    try {
      live.runtime.trigger(nodeId, value);
      snapshot = live.runtime.snapshot();

      while (pumps < this.maxPumps && !snapshot.rest && !snapshotHovered(snapshot)) {
        await live.runtime.pump();
        pumps += 1;
        snapshot = live.runtime.snapshot();
        if (snapshot.rest || snapshotHovered(snapshot) || pumps >= this.maxPumps) {
          break;
        }

        // The field is not Rest and has no hover, so the only way forward is
        // time: a pending node's `minIntervalMs`, a merge deadline or the
        // runtime's queue retry. The lease stays held across this wait.
        const due = earliestDue(live.definition, live.runtime, snapshot);
        if (due === undefined) {
          break;
        }
        const remainingWaitMs = this.maxWaitMs - waitedMs;
        if (remainingWaitMs <= 0) {
          break;
        }
        const current = this.now();
        const dueInMs = due > current ? due - current : 0;
        if (dueInMs <= 0) {
          // Do not 0ms-spin: a due instant in the past means backpressure or
          // an already-expired wake signal, not work a new pump can finish.
          break;
        }
        const waitMs = Math.min(dueInMs, remainingWaitMs);
        if (waitMs <= 0) {
          break;
        }
        await this.sleep(waitMs);
        waitedMs += waitMs;
      }

      if (live.honey !== undefined) {
        // Still under the lease: a TTL sweep cannot unload between the last
        // pump and this flush. A failed save is reported, never retried and
        // never replayed as another trigger.
        try {
          await live.honey.save(live.runtime.exportField());
        } catch (error) {
          persisted = false;
          persistError = messageOf(error);
        }
      }
    } finally {
      // The lease spans `trigger`, the whole pump loop, every pacing wait and
      // the final Honey flush.
      lease.release();
    }

    if (snapshot === undefined) {
      // Unreachable: trigger() assigns it before its first await.
      throw new GraphNotFoundError(graphId);
    }
    const status = this.statusOf(graphId);
    if (status === undefined) {
      throw new GraphNotFoundError(graphId);
    }
    return {
      graphId,
      rest: snapshot.rest,
      hovered: snapshotHovered(snapshot),
      pumps,
      status,
      persisted,
      ...(persistError === undefined ? {} : { persistError }),
    };
  }

  /** Read-only view; it never acquires, touches or loads a graph. */
  status(): readonly GraphStatus[] {
    return this.graphs.list().map((entry) =>
      this.statusFrom(entry.id, entry.value, entry.value.runtime.snapshot(), entry.residency),
    );
  }

  /** Read-only view of one graph; `undefined` when it is not loaded. */
  statusOf(graphId: GraphId): GraphStatus | undefined {
    const entry = this.graphs.peek(graphId);
    if (entry === undefined) {
      return undefined;
    }
    return this.statusFrom(
      entry.id,
      entry.value,
      entry.value.runtime.snapshot(),
      entry.residency,
    );
  }

  /**
   * Explicit unload. Refused while the graph is busy, pinned or not at Rest;
   * a refused unload does not touch sessions or dispose routing. With Honey the
   * field is flushed first: if that save fails the unload returns false and the
   * graph stays loaded.
   */
  async unload(graphId: GraphId): Promise<boolean> {
    return this.graphs.unload(graphId);
  }

  /** One TTL pass. Non-Rest graphs are skipped as `unsafe`, never flushed. */
  async sweep(): Promise<SweepReport> {
    return this.graphs.sweep();
  }

  /**
   * Idempotent, best-effort shutdown. Unloads every graph that is safe to
   * unload (Rest); a non-Rest graph stays loaded so its field is never silently
   * discarded. A Rest graph whose Honey flush fails also stays loaded. The
   * Workspace is not stopped.
   */
  dispose(): Promise<void> {
    if (this.disposePromise !== undefined) {
      return this.disposePromise;
    }
    this.disposed = true;
    this.disposePromise = this.disposeAll();
    return this.disposePromise;
  }

  private async disposeAll(): Promise<void> {
    for (const entry of this.graphs.list()) {
      try {
        // A false return means the graph was busy, not Rest or its flush
        // failed: keep it rather than silently dropping field state.
        await this.graphs.unload(entry.id);
      } catch {
        // Registry unload reports failures itself; this is a defensive guard
        // so one broken graph cannot stop the others.
      }
    }
  }

  private acquireLease(graphId: GraphId): GraphLease<LiveGraph> {
    try {
      return this.graphs.acquire(graphId);
    } catch (error) {
      if (error instanceof GraphNotLoadedError || error instanceof GraphUnloadingError) {
        throw new GraphNotFoundError(graphId, { cause: error });
      }
      throw error;
    }
  }

  private statusFrom(
    graphId: GraphId,
    live: LiveGraph,
    snapshot: PheromoneFieldSnapshot,
    residency: ResidencySnapshot,
  ): GraphStatus {
    const nodes: GraphNodeStatus[] = [];
    for (const node of live.definition.nodes.values()) {
      const state = snapshot.nodes[node.id];
      nodes.push({
        nodeId: node.id,
        kind: node.kind,
        queue: state?.queue.length ?? 0,
        pending: state?.pending !== undefined,
        active: state?.active !== undefined,
        hovered: state?.hover !== undefined,
        joins: state?.joins === undefined ? 0 : Object.keys(state.joins).length,
      });
    }

    return {
      graphId,
      graphRevision: live.definition.graphRevision,
      rest: snapshot.rest,
      hovered: snapshotHovered(snapshot),
      nodes,
      ...(live.recovery === undefined
        ? {}
        : {
            recovery: {
              resumedHovers: [...live.recovery.resumedHovers],
              unknownActive: [...live.recovery.unknownActive],
              stuckActive: [...live.recovery.stuckActive],
            },
          }),
      residency: {
        state: residency.state,
        loadedAt: residency.loadedAt,
        lastAccessAt: residency.lastAccessAt,
        idleTtlMs: residency.idleTtlMs,
        pinned: residency.pinned,
        refCount: residency.refCount,
        ...(residency.nextEvictionAt === undefined
          ? {}
          : { nextEvictionAt: residency.nextEvictionAt }),
      },
    };
  }

  /**
   * Registry unload hook. The field is flushed before any resource is released:
   * only a successful save may dispose routing and close fresh sessions. A
   * failed save propagates, so the registry cancels the unload and keeps the
   * graph loaded, its status intact and its fresh sessions open.
   */
  private async flushAndRelease(graphId: GraphId, live: LiveGraph): Promise<void> {
    if (live.honey !== undefined) {
      await live.honey.save(live.runtime.exportField());
    }
    await this.releaseGraphResources(graphId, live.instantiated, live.bindings);
  }

  /**
   * Cleanup hook used by explicit unload and TTL sweep. It never rejects:
   * GraphRegistry must be able to forget the graph even if a close fails.
   * Fresh sessions are captured before routing is disposed; borrowed sessions
   * (binding kind `session`) are never closed here.
   */
  private async releaseGraphResources(
    graphId: GraphId,
    instantiated: InstantiatedForagers,
    bindings: GraphBindings,
  ): Promise<void> {
    const freshSessionIds = freshSessionIdsOf(instantiated, bindings);

    try {
      instantiated.dispose();
    } catch (error) {
      this.reportCleanupFailure({
        type: 'graph.cleanup-failed',
        graphId,
        phase: 'routing',
        error: messageOf(error),
      });
    }

    for (const sessionId of freshSessionIds) {
      try {
        await this.sessionRegistry.close(sessionId);
      } catch (error) {
        this.reportCleanupFailure({
          type: 'graph.cleanup-failed',
          graphId,
          phase: 'session',
          sessionId,
          error: messageOf(error),
        });
      }
    }
  }

  private reportCleanupFailure(event: GraphHostEvent): void {
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

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new GraphHostDisposedError();
    }
  }
}

function snapshotHovered(snapshot: PheromoneFieldSnapshot): boolean {
  for (const state of Object.values(snapshot.nodes)) {
    if (state.hover !== undefined) {
      return true;
    }
  }
  return false;
}

/**
 * The earliest instant a non-Rest field could make progress: the runtime's own
 * wake signal (merge deadline / queue retry) or a pending node whose
 * `minIntervalMs` has not elapsed. Same `nextPendingAt` logic as the CLI loop.
 */
function earliestDue(
  definition: CompositionDefinition,
  runtime: PheromoneRuntime,
  snapshot: PheromoneFieldSnapshot,
): number | undefined {
  const runtimeWake = runtime.nextWakeAt();
  const pendingDue = nextPendingAt(definition, snapshot);
  if (runtimeWake === undefined) {
    return pendingDue;
  }
  if (pendingDue === undefined) {
    return runtimeWake;
  }
  return Math.min(runtimeWake, pendingDue);
}

/**
 * Earliest `lastActivatedAt + node.minIntervalMs` among nodes with a pending
 * Pheromone. A missing timestamp is treated as due at 0; an unparsable one is
 * ignored, matching the existing CLI helper.
 */
function nextPendingAt(
  definition: CompositionDefinition,
  snapshot: PheromoneFieldSnapshot,
): number | undefined {
  let next: number | undefined;
  for (const [id, node] of definition.nodes) {
    const state = snapshot.nodes[id];
    if (state?.pending === undefined) {
      continue;
    }
    const last = state.lastActivatedAt;
    const due = last === undefined ? 0 : Date.parse(last) + node.minIntervalMs;
    if (!Number.isFinite(due)) {
      continue;
    }
    if (next === undefined || due < next) {
      next = due;
    }
  }
  return next;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Session ids this graph created itself. Only `fresh` bindings are closed on
 * unload; an existing `session` binding is borrowed and must stay open.
 */
function freshSessionIdsOf(
  instantiated: InstantiatedForagers,
  bindings: GraphBindings,
): readonly string[] {
  const ids = new Set<string>();
  for (const [nodeId, binding] of Object.entries(bindings)) {
    if (binding.kind !== 'fresh') {
      continue;
    }
    const record = instantiated.sessions.get(nodeId);
    if (record !== undefined) {
      ids.add(record.sessionId);
    }
  }
  return [...ids];
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer: ${String(value)}`);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
