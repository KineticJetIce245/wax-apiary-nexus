import type { RuntimeLogEntry } from './log.js';
import type { NodeId, Pheromone, RuntimeAdmission } from './types.js';

/** Block policy default when `mailboxBlockTimeoutMs` is omitted. */
export const DEFAULT_MAILBOX_BLOCK_TIMEOUT_MS = 30_000;

export type MailboxOverflowPolicy = 'reject' | 'block';

export interface MailboxOverflowOptions {
  readonly mailboxOverflowPolicy?: MailboxOverflowPolicy;
  readonly mailboxBlockTimeoutMs?: number;
}

/** Validates the two overflow options once, for both the host and the runtime. */
export function readMailboxOverflowOptions(options: MailboxOverflowOptions): {
  readonly policy: MailboxOverflowPolicy;
  readonly blockTimeoutMs: number;
} {
  const policy = options.mailboxOverflowPolicy ?? 'reject';
  if (policy !== 'reject' && policy !== 'block') {
    throw new TypeError("mailboxOverflowPolicy must be 'reject' or 'block'");
  }
  const blockTimeoutMs =
    options.mailboxBlockTimeoutMs ?? DEFAULT_MAILBOX_BLOCK_TIMEOUT_MS;
  if (!Number.isInteger(blockTimeoutMs) || blockTimeoutMs <= 0) {
    throw new TypeError('mailboxBlockTimeoutMs must be a positive integer');
  }
  return { policy, blockTimeoutMs };
}

/**
 * A blocked admission waited `mailboxBlockTimeoutMs` without mailbox capacity.
 * The caller may retry later; the runtime never retries on its own.
 */
export class MailboxBlockTimeoutError extends Error {
  readonly code = 'bee-mailbox-block-timeout';
  readonly policy = 'block';

  constructor(
    readonly liveId: string,
    readonly beeId: NodeId,
    readonly pending: number,
    readonly limit: number,
    readonly waitedMs: number,
  ) {
    super(
      `bee '${beeId}' mailbox stayed full for ${String(waitedMs)}ms ` +
        `(pending=${String(pending)}, limit=${String(limit)})`,
    );
    this.name = 'MailboxBlockTimeoutError';
  }
}

/**
 * A new Pheromone was refused because its target bee already holds `limit`
 * waiting entries (mailbox + reservations). Existing input is never dropped,
 * so a caller can retry once the mailbox drains.
 */
export class QueueFullError extends Error {
  readonly policy = 'reject';
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
      `queue for node '${nodeId}' is full (queueMax=${String(queueMax)}, ` +
        `queueDepth=${String(queueDepth)}); refusing new Pheromone`,
    );
    this.name = 'QueueFullError';
    this.liveId = options.liveId ?? '';
    this.beeId = nodeId;
    this.pending = queueDepth;
    this.limit = queueMax;
  }
}

interface Waiter {
  readonly nodeId: NodeId;
  readonly pheromone: Pheromone;
  readonly traceId: string;
  readonly startedAt: number;
  readonly promise: Promise<RuntimeAdmission>;
  readonly resolve: (admission: RuntimeAdmission) => void;
  readonly reject: (error: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
  settled: boolean;
}

/** What a block-policy admission needs from the field; all calls are synchronous. */
export interface MailboxHost {
  readonly liveId: string;
  readonly limit: number;
  readonly now: () => number;
  /** True while the field state transaction is held by the caller. */
  readonly locked: () => boolean;
  transaction<T>(action: () => T): T;
  /** Waiting entries plus output reservations; active/pending never count. */
  depth(nodeId: NodeId): number;
  /** Append only when capacity exists; it must already hold the transaction. */
  tryAppend(nodeId: NodeId, pheromone: Pheromone): boolean;
  log(entry: Omit<RuntimeLogEntry, 'at' | 'compositionId' | 'graphRevision'>): void;
}

/**
 * FIFO capacity waiters for one bee's mailbox.
 *
 * A waiter is queued behind every older waiter, so a later admission can never
 * jump ahead. Capacity is handed out oldest-first by `dispatchLocked`, which is
 * only called inside the runtime's short state transaction: a wait never holds
 * the lock and never blocks a drain.
 */
export class MailboxOverflow {
  private readonly queues = new Map<NodeId, Waiter[]>();

  constructor(
    private readonly host: MailboxHost,
    private readonly timeoutMs: number,
  ) {}

  hasWaiters(nodeId: NodeId): boolean {
    return (this.queues.get(nodeId)?.length ?? 0) > 0;
  }

  /** Queue one admission and resolve once capacity is available. */
  admit(nodeId: NodeId, pheromone: Pheromone, traceId: string): Promise<RuntimeAdmission> {
    const queue = this.queueOf(nodeId);
    const waiter = createWaiter(nodeId, pheromone, traceId, this.host.now());
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

  /** Re-check every bee after a bulk capacity change (expiry or fork failure). */
  notifyAll(): void {
    for (const nodeId of [...this.queues.keys()]) {
      this.notify(nodeId);
    }
  }

  private dispatchLocked(nodeId: NodeId): void {
    const queue = this.queues.get(nodeId);
    while (queue !== undefined && queue.length > 0) {
      const head = queue[0];
      if (head === undefined || !this.host.tryAppend(nodeId, head.pheromone)) {
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
      event: 'bee-mailbox-block-timeout',
      nodeId: waiter.nodeId,
      pheromoneId: waiter.pheromone.id,
      traceId: waiter.traceId,
      queueDepth: pending,
      limit,
      policy: 'block',
      waitedMs,
      outcome: 'mailbox-block-timeout',
    });
    waiter.reject(
      new MailboxBlockTimeoutError(
        this.host.liveId,
        waiter.nodeId,
        pending,
        limit,
        waitedMs,
      ),
    );
    // This waiter occupied the head of the line; let the next one proceed if
    // the capacity that was unavailable to it is still there for a smaller set.
    this.notify(waiter.nodeId);
  }

  private settle(waiter: Waiter): void {
    waiter.settled = true;
    if (waiter.timer !== undefined) {
      clearTimeout(waiter.timer);
    }
    waiter.resolve({ pheromoneId: waiter.pheromone.id, traceId: waiter.traceId });
  }

  private reportBlocked(waiter: Waiter): void {
    this.host.log({
      event: 'bee-mailbox-blocked',
      nodeId: waiter.nodeId,
      pheromoneId: waiter.pheromone.id,
      traceId: waiter.traceId,
      queueDepth: this.host.depth(waiter.nodeId),
      limit: this.host.limit,
      policy: 'block',
      outcome: 'mailbox-blocked',
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

function createWaiter(
  nodeId: NodeId,
  pheromone: Pheromone,
  traceId: string,
  startedAt: number,
): Waiter {
  let resolveWaiter: (admission: RuntimeAdmission) => void = () => undefined;
  let rejectWaiter: (error: unknown) => void = () => undefined;
  const promise = new Promise<RuntimeAdmission>((resolve, reject) => {
    resolveWaiter = resolve;
    rejectWaiter = reject;
  });
  return {
    nodeId,
    pheromone,
    traceId,
    startedAt,
    promise,
    resolve: resolveWaiter,
    reject: rejectWaiter,
    settled: false,
  };
}
