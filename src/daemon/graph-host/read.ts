import type { LiveHiveId, ResidencySnapshot } from '../../graph/registry.js';
import type { NodeId, PheromoneFieldSnapshot, Value } from '../../runtime/index.js';
import type { LiveHiveCatalogEntry } from '../live-hive-catalog.js';
import { snapshotHovered } from './context.js';
import type { LiveHiveHostContext } from './context.js';
import type { LiveHiveNodeStatus, LiveHiveStatus, LiveGraph } from './types.js';
import { LiveHiveHostNotFoundError } from './types.js';

/** Read-only status, catalog, session and output views over the live registry. */
export class LiveHiveHostRead {
  constructor(private readonly context: LiveHiveHostContext) {}

  /** Read-only view; it never acquires, touches or loads a graph. */
  status(): readonly LiveHiveStatus[] {
    // A dispatch graph is a transient execution detail, not a LiveHive: it is
    // deliberately absent from the list view even during its short lifetime.
    // `statusOf` still reads it for the host's own result path.
    return this.context.graphs
      .list()
      .filter((entry) => !entry.value.ephemeral)
      .map((entry) =>
        this.statusFrom(entry.id, entry.value, entry.value.runtime.snapshot(), entry.residency),
      );
  }

  /** Read-only view of one graph; `undefined` when it is not loaded. */
  statusOf(graphId: LiveHiveId): LiveHiveStatus | undefined {
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

  /** Read-only bee/node -> session mapping for one loaded graph. */
  bindingsOf(graphId: LiveHiveId): ReadonlyMap<NodeId, string> {
    this.context.assertNotDisposed();
    const entry = this.context.graphs.peek(graphId);
    if (entry === undefined) {
      throw new LiveHiveHostNotFoundError(graphId);
    }
    const bindings = new Map<NodeId, string>();
    for (const [nodeId, record] of entry.value.instantiated.sessions) {
      bindings.set(nodeId, record.sessionId);
    }
    return bindings;
  }

  /**
   * Last completed Value of every bee in one loaded graph, keyed by node id.
   * It is the field-owned, memory-only cache (D2): a read-only snapshot;
   * `peek` never refreshes the idle TTL, takes a lease or changes residency, so
   * reading output cannot extend a graph's life. An unknown graph throws
   * `LiveHiveHostNotFoundError`; an unloaded graph's output is released with
   * its field and is therefore unreadable.
   */
  outputsOf(graphId: LiveHiveId): ReadonlyMap<NodeId, Value> {
    this.context.assertNotDisposed();
    const entry = this.context.graphs.peek(graphId);
    if (entry === undefined) {
      throw new LiveHiveHostNotFoundError(graphId);
    }
    const outputs = new Map<NodeId, Value>();
    for (const [nodeId, state] of Object.entries(entry.value.runtime.snapshot().nodes)) {
      if (state.lastOutput !== undefined) {
        outputs.set(nodeId, state.lastOutput);
      }
    }
    return outputs;
  }

  private statusFrom(
    graphId: LiveHiveId,
    live: LiveGraph,
    snapshot: PheromoneFieldSnapshot,
    residency: ResidencySnapshot,
  ): LiveHiveStatus {
    const nodes: LiveHiveNodeStatus[] = [];
    for (const node of live.definition.nodes.values()) {
      const state = snapshot.nodes[node.id];
      nodes.push({
        nodeId: node.id,
        kind: node.kind,
        receptor: state?.receptor.length ?? 0,
        pending: state?.pending !== undefined,
        active: state?.active !== undefined,
        hovered: state?.hover !== undefined,
        gathers: state?.gathers === undefined ? 0 : Object.keys(state.gathers).length,
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
