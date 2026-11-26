import type { LiveHiveStatus } from '../daemon/graph-host.js';
import type { LiveHiveCatalogEntry } from '../daemon/live-hive-catalog.js';
import type { LiveHiveHost } from '../daemon/graph-host.js';
import type { LiveHiveRepository } from './live-hive-repository.js';
import { LiveHiveServiceError } from './live-hive-service-errors.js';

export interface LiveHiveSummary {
  readonly liveId: string;
  readonly state: 'loaded' | 'unloaded';
  readonly status?: LiveHiveStatus;
  readonly catalog?: LiveHiveCatalogEntry;
}

/** The field-owned last output per bee; never a run record or history. */
export interface LiveHiveOutputEntry {
  readonly nodeId: string;
  readonly value: unknown;
}

export interface LiveHiveOutputResult {
  readonly liveId: string;
  readonly outputs: readonly LiveHiveOutputEntry[];
}

export interface LiveHiveInspectResult {
  readonly liveId: string;
  readonly status?: LiveHiveStatus;
  readonly outputs: readonly LiveHiveOutputEntry[];
  readonly catalog?: LiveHiveCatalogEntry;
}

/** Read-only list/output view shared by the B service and HTTP routes. */
export class LiveHiveReadService {
  constructor(
    private readonly liveHiveHost: LiveHiveHost,
    private readonly repository: LiveHiveRepository,
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
    const outputs = status === undefined ? [] : this.outputsOf(id);
    return {
      liveId: id,
      ...(status === undefined ? {} : { status }),
      outputs,
      ...(catalog === undefined ? {} : { catalog }),
    };
  }

  /**
   * The field's last completed output per bee. There is no run id and no
   * history: an unloaded LiveHive has released its field and this throws
   * `not-found` instead of replaying a stale record.
   */
  output(liveId: string): LiveHiveOutputResult {
    const id = this.repository.requireLiveId(liveId);
    if (this.liveHiveHost.statusOf(id) === undefined) {
      throw new LiveHiveServiceError('not-found', 'live hive is not loaded');
    }
    return { liveId: id, outputs: this.outputsOf(id) };
  }

  private outputsOf(liveId: string): readonly LiveHiveOutputEntry[] {
    return [...this.liveHiveHost.outputsOf(liveId).entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([nodeId, value]) => ({ nodeId, value }));
  }
}
