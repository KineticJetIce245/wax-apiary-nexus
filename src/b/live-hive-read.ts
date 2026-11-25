import type { LiveHiveStatus } from '../daemon/graph-host.js';
import type { LiveHiveRunState, LiveHiveRunView } from '../daemon/graph-host.js';
import type { LiveHiveCatalogEntry } from '../daemon/live-hive-catalog.js';
import type { RunRecord, RunStatus, RunStore } from '../storage/run-store.js';
import type { LiveHiveHost } from '../daemon/graph-host.js';
import type { LiveHiveRepository } from './live-hive-repository.js';
import { LiveHiveServiceError } from './live-hive-service-errors.js';

export interface LiveHiveSummary {
  readonly liveId: string;
  readonly state: 'loaded' | 'unloaded';
  readonly status?: LiveHiveStatus;
  readonly catalog?: LiveHiveCatalogEntry;
}

export interface LiveHiveOutputResult {
  readonly liveId: string;
  readonly runId: string;
  readonly outputs: RunRecord['outputs'];
  readonly status: RunStatus;
  readonly operation: RunRecord['operation'];
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly error?: string;
}

export interface LiveHiveInspectResult {
  readonly liveId: string;
  readonly status?: LiveHiveStatus;
  readonly outputs: readonly { readonly nodeId: string; readonly value: unknown }[];
  readonly catalog?: LiveHiveCatalogEntry;
}

/** Read-only list/output view shared by the B service and HTTP routes. */
export class LiveHiveReadService {
  constructor(
    private readonly liveHiveHost: LiveHiveHost,
    private readonly repository: LiveHiveRepository,
    private readonly runStore: RunStore | undefined,
  ) {}

  list(): readonly LiveHiveSummary[] {
    const statuses = new Map(
      this.liveHiveHost.status().map((status) => [status.graphId, status]),
    );
    const catalog = new Map(
      this.liveHiveHost.catalogEntries().map((entry) => [entry.liveId, entry]),
    );
    const ids = new Set<string>([
      ...statuses.keys(),
      ...catalog.keys(),
      ...this.repository.listLiveIds(),
    ]);
    return [...ids].sort().map((liveId) => {
      const status = statuses.get(liveId);
      const entry = catalog.get(liveId);
      const state: LiveHiveSummary['state'] = status !== undefined
        ? 'loaded'
        : (entry?.state ?? 'unloaded');
      return {
        liveId,
        state,
        ...(status === undefined ? {} : { status }),
        ...(entry === undefined ? {} : { catalog: entry }),
      };
    });
  }

  inspect(liveId: string): LiveHiveInspectResult {
    const id = this.repository.requireLiveId(liveId);
    const status = this.liveHiveHost.statusOf(id);
    const catalog = this.liveHiveHost.catalogEntries().find((entry) => entry.liveId === id);
    if (status === undefined && catalog === undefined && !this.repository.cached(id)) {
      throw new LiveHiveServiceError('not-found', `live hive is not loaded: ${id}`);
    }
    // outputsOf requires a loaded graph. An unloaded live is a valid read:
    // return its catalog identity and an empty output list, never a 500.
    const outputs = status === undefined
      ? []
      : [...this.liveHiveHost.outputsOf(id).entries()]
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([nodeId, value]) => ({ nodeId, value }));
    return {
      liveId: id,
      ...(status === undefined ? {} : { status }),
      outputs,
      ...(catalog === undefined ? {} : { catalog }),
    };
  }

  output(liveId: string, runId?: string): LiveHiveOutputResult {
    const id = this.repository.requireLiveId(liveId);
    const store = this.runStore;
    if (store === undefined) {
      throw new LiveHiveServiceError('not-found', 'run output is not available');
    }
    const record = runId === undefined ? store.latestForLive(id) : store.get(runId);
    if (record === undefined || record.liveId !== id) {
      throw new LiveHiveServiceError('not-found', 'run output is not available');
    }
    return {
      liveId: record.liveId,
      runId: record.runId,
      outputs: record.outputs,
      status: record.status,
      operation: record.operation,
      startedAt: record.startedAt,
      ...(record.finishedAt === undefined ? {} : { finishedAt: record.finishedAt }),
      ...(record.error === undefined ? {} : { error: record.error }),
    };
  }

  /** One run from the live tracker, falling back to the durable record. */
  run(liveId: string, runId: string): LiveHiveRunView {
    const id = this.repository.requireLiveId(liveId);
    const tracked = this.liveHiveHost.runs.get(id, runId);
    if (tracked !== undefined) {
      return tracked;
    }
    const record = this.runStore?.get(runId);
    if (record === undefined || record.liveId !== id) {
      throw new LiveHiveServiceError('not-found', 'run is not available');
    }
    return {
      runId: record.runId,
      traceId: record.traceId ?? '',
      state: stateOfRecord(record.status),
      outputs: record.outputs,
      ...(record.error === undefined ? {} : { error: record.error }),
      startedAt: record.startedAt,
      ...(record.finishedAt === undefined ? {} : { finishedAt: record.finishedAt }),
    };
  }
}

function stateOfRecord(status: RunStatus): LiveHiveRunState {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'unknown':
      return 'unknown';
    default:
      return 'unknown';
  }
}
