import { randomUUID } from 'node:crypto';

/**
 * Per-session execution queue.
 *
 * One native conversation must not run two executions at once. Loaded
 * LiveHives may share an explicit session, so `GraphHost.trigger` asks this
 * queue for a slot: a free session starts the job immediately, a busy one is
 * enqueued FIFO and the caller gets a `QueuedRun` handle back. The queue is
 * deliberately in memory only: a daemon restart forgets every item and never
 * replays a side-effecting job.
 *
 * The queue owns delivery only; it never stores a prompt, output or token.
 */

export type SessionQueueStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'timeout'
  | 'dropped';

export interface SessionQueueMeta {
  readonly liveId: string;
  readonly beeId: string;
}

/** The immediate answer for a wake whose session was already executing. */
export interface QueuedRun {
  readonly status: 'queued';
  readonly queueId: string;
  readonly position: number;
  readonly liveId: string;
  readonly beeId: string;
  readonly sessionId: string;
}

/** Read-only view returned by the `GET /queues/:queueId` route. */
export interface QueueItemView {
  readonly queueId: string;
  readonly liveId: string;
  readonly beeId: string;
  readonly sessionId: string;
  readonly status: SessionQueueStatus;
  readonly position?: number;
  readonly runId?: string;
  readonly error?: string;
}

/** Timer seam so a unit test can fire waits without real time. */
export interface SessionQueueTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface SessionExecutionQueueOptions {
  /** Maximum waiting (not running) items per session; default 16. */
  readonly maxPending?: number;
  /** How long an item may wait before it is marked `timeout`; default 5 min. */
  readonly waitTimeoutMs?: number;
  /** Settled items retained for lookup; default 256. */
  readonly retention?: number;
  readonly timers?: SessionQueueTimers;
}

export const DEFAULT_SESSION_QUEUE_DEPTH = 16;
export const DEFAULT_SESSION_QUEUE_WAIT_MS = 5 * 60_000;
export const DEFAULT_SESSION_QUEUE_RETENTION = 256;

/** The session already has the maximum number of waiting executions. */
export class SessionQueueFullError extends Error {
  constructor(
    readonly sessionId: string,
    readonly capacity: number,
  ) {
    super(`Session queue is full (capacity ${String(capacity)})`);
    this.name = 'SessionQueueFullError';
  }
}

/** The host is shutting down; no new execution may be accepted. */
export class SessionQueueDisposedError extends Error {
  constructor() {
    super('Session queue is disposed');
    this.name = 'SessionQueueDisposedError';
  }
}

/** What a job resolves to; the run id is all the queue needs to report. */
interface QueueJobResult {
  readonly runId: string;
}

interface PendingItem extends SessionQueueMeta {
  readonly queueId: string;
  readonly sessionId: string;
  readonly execute: () => Promise<QueueJobResult>;
  status: SessionQueueStatus;
  timer: unknown;
  runId?: string;
  error?: string;
}

interface SessionState {
  running: boolean;
  readonly waiting: PendingItem[];
}

/** Narrow a `trigger` result to the queued variant. */
export function isQueuedRun(value: unknown): value is QueuedRun {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record['status'] === 'queued' &&
    typeof record['queueId'] === 'string' &&
    typeof record['position'] === 'number'
  );
}

const SYSTEM_TIMERS: SessionQueueTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => {
    clearTimeout(handle as NodeJS.Timeout);
  },
};

/**
 * FIFO executor slots keyed by session id.
 *
 * `start` is atomic in the single-threaded sense: it marks the session
 * running before any await, so two callers can never both take the slot.
 * Completion always advances the same session's queue, even when the job
 * rejects, so a failed run cannot strand the work behind it.
 */
export class SessionExecutionQueue {
  private readonly maxPending: number;
  private readonly waitTimeoutMs: number;
  private readonly retention: number;
  private readonly timers: SessionQueueTimers;
  /** Insertion order doubles as the settled-item eviction order. */
  private readonly items = new Map<string, PendingItem>();
  private readonly sessions = new Map<string, SessionState>();
  private disposed = false;

  constructor(options: SessionExecutionQueueOptions = {}) {
    this.maxPending = positiveInteger(
      options.maxPending ?? DEFAULT_SESSION_QUEUE_DEPTH,
      'maxPending',
    );
    this.waitTimeoutMs = positiveInteger(
      options.waitTimeoutMs ?? DEFAULT_SESSION_QUEUE_WAIT_MS,
      'waitTimeoutMs',
    );
    this.retention = positiveInteger(
      options.retention ?? DEFAULT_SESSION_QUEUE_RETENTION,
      'retention',
    );
    this.timers = options.timers ?? SYSTEM_TIMERS;
  }

