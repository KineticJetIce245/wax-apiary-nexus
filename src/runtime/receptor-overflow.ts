import type { RuntimeLogFields } from './log.js';
import type { NodeId, Value } from './types.js';

/** Block policy default when `receptorBlockTimeoutMs` is omitted. */
export const DEFAULT_RECEPTOR_BLOCK_TIMEOUT_MS = 30_000;

export type ReceptorOverflowPolicy = 'reject' | 'block';

export interface ReceptorOverflowOptions {
  /** What to do when a bee's receptor already holds `queueMax` entries. */
  readonly receptorOverflowPolicy?: ReceptorOverflowPolicy;
  readonly receptorBlockTimeoutMs?: number;
}

/** Validates the two overflow options once, for both the host and the runtime. */
export function readReceptorOverflowOptions(options: ReceptorOverflowOptions): {
  readonly policy: ReceptorOverflowPolicy;
  readonly blockTimeoutMs: number;
} {
  const policy = options.receptorOverflowPolicy ?? 'reject';
  if (policy !== 'reject' && policy !== 'block') {
    throw new TypeError("receptorOverflowPolicy must be 'reject' or 'block'");
  }
  const blockTimeoutMs =
    options.receptorBlockTimeoutMs ?? DEFAULT_RECEPTOR_BLOCK_TIMEOUT_MS;
  if (!Number.isInteger(blockTimeoutMs) || blockTimeoutMs <= 0) {
    throw new TypeError('receptorBlockTimeoutMs must be a positive integer');
  }
  return { policy, blockTimeoutMs };
}

/**
 * A blocked admission waited `receptorBlockTimeoutMs` without receptor capacity.
 * The caller may retry later; the runtime never retries on its own.
 */
export class ReceptorBlockTimeoutError extends Error {
  readonly code = 'bee-receptor-block-timeout';
  readonly policy = 'block';

  constructor(
    readonly liveId: string,
    readonly beeId: NodeId,
    readonly pending: number,
    readonly limit: number,
    readonly waitedMs: number,
  ) {
    super(
      `bee '${beeId}' receptor stayed full for ${String(waitedMs)}ms ` +
        `(pending=${String(pending)}, limit=${String(limit)})`,
    );
    this.name = 'ReceptorBlockTimeoutError';
  }
}

/**
 * A new Pheromone was refused because its target bee already holds `limit`
 * waiting entries. Existing input is never dropped, so a caller can retry once
 * the receptor drains.
 */
export class ReceptorFullError extends Error {
  readonly policy = 'reject';
  readonly code = 'bee-receptor-full';
  readonly liveId: string;
  readonly beeId: NodeId;
  readonly pending: number;
  readonly limit: number;

  constructor(
    readonly nodeId: NodeId,
    readonly queueMax: number,
    readonly queueDepth: number,
    options: { readonly liveId?: string } = {},
  ) {
    super(
      `receptor for node '${nodeId}' is full (queueMax=${String(queueMax)}, ` +
        `queueDepth=${String(queueDepth)}); refusing new Pheromone`,
    );
    this.name = 'ReceptorFullError';
    this.liveId = options.liveId ?? '';
    this.beeId = nodeId;
    this.pending = queueDepth;
    this.limit = queueMax;
  }
}

interface Waiter {
  readonly nodeId: NodeId;
  readonly value: Value;
  readonly startedAt: number;
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
  settled: boolean;
}

/** What a block-policy admission needs from the field; all calls are synchronous. */
export interface ReceptorHost {
  readonly liveId: string;
  readonly limit: number;
  readonly now: () => number;
  /** True while the field state transaction is held by the caller. */
  readonly locked: () => boolean;
  transaction<T>(action: () => T): T;
  /** Waiting entries plus output reservations; active/pending never count. */
  depth(nodeId: NodeId): number;
  /** Append only when capacity exists; it must already hold the transaction. */
  tryAppend(nodeId: NodeId, value: Value): boolean;
  log(entry: RuntimeLogFields): void;
}

/**
 * FIFO capacity waiters for one bee's receptor.
 *
 * A waiter is queued behind every older waiter, so a later admission can never
 * jump ahead. Capacity is handed out oldest-first by `dispatchLocked`, which is
 * only called inside the runtime's short state transaction: a wait never holds
 * the lock and never blocks a drain.
 */
export class ReceptorOverflow {
  private readonly queues = new Map<NodeId, Waiter[]>();

  constructor(
    private readonly host: ReceptorHost,
    private readonly timeoutMs: number,
  ) {}

