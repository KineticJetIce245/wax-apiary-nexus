import type { GuardDecision, GuardRequest, NodeExecutor } from './executor.js';
import type { RuntimeLogFieldsSink } from './log.js';
import type { QueueContext } from './queue.js';
import type { ReceptorOverflow } from './receptor-overflow.js';
import type { StateLock } from './state-lock.js';
import type { CompositionDefinition, NodeId, NodeState } from './types.js';

/** A Guard decision waiter keyed by hover token. */
export interface GuardWaiter {
  readonly requestId: string;
  readonly resolve: (decision: GuardDecision) => void;
}

/**
 * Shared mutable engine state for the field operations. The public
 * `PheromoneRuntime` is a thin facade over it; each operation lives with its
 * own module and runtime.ts stays a facade.
 */
export interface EngineContext {
  readonly definition: CompositionDefinition;
  readonly states: Map<NodeId, NodeState>;
  readonly now: () => number;
  readonly iso: () => string;
  readonly log: RuntimeLogFieldsSink;
  readonly queue: QueueContext;
  readonly receptorOverflow: ReceptorOverflow | undefined;
  readonly stateLock: StateLock;
  readonly drains: Map<NodeId, Promise<void>>;
  readonly executor: NodeExecutor;
  readonly projectDirectory: string | undefined;
  readonly guardTimeoutMs: number;
  readonly guardWaiters: Map<string, GuardWaiter>;
  readonly onGuard: ((request: GuardRequest) => Promise<GuardDecision>) | undefined;
  readonly onGuardExpired: ((requestId: string) => void) | undefined;
  /** Blocked activations already logged, so a retry loop does not spam. */
  readonly reportedBlocks: Set<string>;
  /** The first activation failure; the pump stops starting unrelated bees. */
  failure: unknown;
  /** True while a target queue blocked the pump; drives a short retry wake. */
  blockedByQueue: boolean;
  resting: boolean;
}
