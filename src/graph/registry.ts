import {
  GraphResidency,
  GraphUnloadingError,
  type GraphId,
  type GraphLoadState,
  type ResidencyOptions,
  type ResidencySnapshot,
} from './residency.js';

export { GraphUnloadingError };
export type { GraphId, GraphLoadState, ResidencyOptions, ResidencySnapshot };

export class GraphAlreadyLoadedError extends Error {
  constructor(readonly graphId: GraphId) {
    super(`Graph is already loaded: ${graphId}`);
    this.name = 'GraphAlreadyLoadedError';
  }
}

export class GraphNotLoadedError extends Error {
  constructor(readonly graphId: GraphId) {
    super(`Graph is not loaded: ${graphId}`);
    this.name = 'GraphNotLoadedError';
  }
}

export interface GraphLease<T> {
  readonly id: GraphId;
  readonly value: T;
  release(): void;
}

export interface GraphRegistryOptions<T> {
  readonly now: () => number;
  readonly defaultIdleTtlMs?: number;
  /** Defaults to always safe. */
  readonly isSafeToUnload?: (id: GraphId, value: T) => boolean;
  /** Flush hook; it must settle before the graph is forgotten. */
  readonly onUnload?: (id: GraphId, value: T) => void | Promise<void>;
  readonly onEvent?: (event: GraphRegistryEvent<T>) => void;
}

export type GraphRegistryEvent<T> =
  | { readonly type: 'graph.loaded'; readonly id: GraphId; readonly at: number }
  | {
      readonly type: 'graph.unloaded';
      readonly id: GraphId;
      readonly at: number;
      readonly reason: 'ttl' | 'explicit';
    }
  | {
      readonly type: 'graph.unload-failed';
      readonly id: GraphId;
      readonly at: number;
      readonly reason: 'ttl' | 'explicit';
      readonly error: string;
    };

export interface GraphRegistryEntry<T> {
  readonly id: GraphId;
  readonly value: T;
  readonly residency: ResidencySnapshot;
}

export type SweepSkipReason =
  | 'pinned'
  | 'busy'
  | 'unloading'
  | 'disabled'
  | 'not-expired'
  | 'unsafe';

export interface SweepReport {
  readonly unloaded: readonly GraphId[];
  readonly skipped: readonly { readonly id: GraphId; readonly reason: SweepSkipReason }[];
  readonly failed: readonly { readonly id: GraphId; readonly error: string }[];
}

interface RegisteredGraph<T> {
  readonly id: GraphId;
  readonly value: T;
  readonly residency: GraphResidency;
}

/**
 * In-memory registry of loaded graphs. It owns no timers, files or I/O: the
 * caller supplies the clock, calls `sweep()` when it wants TTL eviction, and
 * supplies `onUnload` for the flush. A graph is forgotten only after its flush
 * settles successfully.
 */
export class GraphRegistry<T> {
  private readonly entries = new Map<GraphId, RegisteredGraph<T>>();
  private readonly now: () => number;
  private readonly defaultIdleTtlMs: number | undefined;
  private readonly isSafeToUnload: (id: GraphId, value: T) => boolean;
  private readonly onUnload: ((id: GraphId, value: T) => void | Promise<void>) | undefined;
  private readonly onEvent: ((event: GraphRegistryEvent<T>) => void) | undefined;

  constructor(options: GraphRegistryOptions<T>) {
    this.now = options.now;
    this.defaultIdleTtlMs = options.defaultIdleTtlMs;
    this.isSafeToUnload = options.isSafeToUnload ?? (() => true);
    this.onUnload = options.onUnload;
    this.onEvent = options.onEvent;
  }

  load(id: GraphId, value: T, options: ResidencyOptions = {}): void {
    if (this.entries.has(id)) {
      throw new GraphAlreadyLoadedError(id);
    }
    const now = this.now();
    const idleTtlMs = options.idleTtlMs ?? this.defaultIdleTtlMs;
    const residency = new GraphResidency(now, {
      ...(idleTtlMs === undefined ? {} : { idleTtlMs }),
      ...(options.pinned === undefined ? {} : { pinned: options.pinned }),
    });
    this.entries.set(id, { id, value, residency });
    this.emit({ type: 'graph.loaded', id, at: now });
  }

  acquire(id: GraphId): GraphLease<T> {
    const entry = this.requireLoaded(id);
    const now = this.now();
    entry.residency.acquire();
    entry.residency.touch(now);
    let released = false;
    return {
      id,
      value: entry.value,
      release: () => {
        if (released) {
          return;
        }
        released = true;
        // The lease keeps its own entry; unload skips a positive refCount, so
        // this entry cannot have been replaced while the lease is held.
        entry.residency.release();
      },
    };
  }

  peek(id: GraphId): GraphRegistryEntry<T> | undefined {
    const entry = this.entries.get(id);
    return entry === undefined ? undefined : this.entrySnapshot(entry, this.now());
  }

