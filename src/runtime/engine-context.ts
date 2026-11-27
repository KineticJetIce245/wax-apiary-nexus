import type { GuardDecision, GuardRequest, NodeExecutor } from './executor.js';
import type { RuntimeLogFieldsSink } from './log.js';
import type { QueueContext } from './queue.js';
import type { ReceptorOverflow } from './receptor-overflow.js';
import type { StateLock } from './state-lock.js';
import type { CompositionDefinition, NodeId, NodeState, Value } from './types.js';

/** One per-Bee pacing timer; the token guards against a stale callback. */
export interface PacingTimer {
  readonly dueAt: number;
  readonly token: symbol;
}

/**
 * The result of one activation whose native work outlived a field unload. It is
 * handed to the host, which loads the field again and completes the restored
 * active; the Bee is never executed a second time.
 */
export type LateActivationOutcome =
  | {
      readonly ok: true;
      readonly value: Value;
      readonly drop?: readonly string[];
      readonly outcome: string;
      readonly branch?: 'true' | 'false' | 'continue' | 'done';
      readonly startedAt: number;
    }
  | {
      readonly ok: false;
      readonly error: string;
      readonly startedAt: number;
    };

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
  /** One running drain per Bee; a second wake while it runs only appends. */
  readonly drains: Map<NodeId, Promise<void>>;
  /** Wakes that were scheduled but have not started their drain yet. */
  readonly scheduledWakes: Map<NodeId, symbol>;
  /** Per-Bee pacing timers that will wake a drain when due. */
  readonly timers: Map<NodeId, PacingTimer>;
  /** Timer seam: the host supplies its own sleep so tests control pacing. */
  readonly sleep: (ms: number) => Promise<void>;
  readonly executor: NodeExecutor;
  readonly projectDirectory: string | undefined;
  readonly guardTimeoutMs: number;
  readonly onGuard: ((request: GuardRequest) => Promise<GuardDecision>) | undefined;
  readonly onGuardExpired: ((requestId: string) => void) | undefined;
  /** Called when a native activation completes after `detach()`. */
  readonly onLateResult:
    | ((nodeId: NodeId, outcome: LateActivationOutcome) => void)
    | undefined;
  /** Blocked activations already logged, so a retry loop does not spam. */
  readonly reportedBlocks: Set<string>;
  /** The field was released; running activations hand their result to the host. */
  detached: boolean;
}
