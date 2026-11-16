import type { GraphId, ResidencySnapshot } from '../../graph/registry.js';
import type { NodeId, PheromoneFieldSnapshot, Value } from '../../runtime/index.js';
import type { LiveHiveCatalogEntry } from '../live-hive-catalog.js';
import { snapshotHovered } from './context.js';
import type { GraphHostContext } from './context.js';
import type { GraphNodeStatus, GraphStatus, LiveGraph } from './types.js';
import { GraphNotFoundError } from './types.js';

/** Read-only status, catalog, session and output views over the live registry. */
export class GraphHostRead {
  constructor(private readonly context: GraphHostContext) {}

  /** Read-only view; it never acquires, touches or loads a graph. */
  status(): readonly GraphStatus[] {
    return this.context.graphs.list().map((entry) =>
      this.statusFrom(entry.id, entry.value, entry.value.runtime.snapshot(), entry.residency),
    );
  }

  /** Read-only view of one graph; `undefined` when it is not loaded. */
  statusOf(graphId: GraphId): GraphStatus | undefined {
    const entry = this.context.graphs.peek(graphId);
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
   * Read-only catalog snapshot. An unloaded LiveHive keeps its identity and
   * last-unload reason; without a catalog this is empty.
   */
  catalogEntries(): readonly LiveHiveCatalogEntry[] {
    return this.context.catalog?.list() ?? [];
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
    for (const entry of this.context.graphs.list()) {
      for (const record of entry.value.instantiated.sessions.values()) {
        ids.add(record.sessionId);
      }
    }
    return ids;
  }

  /**
   * Last completed Value of every forager in one loaded graph, keyed by node
   * id. It is a read-only snapshot: `peek` never refreshes the idle TTL, takes
   * a lease or changes residency, so reading output cannot extend a graph's
   * life. An unknown graph throws `GraphNotFoundError`; an unloaded graph's
   * output is deliberately not persisted and therefore unreadable.
   */
  outputsOf(graphId: GraphId): ReadonlyMap<NodeId, Value> {
    this.context.assertNotDisposed();
    const entry = this.context.graphs.peek(graphId);
    if (entry === undefined) {
      throw new GraphNotFoundError(graphId);
    }
    const outputs = new Map<NodeId, Value>();
    for (const [nodeId, executor] of entry.value.instantiated.executors) {
      const output = executor.lastOutput;
      if (output !== undefined) {
        outputs.set(nodeId, output);
      }
    }
    return outputs;
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
}
