export type GraphId = string;

export type GraphLoadState = 'loaded' | 'unloading';

export interface ResidencyOptions {
  /** Idle time before automatic eviction is allowed. `0` disables it. */
  readonly idleTtlMs?: number;
  readonly pinned?: boolean;
}

export interface ResidencySnapshot {
  readonly loadedAt: number;
  readonly lastAccessAt: number;
  readonly idleTtlMs: number;
  readonly pinned: boolean;
  readonly refCount: number;
  readonly state: GraphLoadState;
  /** Undefined when pinned, when the TTL is disabled, or while unloading. */
  readonly nextEvictionAt?: number;
}

export const DEFAULT_IDLE_TTL_MS = 30 * 60_000;

export class GraphUnloadingError extends Error {
  constructor(readonly graphId?: GraphId) {
    super(graphId === undefined ? 'Graph is unloading' : `Graph is unloading: ${graphId}`);
    this.name = 'GraphUnloadingError';
  }
}

/**
 * Per-graph residency metadata: load/access timestamps, idle TTL, pinning and
 * active references. Time is always supplied by the caller; this class owns no
 * clock and schedules no work.
 *
 * `isExpired` is a pure TTL predicate: it does not consider pinning or active
 * references. The registry applies those retention rules before it consults
 * the predicate, so each skip reason stays observable.
 */
export class GraphResidency {
  private readonly loadedAtValue: number;
  private readonly idleTtlMsValue: number;
  private lastAccessAtValue: number;
  private pinnedValue: boolean;
  private refCountValue = 0;
  private stateValue: GraphLoadState = 'loaded';

  constructor(loadedAt: number, options: ResidencyOptions = {}) {
    const idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    if (!Number.isInteger(idleTtlMs) || idleTtlMs < 0) {
      throw new Error(`idleTtlMs must be a non-negative integer: ${String(options.idleTtlMs)}`);
    }
    this.loadedAtValue = loadedAt;
    this.lastAccessAtValue = loadedAt;
    this.idleTtlMsValue = idleTtlMs;
    this.pinnedValue = options.pinned ?? false;
  }

  get loadedAt(): number {
    return this.loadedAtValue;
  }

  get lastAccessAt(): number {
    return this.lastAccessAtValue;
  }

  get idleTtlMs(): number {
    return this.idleTtlMsValue;
  }

  get pinned(): boolean {
    return this.pinnedValue;
  }

  get refCount(): number {
    return this.refCountValue;
  }

  get state(): GraphLoadState {
    return this.stateValue;
  }

  touch(now: number): void {
    this.assertLoaded();
    this.lastAccessAtValue = now;
  }

  acquire(): void {
    this.assertLoaded();
    this.refCountValue += 1;
  }

  /** Releasing is idempotent; the count never drops below zero. */
  release(): void {
    if (this.refCountValue > 0) {
      this.refCountValue -= 1;
    }
  }

  pin(now: number): void {
    this.assertLoaded();
    this.pinnedValue = true;
    this.lastAccessAtValue = now;
  }

  unpin(now: number): void {
    this.assertLoaded();
    this.pinnedValue = false;
    this.lastAccessAtValue = now;
  }

  /** Registry coordination: stop accepting access while a flush is in flight. */
  beginUnload(): void {
    this.assertLoaded();
    this.stateValue = 'unloading';
  }

  /**
   * Registry coordination: a failed flush keeps the graph loaded. Recording the
   * attempt as an access prevents an immediate hot retry against a broken
   * flush.
   */
  cancelUnload(now: number): void {
    if (this.stateValue !== 'unloading') {
      throw new Error('Graph is not unloading');
    }
    this.stateValue = 'loaded';
    this.lastAccessAtValue = now;
  }

  isExpired(now: number): boolean {
    return (
      this.stateValue === 'loaded' &&
      this.idleTtlMsValue > 0 &&
      now >= this.lastAccessAtValue + this.idleTtlMsValue
    );
  }

  nextEvictionAt(): number | undefined {
    if (this.pinnedValue || this.idleTtlMsValue === 0 || this.stateValue === 'unloading') {
      return undefined;
    }
    return this.lastAccessAtValue + this.idleTtlMsValue;
  }

  /**
   * Immutable view. `now` is accepted for symmetry with the time-aware
   * methods; the eviction deadline is absolute, so it does not depend on it.
   */
  snapshot(now: number): ResidencySnapshot {
    const nextEvictionAt = this.nextEvictionAt();
    return {
      loadedAt: this.loadedAtValue,
      lastAccessAt: this.lastAccessAtValue,
      idleTtlMs: this.idleTtlMsValue,
      pinned: this.pinnedValue,
      refCount: this.refCountValue,
      state: this.stateValue,
      ...(nextEvictionAt === undefined ? {} : { nextEvictionAt }),
    };
  }

  private assertLoaded(): void {
    if (this.stateValue !== 'loaded') {
      throw new GraphUnloadingError();
    }
  }
}
