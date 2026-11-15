import type { GuardDecision, GuardRequest } from '../runtime/index.js';

export const DEFAULT_GUARD_TIMEOUT_MS = 3_600_000;

export interface PendingGuardSummary {
  readonly requestId: string;
  readonly executionId: string;
  readonly summary: string;
  readonly options: readonly string[];
  readonly createdAt: string;
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

export interface GuardBrokerOptions {
  /** Default 1h, matching the runtime's guard timeout. */
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

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
 * Every request is either resolved by `decide`, cancelled by timeout, or
 * cancelled by `cancelAll` during shutdown. The default is never to allow:
 * an unresolved request becomes `cancelled`, and `reject_once`/`cancelled`
 * remain explicit caller choices.
 */
export class GuardBroker {
  private readonly timeoutMs: number;
  private readonly now: () => string;
  private readonly pending = new Map<string, PendingGuard>();
  private readonly settled = new Set<string>();

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
        this.settle(request.requestId, 'cancelled');
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
    }));
  }

  decide(requestId: string, decision: GuardDecision): void {
    if (!this.pending.has(requestId)) {
      if (this.settled.has(requestId)) {
        throw new GuardAlreadySettledError(requestId);
      }
      throw new GuardNotFoundError(requestId);
    }
    this.settle(requestId, decision);
  }

  /** Shutdown: every pending request is cancelled, never allowed. */
  cancelAll(): void {
    for (const requestId of [...this.pending.keys()]) {
      this.settle(requestId, 'cancelled');
    }
  }

  private settle(requestId: string, decision: GuardDecision): void {
    const pending = this.pending.get(requestId);
    if (pending === undefined) {
      return;
    }
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    this.rememberSettled(requestId);
    pending.resolve(decision);
  }

  private rememberSettled(requestId: string): void {
    this.settled.add(requestId);
    while (this.settled.size > SETTLED_MEMORY) {
      const oldest = this.settled.values().next().value;
      if (oldest === undefined) {
        return;
      }
      this.settled.delete(oldest);
    }
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}