  /**
   * Take the session slot now or enqueue. A free session awaits the job; a
   * busy one resolves with a `QueuedRun` so the caller can answer
   * `status: 'queued'` immediately. The depth limit rejects with
   * `SessionQueueFullError` instead of growing without bound.
   */
  start<T extends QueueJobResult>(
    sessionId: string,
    meta: SessionQueueMeta,
    job: () => Promise<T>,
  ): Promise<T | QueuedRun> {
    if (this.disposed) {
      return Promise.reject(new SessionQueueDisposedError());
    }
    const current = this.sessions.get(sessionId);
    if (current !== undefined && current.running) {
      if (current.waiting.length >= this.maxPending) {
        return Promise.reject(new SessionQueueFullError(sessionId, this.maxPending));
      }
      return Promise.resolve(this.enqueue(current, sessionId, meta, job));
    }

    const state = current ?? { running: true, waiting: [] };
    state.running = true;
    this.sessions.set(sessionId, state);
    // The async wrapper turns a synchronous job throw into a rejection, so a
    // caller always receives a promise.
    return (async () => job())().finally(() => this.advance(sessionId));
  }

  /** Current view of one item, including its live position while waiting. */
  get(queueId: string): QueueItemView | undefined {
    const item = this.items.get(queueId);
    if (item === undefined) {
      return undefined;
    }
    const position = this.positionOf(item);
    return {
      queueId: item.queueId,
      liveId: item.liveId,
      beeId: item.beeId,
      sessionId: item.sessionId,
      status: item.status,
      ...(position === undefined ? {} : { position }),
      ...(item.runId === undefined ? {} : { runId: item.runId }),
      ...(item.error === undefined ? {} : { error: item.error }),
    };
  }

  /**
   * Drop every still-waiting item that belongs to one live hive. A running
   * item is left alone: an explicit unload already refuses to run concurrently
   * with it, and rewriting a live execution would lose the caller's handle.
   */
  dropByLive(liveId: string): number {
    let dropped = 0;
    for (const item of this.items.values()) {
      if (item.liveId !== liveId || item.status !== 'queued') {
        continue;
      }
      this.removeWaiting(item);
      this.clearTimer(item);
      item.status = 'dropped';
      dropped += 1;
    }
    this.prune();
    return dropped;
  }

  /** Stop all timers and never start a waiting job (no replay after restart). */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const item of this.items.values()) {
      if (item.status === 'queued') {
        this.clearTimer(item);
        item.status = 'dropped';
        item.error = 'queue-disposed';
      }
    }
    this.sessions.clear();
  }

  private enqueue(
    state: SessionState,
    sessionId: string,
    meta: SessionQueueMeta,
    execute: () => Promise<QueueJobResult>,
  ): QueuedRun {
    const item: PendingItem = {
      queueId: randomUUID(),
      sessionId,
      liveId: meta.liveId,
      beeId: meta.beeId,
      execute,
      status: 'queued',
      timer: undefined,
    };
    this.items.set(item.queueId, item);
    state.waiting.push(item);
    item.timer = this.timers.setTimeout(() => this.expire(item), this.waitTimeoutMs);
    return {
      status: 'queued',
      queueId: item.queueId,
      position: state.waiting.length,
      liveId: item.liveId,
      beeId: item.beeId,
      sessionId: item.sessionId,
    };
  }

  /** One session's next job. The session stays marked running across the hand-off. */
  private advance(sessionId: string): void {
    if (this.disposed) {
      return;
    }
    const state = this.sessions.get(sessionId);
    if (state === undefined) {
      return;
    }
    const next = state.waiting.shift();
    if (next === undefined) {
      this.sessions.delete(sessionId);
      return;
    }
    this.runPending(next);
  }

  private runPending(item: PendingItem): void {
    item.status = 'running';
    this.clearTimer(item);
    const finished = (async () => {
      try {
        const result = await item.execute();
        item.runId = result.runId;
        item.status = 'completed';
      } catch {
        // The queue is a delivery channel: the sanitized status is enough, and
        // an error message can carry native detail that must not leak.
        item.status = 'failed';
        item.error = 'run failed';
      } finally {
        this.advance(item.sessionId);
        this.prune();
      }
    })();
    // The original caller already received a QueuedRun; nobody awaits this.
    void finished.catch(() => undefined);
  }

  private expire(item: PendingItem): void {
    if (item.status !== 'queued') {
      return;
    }
    this.removeWaiting(item);
    item.status = 'timeout';
    item.error = 'queue-timeout';
    this.prune();
  }

  private removeWaiting(item: PendingItem): void {
    const state = this.sessions.get(item.sessionId);
    if (state === undefined) {
      return;
    }
    const index = state.waiting.indexOf(item);
    if (index !== -1) {
      state.waiting.splice(index, 1);
    }
  }

  private positionOf(item: PendingItem): number | undefined {
    if (item.status !== 'queued') {
      return undefined;
    }
    const state = this.sessions.get(item.sessionId);
    if (state === undefined) {
      return undefined;
    }
    const index = state.waiting.indexOf(item);
    return index === -1 ? undefined : index + 1;
  }

  private clearTimer(item: PendingItem): void {
    if (item.timer === undefined) {
      return;
    }
    this.timers.clearTimeout(item.timer);
    item.timer = undefined;
  }

  /** Evict the oldest settled items first; waiting/running items are never kept out. */
  private prune(): void {
    if (this.items.size <= this.retention) {
      return;
    }
    for (const [queueId, item] of this.items) {
      if (this.items.size <= this.retention) {
        break;
      }
      if (item.status === 'queued' || item.status === 'running') {
        continue;
      }
      this.items.delete(queueId);
    }
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}
