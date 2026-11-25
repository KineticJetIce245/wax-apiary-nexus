import type { LiveHiveId, SweepReport } from '../graph/registry.js';
import type { NodeId, Value } from '../runtime/index.js';
import type { LiveHiveCatalogEntry } from './live-hive-catalog.js';
import { LiveHiveHostContext } from './graph-host/context.js';
import { LiveHiveHostExecution } from './graph-host/execution.js';
import { LiveHiveHostLifecycle } from './graph-host/lifecycle.js';
import { LiveHiveHostRead } from './graph-host/read.js';
import { SessionOwnership } from './graph-host/session-ownership.js';
import type {
  LiveHiveHostOptions,
  LiveHiveRunResult,
  LiveHiveStatus,
  LoadGraphOptions,
} from './graph-host/types.js';

export type {
  LiveHiveHostAnswerErrorReason,
  LiveHiveHostEvent,
  LiveHiveHostOptions,
  LiveHiveNodeStatus,
  LiveHiveRunResult,
  LiveHiveStatus,
  LoadGraphOptions,
} from './graph-host/types.js';
export {
  LiveHiveHostAnswerError,
  LiveHiveHostDisposedError,
  LiveHiveHostLoadError,
  LiveHiveHostNotFoundError,
} from './graph-host/types.js';

/**
 * Facade over the lifecycle, execution and read services.
 *
 * Public behavior and errors are unchanged from the M9e host. Mutating
 * operations for one live id (load, unload, trigger, answer) are serialized by
 * the shared lock; status, catalog and output paths remain lock-free reads. `sweep`
 * and `dispose` remain best-effort multi-live registry passes.
 */
export class LiveHiveHost {
  private readonly context: LiveHiveHostContext;
  private readonly read: LiveHiveHostRead;
  private readonly execution: LiveHiveHostExecution;
  private readonly ownership: SessionOwnership;
  private readonly lifecycle: LiveHiveHostLifecycle;

  constructor(options: LiveHiveHostOptions) {
    this.context = new LiveHiveHostContext(options);
    this.read = new LiveHiveHostRead(this.context);
    this.execution = new LiveHiveHostExecution(this.context, this.read);
    this.ownership = new SessionOwnership();
    this.lifecycle = new LiveHiveHostLifecycle(
      this.context,
      this.read,
      this.ownership,
      this.execution,
    );
  }

  loadGraph(options: LoadGraphOptions): Promise<LiveHiveStatus> {
    return this.lifecycle.loadGraph(options);
  }

  trigger(graphId: LiveHiveId, nodeId: NodeId, value: Value): Promise<LiveHiveRunResult> {
    return this.execution.trigger(graphId, nodeId, value);
  }

  answer(
    graphId: LiveHiveId,
    nodeId: NodeId,
    value: Value,
    token?: string,
  ): Promise<LiveHiveRunResult> {
    return this.execution.answer(graphId, nodeId, value, token);
  }

  /** Read-only view; it never acquires, touches or loads a graph. */
  status(): readonly LiveHiveStatus[] {
    return this.read.status();
  }

  /** Read-only view of one graph; `undefined` when it is not loaded. */
  statusOf(graphId: LiveHiveId): LiveHiveStatus | undefined {
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
  bindingsOf(graphId: LiveHiveId): ReadonlyMap<NodeId, string> {
    return this.read.bindingsOf(graphId);
  }

  /** Last completed Value of every forager in one loaded graph. */
  outputsOf(graphId: LiveHiveId): ReadonlyMap<NodeId, Value> {
    return this.read.outputsOf(graphId);
  }

  /** Flush Honey/scheduler without unloading or disposing the graph. */
  save(graphId: LiveHiveId): Promise<LiveHiveStatus> {
    return this.lifecycle.save(graphId);
  }

  unload(graphId: LiveHiveId): Promise<boolean> {
    return this.lifecycle.unload(graphId);
  }

  sweep(): Promise<SweepReport> {
    return this.lifecycle.sweep();
  }

  dispose(): Promise<void> {
    return this.lifecycle.dispose();
  }
}
