import type { GraphId, SweepReport } from '../graph/registry.js';
import type { NodeId, Value } from '../runtime/index.js';
import type { LiveHiveCatalogEntry } from './live-hive-catalog.js';
import { GraphHostContext } from './graph-host/context.js';
import { GraphHostExecution } from './graph-host/execution.js';
import { GraphHostLifecycle } from './graph-host/lifecycle.js';
import { GraphHostRead } from './graph-host/read.js';
import { SessionOwnership } from './graph-host/session-ownership.js';
import type {
  GraphHostOptions,
  GraphRunResult,
  GraphStatus,
  LoadGraphOptions,
} from './graph-host/types.js';

export type {
  GraphAnswerErrorReason,
  GraphHostEvent,
  GraphHostOptions,
  GraphNodeStatus,
  GraphRunResult,
  GraphStatus,
  LoadGraphOptions,
} from './graph-host/types.js';
export {
  GraphAnswerError,
  GraphHostDisposedError,
  GraphLoadError,
  GraphNotFoundError,
  GraphSessionBusyError,
} from './graph-host/types.js';

/**
 * Facade over the lifecycle, execution and read services.
 *
 * Public behavior and errors are unchanged from the M9e host. Mutating
 * operations for one live id (load, unload, trigger, answer) are serialized by
 * the shared lock; status, catalog and output paths remain lock-free reads. `sweep`
 * and `dispose` remain best-effort multi-live registry passes.
 */
export class GraphHost {
  private readonly context: GraphHostContext;
  private readonly read: GraphHostRead;
  private readonly execution: GraphHostExecution;
  private readonly ownership: SessionOwnership;
  private readonly lifecycle: GraphHostLifecycle;

  constructor(options: GraphHostOptions) {
    this.context = new GraphHostContext(options);
    this.read = new GraphHostRead(this.context);
    this.execution = new GraphHostExecution(this.context, this.read);
    this.ownership = new SessionOwnership(this.context);
    this.lifecycle = new GraphHostLifecycle(
      this.context,
      this.read,
      this.ownership,
      this.execution,
    );
  }

  loadGraph(options: LoadGraphOptions): Promise<GraphStatus> {
    return this.lifecycle.loadGraph(options);
  }

  trigger(graphId: GraphId, nodeId: NodeId, value: Value): Promise<GraphRunResult> {
    return this.execution.trigger(graphId, nodeId, value);
  }

  answer(
    graphId: GraphId,
    nodeId: NodeId,
    value: Value,
    token?: string,
  ): Promise<GraphRunResult> {
    return this.execution.answer(graphId, nodeId, value, token);
  }

  /** Read-only view; it never acquires, touches or loads a graph. */
  status(): readonly GraphStatus[] {
    return this.read.status();
  }

  /** Read-only view of one graph; `undefined` when it is not loaded. */
  statusOf(graphId: GraphId): GraphStatus | undefined {
    return this.read.statusOf(graphId);
  }

  /** Read-only catalog snapshot. */
  catalogEntries(): readonly LiveHiveCatalogEntry[] {
    return this.read.catalogEntries();
  }

  /** Session ids bound to every currently loaded graph. */
  loadedSessionIds(): ReadonlySet<string> {
    return this.read.loadedSessionIds();
  }

  /** Read-only bee/node -> session mapping for one loaded graph. */
  bindingsOf(graphId: GraphId): ReadonlyMap<NodeId, string> {
    return this.read.bindingsOf(graphId);
  }

  /** Last completed Value of every forager in one loaded graph. */
  outputsOf(graphId: GraphId): ReadonlyMap<NodeId, Value> {
    return this.read.outputsOf(graphId);
  }

  /** Flush Honey/scheduler without unloading or disposing the graph. */
  save(graphId: GraphId): Promise<GraphStatus> {
    return this.lifecycle.save(graphId);
  }

  unload(graphId: GraphId): Promise<boolean> {
    return this.lifecycle.unload(graphId);
  }

  sweep(): Promise<SweepReport> {
    return this.lifecycle.sweep();
  }

  dispose(): Promise<void> {
    return this.lifecycle.dispose();
  }
}
