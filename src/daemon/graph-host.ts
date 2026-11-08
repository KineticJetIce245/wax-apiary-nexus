import type { GraphBindings } from '../graph/binding.js';
import type { GraphBindingStore } from '../graph/binding-store.js';
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
  /**
   * Allow an explicit unload or TTL sweep of a graph whose only non-Rest state
   * is quiescent hover(s): at least one user or guard hover and no active,
   * pending or queued Pheromone anywhere. Default false, preserving the M4a
   * Rest-only behavior. With Honey the field (including the hover) is flushed
   * before release, so a reload can still answer it.
   */
  readonly allowHoverUnload?: boolean;
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
  /**
   * Durable `fresh_once` reuse mappings. Required whenever a loaded graph uses
   * `fresh_once`; the instantiation layer rejects that mode without a store.
   */
  readonly bindingStore?: GraphBindingStore;
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

/** Why `GraphHost.answer` refused an answer. */
export type GraphAnswerErrorReason =
  | 'unknown-node'
  | 'not-user-node'
  | 'no-hover'
  | 'token-mismatch';

/**
 * A typed answer rejection. The message carries only ids the caller already
 * sent and the reason; it never carries a hover token, value or prompt.
 */
export class GraphAnswerError extends Error {
  constructor(
    readonly graphId: GraphId,
    readonly nodeId: NodeId,
    readonly reason: GraphAnswerErrorReason,
    options?: ErrorOptions,
  ) {
    super(`Answer rejected for node '${nodeId}' in graph '${graphId}': ${reason}`, options);
    this.name = 'GraphAnswerError';
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

/** What one `trigger`/`answer` run reached, before the status is re-read. */
interface QuiescenceOutcome {
  readonly pumps: number;
  readonly snapshot: PheromoneFieldSnapshot;
  readonly persisted: boolean;
  readonly persistError?: string;
}

/**
 * In-memory graph host with optional Honey persistence.
 *
 * It composes the pieces landed in M1-M3b. Load creates fresh sessions through
 * `instantiateForagers`; trigger and answer hold a residency lease across pumps,
 * pacing waits and the final Honey flush.
 *
 * Sessions are decoupled from graphs. A normal unload, TTL sweep or dispose
 * releases routing but never closes a session and never removes a `fresh_once`
 * mapping: `fresh_always`, `fresh_once` and borrowed sessions all outlive the
 * graph and are closed only explicitly (or by a load rollback, which closes
 * exactly the sessions that load created). Without Honey, M4a semantics are
 * unchanged: unload and sweep are Rest-only and the default idle TTL is 0. With
 * Honey, the field is restored on load and flushed on trigger, answer and
 * before every unload; a failed flush keeps the graph loaded and its resources
 * open.
 *
 * `allowHoverUnload` opts a daemon into unloading a field that is parked on
 * quiescent hover(s) only; the default stays Rest-only.
 */
export class GraphHost {
  private readonly workspace: Workspace;
  private readonly sessionRegistry: SessionRegistry;
  private readonly allowHoverUnload: boolean;
  private readonly now: () => number;
  private readonly defaultIdleTtlMs: number;
  private readonly honeyForGraph: ((graphId: string) => HoneyStore) | undefined;
  private readonly bindingStore: GraphBindingStore | undefined;
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
    this.allowHoverUnload = options.allowHoverUnload ?? false;
    if (typeof this.allowHoverUnload !== 'boolean') {
      throw new TypeError('allowHoverUnload must be a boolean');
    }
    this.now = options.now ?? (() => Date.now());
    this.honeyForGraph = options.honeyForGraph;
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
    this.onEvent = options.onEvent;
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
        graphId,
        bindings: options.bindings,
        registry: this.sessionRegistry,
        workspace: this.workspace,
        project: options.project,
        ...(this.bindingStore === undefined ? {} : { bindingStore: this.bindingStore }),
      });

      // A dispose may have started while instantiation was in flight. The
      // graph must not become reachable after the host was disposed.
      if (this.disposed) {
        await this.releaseGraphResources(graphId, instantiated, options.bindings, 'rollback');
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
        await this.releaseGraphResources(graphId, instantiated, options.bindings, 'rollback');
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
        await this.releaseGraphResources(graphId, instantiated, options.bindings, 'rollback');
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
    let outcome: QuiescenceOutcome | undefined;
    try {
      const live = lease.value;
      live.runtime.trigger(nodeId, value);
      outcome = await this.pumpToQuiescence(live);
      // A completed run touched every session the graph is bound to. The
      // lease is still held, so the bound set cannot change under us.
      this.touchSessions(live);
    } finally {
      // The lease spans `trigger`, the whole pump loop, every pacing wait and
      // the final Honey flush.
      lease.release();
    }

    if (outcome === undefined) {
      // Unreachable: `pumpToQuiescence` either returns or throws.
      throw new GraphNotFoundError(graphId);
    }
    return this.resultOf(graphId, outcome);
  }

