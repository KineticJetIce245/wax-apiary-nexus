import type { GuardDecision, GuardRequest } from '../runtime/index.js';

export const DEFAULT_GUARD_TIMEOUT_MS = 120_000;

export interface PendingGuardSummary {
  readonly requestId: string;
  readonly executionId: string;
  readonly summary: string;
  readonly options: readonly string[];
  readonly createdAt: string;
  /** Attribution; omitted when the originating layer did not know it. */
  readonly liveId?: string;
  readonly beeId?: string;
  readonly sessionId?: string;
}

export class GuardNotFoundError extends Error {
  constructor(readonly requestId: string) {
    super(`Unknown guard request: ${requestId}`);
    this.name = 'GuardNotFoundError';
  }
}

export class GuardAlreadySettledError extends Error {
  constructor(readonly requestId: string) {
    super(`Guard request is no longer pending: ${requestId}`);
    this.name = 'GuardAlreadySettledError';
  }
}

/** The guard reached its deadline; a late decision must not be applied. */
export class GuardExpiredError extends Error {
  constructor(readonly requestId: string) {
    super(`Guard request expired: ${requestId}`);
    this.name = 'GuardExpiredError';
  }
}

export interface GuardBrokerOptions {
  /**
   * Fallback deadline, default 120s and matching the runtime's guard timeout.
   * In the control server the runtime normally expires first and calls
   * `expire`; this timer only protects against a missing notification.
   */
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

type SettledReason = 'decided' | 'cancelled' | 'expired';

interface PendingGuard {
  readonly request: GuardRequest;
  readonly createdAt: string;
  readonly resolve: (decision: GuardDecision) => void;
  readonly timer: NodeJS.Timeout;
}

const SETTLED_MEMORY = 256;

/**
 * Holds native approval requests until a control caller decides them.
 *
 * Every request is resolved by `decide`, expired by the runtime's deadline
 * notification (`expire`) or this broker's fallback timer, or cancelled by
 * `cancelAll` during shutdown. The default is never to allow: an unresolved
 * request becomes `cancelled`, and `reject_once`/`cancelled` remain explicit
 * caller choices. An expired request is remembered as expired so a late
 * decision answers 409 `guard-expired` instead of looking unknown.
 */
export class GuardBroker {
  private readonly timeoutMs: number;
  private readonly now: () => string;
  private readonly pending = new Map<string, PendingGuard>();
  private readonly settled = new Map<string, SettledReason>();

  constructor(options: GuardBrokerOptions = {}) {
    this.timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_GUARD_TIMEOUT_MS, 'timeoutMs');
    const clock = options.now ?? (() => Date.now());
    this.now = () => new Date(clock()).toISOString();
  }

  request(request: GuardRequest): Promise<GuardDecision> {
    if (this.pending.has(request.requestId)) {
      throw new Error(`Guard request is already pending: ${request.requestId}`);
    }
    this.settled.delete(request.requestId);
    return new Promise<GuardDecision>((resolve) => {
      const timer = setTimeout(() => {
        this.expire(request.requestId);
      }, this.timeoutMs);
      timer.unref();
      this.pending.set(request.requestId, {
        request,
        createdAt: this.now(),
        resolve,
        timer,
      });
    });
  }

  /** Pending metadata only; no prompt, output or tool payload is included. */
  list(): readonly PendingGuardSummary[] {
    return [...this.pending.values()].map((pending) => ({
      requestId: pending.request.requestId,
      executionId: pending.request.executionId,
      summary: pending.request.summary,
      options: [...pending.request.options],
      createdAt: pending.createdAt,
      ...attributionOf(pending.request),
    }));
  }

  decide(requestId: string, decision: GuardDecision): void {
    if (!this.pending.has(requestId)) {
      if (this.settled.get(requestId) === 'expired') {
        throw new GuardExpiredError(requestId);
      }
      if (this.settled.has(requestId)) {
        throw new GuardAlreadySettledError(requestId);
      }
      throw new GuardNotFoundError(requestId);
    }
    this.settle(requestId, decision, 'decided');
  }

  /**
   * Deadline path, called by the runtime's expiry hook (and by the fallback
   * timer). Idempotent: an already decided, cancelled, expired, or unknown
   * request is left unchanged, so a late notification can never allow or
   * reopen a guard.
   */
  expire(requestId: string): void {
    if (!this.pending.has(requestId)) {
      return;
    }
    this.settle(requestId, 'cancelled', 'expired');
  }

  /** Shutdown: every pending request is cancelled, never allowed. */
  cancelAll(): void {
    for (const requestId of [...this.pending.keys()]) {
      this.settle(requestId, 'cancelled', 'cancelled');
    }
  }

  private settle(
    requestId: string,
    decision: GuardDecision,
    reason: SettledReason,
  ): void {
    const pending = this.pending.get(requestId);
    if (pending === undefined) {
      return;
    }
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    this.rememberSettled(requestId, reason);
    pending.resolve(decision);
  }

  private rememberSettled(requestId: string, reason: SettledReason): void {
    this.settled.set(requestId, reason);
    while (this.settled.size > SETTLED_MEMORY) {
      const oldest = this.settled.keys().next().value;
      if (oldest === undefined) {
        return;
      }
      this.settled.delete(oldest);
    }
  }
}

/** Copy only the attribution the request actually carries; never invent ids. */
function attributionOf(
  request: GuardRequest,
): Pick<PendingGuardSummary, 'liveId' | 'beeId' | 'sessionId'> {
  return {
    ...(request.liveId === undefined ? {} : { liveId: request.liveId }),
    ...(request.beeId === undefined ? {} : { beeId: request.beeId }),
    ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
  };
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}