  list(): readonly GraphRegistryEntry<T>[] {
    const now = this.now();
    return [...this.entries.values()].map((entry) => this.entrySnapshot(entry, now));
  }

  touch(id: GraphId): void {
    this.requireLoaded(id).residency.touch(this.now());
  }

  pin(id: GraphId): void {
    this.requireLoaded(id).residency.pin(this.now());
  }

  unpin(id: GraphId): void {
    this.requireLoaded(id).residency.unpin(this.now());
  }

  /**
   * One TTL eviction pass. All decisions use a single clock reading. Entries
   * that are already being flushed by a concurrent pass are skipped, never
   * flushed twice.
   */
  async sweep(): Promise<SweepReport> {
    const now = this.now();
    const unloaded: GraphId[] = [];
    const skipped: { id: GraphId; reason: SweepSkipReason }[] = [];
    const failed: { id: GraphId; error: string }[] = [];

    for (const entry of [...this.entries.values()]) {
      const residency = entry.residency.snapshot(now);
      if (residency.pinned) {
        skipped.push({ id: entry.id, reason: 'pinned' });
        continue;
      }
      if (residency.refCount > 0) {
        skipped.push({ id: entry.id, reason: 'busy' });
        continue;
      }
      if (residency.state === 'unloading') {
        skipped.push({ id: entry.id, reason: 'unloading' });
        continue;
      }
      if (residency.idleTtlMs === 0) {
        skipped.push({ id: entry.id, reason: 'disabled' });
        continue;
      }
      if (!entry.residency.isExpired(now)) {
        skipped.push({ id: entry.id, reason: 'not-expired' });
        continue;
      }
      if (!this.isSafeToUnload(entry.id, entry.value)) {
        skipped.push({ id: entry.id, reason: 'unsafe' });
        continue;
      }

      entry.residency.beginUnload();
      try {
        await this.onUnload?.(entry.id, entry.value);
      } catch (error) {
        const message = messageOf(error);
        entry.residency.cancelUnload(now);
        failed.push({ id: entry.id, error: message });
        this.emit({
          type: 'graph.unload-failed',
          id: entry.id,
          at: now,
          reason: 'ttl',
          error: message,
        });
        continue;
      }
      this.entries.delete(entry.id);
      unloaded.push(entry.id);
      this.emit({ type: 'graph.unloaded', id: entry.id, at: now, reason: 'ttl' });
    }

    return { unloaded, skipped, failed };
  }

  /**
   * Explicit unload. Skips the TTL check but still refuses pinned, busy,
   * unloading and unsafe graphs. Returns whether the graph was forgotten.
   */
  async unload(id: GraphId, reason: 'explicit' = 'explicit'): Promise<boolean> {
    const entry = this.entries.get(id);
    if (entry === undefined) {
      return false;
    }
    const now = this.now();
    const residency = entry.residency.snapshot(now);
    if (residency.pinned || residency.refCount > 0 || residency.state === 'unloading') {
      return false;
    }
    if (!this.isSafeToUnload(id, entry.value)) {
      return false;
    }

    entry.residency.beginUnload();
    try {
      await this.onUnload?.(id, entry.value);
    } catch (error) {
      const message = messageOf(error);
      entry.residency.cancelUnload(now);
      this.emit({ type: 'graph.unload-failed', id, at: now, reason, error: message });
      return false;
    }
    this.entries.delete(id);
    this.emit({ type: 'graph.unloaded', id, at: now, reason });
    return true;
  }

  /**
   * Earliest deadline among graphs that could eventually be evicted by TTL.
   * Pinned graphs, TTL-disabled graphs and graphs already unloading are
   * excluded; a busy graph is included because its deadline still applies once
   * the lease is released.
   */
  nextEvictionAt(): number | undefined {
    let earliest: number | undefined;
    for (const entry of this.entries.values()) {
      const candidate = entry.residency.nextEvictionAt();
      if (candidate !== undefined && (earliest === undefined || candidate < earliest)) {
        earliest = candidate;
      }
    }
    return earliest;
  }

  size(): number {
    return this.entries.size;
  }

  private requireLoaded(id: GraphId): RegisteredGraph<T> {
    const entry = this.entries.get(id);
    if (entry === undefined) {
      throw new GraphNotLoadedError(id);
    }
    if (entry.residency.state !== 'loaded') {
      throw new GraphUnloadingError(id);
    }
    return entry;
  }

  private entrySnapshot(entry: RegisteredGraph<T>, now: number): GraphRegistryEntry<T> {
    return { id: entry.id, value: entry.value, residency: entry.residency.snapshot(now) };
  }

  private emit(event: GraphRegistryEvent<T>): void {
    if (this.onEvent === undefined) {
      return;
    }
    try {
      this.onEvent(event);
    } catch {
      // Observability must not corrupt residency state.
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