  /**
   * Answers one open user hover.
   *
   * The answer is rejected instead of queued when no user hover is open right
   * now: a control caller is answering a concrete parked Pheromone, not seeding
   * an early answer. The whole run holds the residency lease, pumps to
   * quiescence and flushes Honey exactly like `trigger`; a flush failure is
   * reported, never retried.
   */
  async answer(
    graphId: GraphId,
    nodeId: NodeId,
    value: Value,
    token?: string,
  ): Promise<GraphRunResult> {
    this.assertNotDisposed();
    const lease = this.acquireLease(graphId);
    let outcome: QuiescenceOutcome | undefined;
    try {
      const live = lease.value;
      this.assertAnswerable(live, graphId, nodeId, token);
      live.runtime.answerHover(nodeId, value, token);
      outcome = await this.pumpToQuiescence(live);
      // Same as trigger: a settled answer refreshes every bound session's
      // idle clock while the lease still protects the bound set.
      this.touchSessions(live);
    } finally {
      // The lease spans the answer, the whole pump loop, every pacing wait and
      // the final Honey flush.
      lease.release();
    }

    if (outcome === undefined) {
      // Unreachable: `pumpToQuiescence` either returns or throws.
      throw new GraphNotFoundError(graphId);
    }
    return this.resultOf(graphId, outcome);
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
   * Session ids bound to every currently loaded graph, in graph load order.
   *
   * This is a read-only snapshot for the explicit session API: a session in
   * this set is still routed to by a loaded graph and must not be closed. It
   * never attaches or mutates a session, and an unloaded graph contributes
   * nothing even though its sessions (and `fresh_once` mappings) survive.
   */
  loadedSessionIds(): ReadonlySet<string> {
    const ids = new Set<string>();
    for (const entry of this.graphs.list()) {
      for (const record of entry.value.instantiated.sessions.values()) {
        ids.add(record.sessionId);
      }
    }
    return ids;
  }

  /**
   * Explicit unload. Refused while the graph is busy, pinned or not safe to
   * unload (Rest, or a quiescent hover when `allowHoverUnload` is set); a
   * refused unload does not dispose routing. With Honey the field is flushed
   * first: if that save fails the unload returns false and the graph stays
   * loaded. A successful unload never closes a session.
   */
  async unload(graphId: GraphId): Promise<boolean> {
    return this.graphs.unload(graphId);
  }

  /** One TTL pass. Unsafe graphs are skipped, never flushed. */
  async sweep(): Promise<SweepReport> {
    return this.graphs.sweep();
  }

  /**
   * Idempotent, best-effort shutdown. Unloads every graph that is safe to
   * unload; a busy or otherwise unsafe graph stays loaded so its field is never
   * silently discarded. A graph whose Honey flush fails also stays loaded.
   * Sessions are retained: dispose releases routing only, exactly like an
   * explicit unload. The Workspace is not stopped.
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

  /**
   * Refresh the idle clock of every session bound to a graph that just ran.
   *
   * Sessions are otherwise protected while bound (the control server excludes
   * `loadedSessionIds()`), but their `lastAccessAt` must still reflect the run:
   * once the graph is unloaded the session becomes an orphan and would
   * otherwise look as idle as it was when the graph was loaded.
   *
   * Best effort by design: touching is observability for idle cleanup and must
   * never turn a completed trigger/answer into a failure.
   */
  private touchSessions(live: LiveGraph): void {
    for (const record of live.instantiated.sessions.values()) {
      try {
        this.sessionRegistry.touch(record.sessionId);
      } catch {
        // The session may have been closed concurrently or its store write may
        // have failed; neither changes the run's result.
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

  /**
   * Pumps a live field until Rest or a hover, honoring `maxPumps`/`maxWaitMs`,
   * then flushes Honey. Shared by trigger and answer so both have exactly one
   * pumping and persistence path.
   *
   * The caller holds the residency lease across this call, so a TTL sweep
   * cannot unload between the last pump and the flush. A failed save is
   * reported in the outcome, never retried and never replayed.
   */
  private async pumpToQuiescence(live: LiveGraph): Promise<QuiescenceOutcome> {
    let pumps = 0;
    let waitedMs = 0;
    let snapshot = live.runtime.snapshot();
    let persisted = true;
    let persistError: string | undefined;

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
      try {
        await live.honey.save(live.runtime.exportField());
      } catch (error) {
        persisted = false;
        persistError = messageOf(error);
      }
    }

    return {
      pumps,
      snapshot,
      persisted,
      ...(persistError === undefined ? {} : { persistError }),
    };
  }

  /**
   * Build the public result after the lease is released, so the embedded
   * residency snapshot reports `refCount: 0`.
   */
  private resultOf(graphId: GraphId, outcome: QuiescenceOutcome): GraphRunResult {
    const status = this.statusOf(graphId);
    if (status === undefined) {
      throw new GraphNotFoundError(graphId);
    }
    return {
      graphId,
      rest: outcome.snapshot.rest,
      hovered: snapshotHovered(outcome.snapshot),
      pumps: outcome.pumps,
      status,
      persisted: outcome.persisted,
      ...(outcome.persistError === undefined
        ? {}
        : { persistError: outcome.persistError }),
    };
  }

  /**
   * Reject an answer that does not match the currently open user hover.
   *
   * `PheromoneRuntime.answerHover` also accepts an answer before the next hover
   * and queues it for later. The control surface deliberately does not: it is
   * answering a concrete parked Pheromone and tells the caller when the hover
   * is not open. This check and the `answerHover` call run without an await
   * between them, so no other request can resolve the hover in between.
   */
  private assertAnswerable(
    live: LiveGraph,
    graphId: GraphId,
    nodeId: NodeId,
    token: string | undefined,
  ): void {
    const node = live.definition.nodes.get(nodeId);
    if (node === undefined) {
      throw new GraphAnswerError(graphId, nodeId, 'unknown-node');
    }
    if (node.kind !== 'user') {
      throw new GraphAnswerError(graphId, nodeId, 'not-user-node');
    }
    const hover = live.runtime.snapshot().nodes[nodeId]?.hover;
    if (hover === undefined || hover.kind !== 'user') {
      throw new GraphAnswerError(graphId, nodeId, 'no-hover');
    }
    if (token !== undefined && token !== hover.token) {
      throw new GraphAnswerError(graphId, nodeId, 'token-mismatch');
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
    await this.releaseGraphResources(graphId, live.instantiated, live.bindings, 'retain');
  }

  /**
   * Cleanup hook used by explicit unload, TTL sweep, dispose and load rollback.
   * It never rejects: GraphRegistry must be able to forget the graph even if a
   * close fails.
   *
   * `mode` names the two deliberately different semantics:
   *
   * - `retain`: a normal unload/sweep/dispose. Only routing is disposed. No
   *   session is closed and no `fresh_once` mapping is removed, whatever the
   *   binding kind: sessions are explicitly closed through the session API, not
   *   as a side effect of graph residency.
   * - `rollback`: a load that never became visible. Every session this load
   *   created (once and always) is closed and the `fresh_once` mappings it
   *   created are removed. A reused session is never in
   *   `createdSessionIds`, so it is never closed or removed here.
   */
  private async releaseGraphResources(
    graphId: GraphId,
    instantiated: InstantiatedForagers,
    bindings: GraphBindings,
    mode: 'retain' | 'rollback',
  ): Promise<void> {
    const sessionIds =
      mode === 'rollback' ? [...instantiated.createdSessionIds] : [];

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

    if (mode === 'rollback' && this.bindingStore !== undefined) {
      const created = new Set(instantiated.createdSessionIds);
      for (const [nodeId, record] of instantiated.sessions) {
        if (!created.has(record.sessionId)) {
          continue;
        }
        const binding = bindings[nodeId];
        if (
          binding === undefined ||
          binding.kind !== 'fresh' ||
          (binding.mode ?? 'always') !== 'once'
        ) {
          continue;
        }
        try {
          this.bindingStore.remove(graphId, nodeId);
        } catch (error) {
          // Mapping cleanup shares the session cleanup event: the failure is
          // metadata only and must not mask the original load failure.
          this.reportCleanupFailure({
            type: 'graph.cleanup-failed',
            graphId,
            phase: 'session',
            sessionId: record.sessionId,
            error: messageOf(error),
          });
        }
      }
    }

    for (const sessionId of sessionIds) {
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
 * A field may be flushed and released while parked on hover(s) only.
 *
 * At least one node hovers, and no node has active, pending or queued work. An
 * incomplete Merge join is allowed: the hover branch can still be waiting in
 * it, and Honey persists joins together with the hover. A guard hover is
 * allowed too, even though in practice it coexists with its own active
 * execution and therefore is not quiescent.
 */
function isQuiescentHover(snapshot: PheromoneFieldSnapshot): boolean {
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

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer: ${String(value)}`);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