  hasWaiters(nodeId: NodeId): boolean {
    return (this.queues.get(nodeId)?.length ?? 0) > 0;
  }

  /** Queue one admission and resolve once capacity is available. */
  admit(nodeId: NodeId, value: Value): Promise<void> {
    const queue = this.queueOf(nodeId);
    const waiter = createWaiter(nodeId, value, this.host.now());
    queue.push(waiter);
    try {
      this.host.transaction(() => this.dispatchLocked(nodeId));
    } catch (error) {
      this.remove(nodeId, waiter);
      waiter.settled = true;
      waiter.reject(error);
      return waiter.promise;
    }
    if (!waiter.settled) {
      this.startTimer(waiter);
      this.reportBlocked(waiter);
    }
    return waiter.promise;
  }

  /** Re-check one bee after a state change freed capacity. */
  notify(nodeId: NodeId): void {
    if (!this.hasWaiters(nodeId)) {
      return;
    }
    if (this.host.locked()) {
      this.dispatchLocked(nodeId);
      return;
    }
    this.host.transaction(() => this.dispatchLocked(nodeId));
  }

  /** Re-check every bee after a bulk capacity change. */
  notifyAll(): void {
    for (const nodeId of [...this.queues.keys()]) {
      this.notify(nodeId);
    }
  }

  private dispatchLocked(nodeId: NodeId): void {
    const queue = this.queues.get(nodeId);
    while (queue !== undefined && queue.length > 0) {
      const head = queue[0];
      if (head === undefined || !this.host.tryAppend(nodeId, head.value)) {
        break;
      }
      queue.shift();
      this.settle(head);
    }
    if (queue?.length === 0) {
      this.queues.delete(nodeId);
    }
  }

  private startTimer(waiter: Waiter): void {
    const timer = setTimeout(() => this.expire(waiter), this.timeoutMs);
    timer.unref();
    waiter.timer = timer;
  }

  /** A timeout removes only this waiter; older waiters already hold their turn. */
  private expire(waiter: Waiter): void {
    if (waiter.settled) {
      return;
    }
    const queue = this.queues.get(waiter.nodeId);
    const index = queue?.indexOf(waiter) ?? -1;
    if (index < 0) {
      return;
    }
    queue?.splice(index, 1);
    waiter.settled = true;
    if (queue?.length === 0) {
      this.queues.delete(waiter.nodeId);
    }
    const waitedMs = this.host.now() - waiter.startedAt;
    const pending = this.host.depth(waiter.nodeId);
    const limit = this.host.limit;
    this.host.log({
      event: 'bee-receptor-block-timeout',
      nodeId: waiter.nodeId,
      queueDepth: pending,
      limit,
      policy: 'block',
      waitedMs,
      outcome: 'receptor-block-timeout',
    });
    waiter.reject(
      new ReceptorBlockTimeoutError(
        this.host.liveId,
        waiter.nodeId,
        pending,
        limit,
        waitedMs,
      ),
    );
    this.notify(waiter.nodeId);
  }

  private settle(waiter: Waiter): void {
    waiter.settled = true;
    if (waiter.timer !== undefined) {
      clearTimeout(waiter.timer);
    }
    waiter.resolve();
  }

  private reportBlocked(waiter: Waiter): void {
    this.host.log({
      event: 'bee-receptor-blocked',
      nodeId: waiter.nodeId,
      queueDepth: this.host.depth(waiter.nodeId),
      limit: this.host.limit,
      policy: 'block',
      outcome: 'receptor-blocked',
    });
  }

  private remove(nodeId: NodeId, waiter: Waiter): void {
    const queue = this.queues.get(nodeId);
    const index = queue?.indexOf(waiter) ?? -1;
    if (index < 0) {
      return;
    }
    queue?.splice(index, 1);
    if (queue?.length === 0) {
      this.queues.delete(nodeId);
    }
  }

  private queueOf(nodeId: NodeId): Waiter[] {
    const existing = this.queues.get(nodeId);
    if (existing !== undefined) {
      return existing;
    }
    const created: Waiter[] = [];
    this.queues.set(nodeId, created);
    return created;
  }
}

function createWaiter(nodeId: NodeId, value: Value, startedAt: number): Waiter {
  let resolveWaiter: () => void = () => undefined;
  let rejectWaiter: (error: unknown) => void = () => undefined;
  const promise = new Promise<void>((resolve, reject) => {
    resolveWaiter = resolve;
    rejectWaiter = reject;
  });
  return {
    nodeId,
    value,
    startedAt,
    promise,
    resolve: resolveWaiter,
    reject: rejectWaiter,
    settled: false,
  };
}
