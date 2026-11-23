import type { GraphBindings } from '../../graph/binding.js';
import type { GraphBindingStore } from '../../graph/binding-store.js';
import type { GraphId } from '../../graph/registry.js';
import type { Project } from '../../project/kernel.js';
import type {
  CompositionDefinition,
  GuardDecision,
  GuardRequest,
  NodeId,
  PheromoneRuntime,
  RecoveryReport,
} from '../../runtime/index.js';
import type { InstantiatedForagers } from '../../session/instantiate-foragers.js';
import type { SessionRegistry } from '../../session/session-registry.js';
import type { HoneyStore } from '../../storage/honey.js';
import type { RunStore } from '../../storage/run-store.js';
import type { LiveHiveCatalog } from '../live-hive-catalog.js';
import type { SchedulerTimers } from '../scheduler.js';

export interface GraphHostOptions {
  readonly registry: SessionRegistry;
  /**
   * Optional identity index. Successful load/unload/sweep/dispose and graph
   * access are recorded, but catalog persistence is best effort: a write
   * failure is reported as metadata and never changes residency.
   */
  readonly catalog?: LiveHiveCatalog;
  /** Durable run records; when omitted run ids are generated but not stored. */
  readonly runStore?: RunStore;
  /** Native guard timeout, shared with the control broker; default 1h. */
  readonly guardTimeoutMs?: number;
  /** Test seam for scheduler timers. */
  readonly schedulerTimers?: SchedulerTimers;
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
   * Whether load restores the existing Honey field. Default true. `false`
   * starts from an empty field even when Honey exists, while the store is
   * still used for trigger/unload flushes (the ephemeral b-core run).
   */
  readonly restoreHoney?: boolean;
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
   * Native approval handler, passed straight to every runtime this host loads
   * (same seam as the A path's `runComposition`). Without it the runtime
   * rejects a Guard request; a Guard is never allowed automatically.
   */
  readonly onGuard?: (request: GuardRequest) => Promise<GuardDecision>;
  /** Called when a runtime guard deadline expires; idempotent. */
  readonly onGuardExpired?: (requestId: string) => void;
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
  /**
   * Harness for fresh bindings that do not name one. A manifest's `harness`
   * supplies this; direct HTTP loads may omit it and rely on a one-workspace
   * registry.
   */
  readonly defaultHarness?: string;
  /**
   * Override the host's Honey-restore policy for this load. The default keeps
   * existing behavior; an explicit structural migration may start from an
   * empty field when the composition revision changed.
   */
  readonly restoreHoney?: boolean;
  /**
   * A dispatch graph: one request creates it, runs it and unloads it. It is a
   * normal loaded graph for trigger/output/unload, but the host never creates
   * a Honey store, catalog entry or `lives/` file for it. The caller must still
   * unload it; it is not a persistent LiveHive.
   */
  readonly ephemeral?: boolean;
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
  readonly runId: string;
  readonly requestId: string;
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
    }
  | {
      readonly type: 'graph.catalog-failed';
      readonly graphId: GraphId;
      readonly phase: 'load' | 'access' | 'unload' | 'sweep' | 'dispose';
      readonly error: string;
    }
  | {
      readonly type: 'graph.run-store-failed';
      readonly graphId: GraphId;
      readonly runId: string;
      readonly error: string;
    }
  | {
      readonly type: 'scheduler.trigger-failed';
      readonly graphId: GraphId;
      readonly triggerId: string;
      readonly error: string;
    }
  | {
      readonly type: 'scheduler.unconfirmed';
      readonly graphId: GraphId;
      readonly triggerId: string;
      readonly scheduledFor: string;
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
export interface LiveGraph {
  readonly definition: CompositionDefinition;
  readonly bindings: GraphBindings;
  readonly project: Project;
  readonly instantiated: InstantiatedForagers;
  readonly runtime: PheromoneRuntime;
  /** Absent for a purely in-memory host and for an ephemeral dispatch graph. */
  readonly honey: HoneyStore | undefined;
  /** What Honey restore could not keep running; absent without a restore. */
  readonly recovery: RecoveryReport | undefined;
  /** True for a dispatch graph; it is never persisted or listed as a LiveHive. */
  readonly ephemeral: boolean;
}


