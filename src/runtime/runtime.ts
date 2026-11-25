import { randomUUID } from 'node:crypto';

import {
  serializeValue,
  type ExecutionContext,
  type GuardDecision,
  type GuardRequest,
  type NodeExecutor,
} from './executor.js';
import {
  clonePheromone,
  createNodeState,
  dropForkFromMailbox,
  isFieldResting,
  isJoinClosed,
  mailboxOf,
  restMailboxIfIdle,
  setMailbox,
  snapshotField,
} from './field.js';
import { assertUserValue, assertValue } from './runtime-input.js';
import { expireOverdueQueues } from './runtime-expiry.js';
import { logActivated, logCompleted, logFailed } from './runtime-log.js';
import type { RuntimeLogEntry, RuntimeLogSink } from './log.js';
import {
  combineMergeValues,
  copyLineage,
  currentLineage,
  currentTag,
  evaluateCondition,
  normalizePheromone,
  sameLineage,
  workerLogFields,
} from './runtime-values.js';
import { StateLock } from './state-lock.js';
import {
  runWorker,
  workerExitError,
  WorkerExecutionError,
  type WorkerResult,
} from './worker.js';
import type {
  BranchTag,
  CompositionDefinition,
  ConditionConfig,
  EdgeDefinition,
  EdgeWhen,
  ForkNode,
  HoverSpec,
  JoinState,
  JsonValue,
  MergeCombine,
  MergeNode,
  NodeDefinition,
  NodeId,
  NodeState,
  PersistedField,
  PersistedJoinState,
  PersistedNodeState,
  Pheromone,
  PheromoneFieldSnapshot,
  RecoveryReport,
  UserNode,
  Value,
} from './types.js';

export interface RuntimeOptions {
  executeForager: NodeExecutor;
  /**
   * The registered project directory. Worker cwd values resolve against it;
   * without one, a worker activation fails instead of running somewhere else.
   */
  projectDirectory?: string;
  /** Injectable clock for tests; defaults to Date.now. */
  now?: () => number;
  onLog?: RuntimeLogSink;
  /** How long a Guard waits before it is cancelled; contract default is 1h. */
  guardTimeoutMs?: number;
  /** Asks a human for a Guard decision. Without one, every Guard is rejected. */
  onGuard?: (request: GuardRequest) => Promise<GuardDecision>;
  /** Called when the runtime's own guard deadline expires; idempotent. */
  onGuardExpired?: (requestId: string) => void;
}

const DEFAULT_GUARD_TIMEOUT_MS = 3_600_000;

/**
 * How long a closed join is remembered so a late branch can still be dropped.
 * A marker older than this is forgotten when the merge next runs. Stage 5B
 * reuses the bound for both completed and timed-out tombstones.
 */
export const COMPLETED_JOIN_TTL_MS = 3_600_000;

/** Hard cap on closed join markers per merge node; oldest are evicted. */
export const MAX_COMPLETED_JOINS_PER_MERGE = 64;

/**
 * How long the CLI waits before pumping again when queue backpressure is the
 * only thing preventing progress. A blocked activation is retried, never
 * failed, so a short bounded wait is the difference between backpressure and a
 * 0ms spin.
 */
export const QUEUE_RETRY_MS = 100;

/**
 * Queue slots held for one activation's future output. Every target is
 * reserved before the source Pheromone is consumed, so a full queue can never
 * reject a result after its task already ran. The map is decremented as each
 * output is actually pushed; whatever is left is released.
 */
interface OutputReservation {
  readonly slots: Map<NodeId, number>;
}

type ReserveOutcome =
  | { readonly ok: true; readonly reservation: OutputReservation }
  | { readonly ok: false; readonly target: NodeId; readonly queueDepth: number };

/** One input already removed from its bee's mailbox and reserved for output. */
interface Activation {
  readonly node: NodeDefinition;
  readonly pheromone: Pheromone;
  readonly reservation: OutputReservation;
}

/** A Guard decision that does not belong to the current request. */
export class GuardDecisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GuardDecisionError';
  }
}

interface NodeResult {
  value: Value;
  outcome: string;
  branch?: 'true' | 'false' | 'continue' | 'done';
  /** Extra metadata (program/pid/byte counts) for the completion log. */
  log?: Partial<RuntimeLogEntry>;
}

/** The persisted field cannot be applied to this composition. */
export class FieldRestoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FieldRestoreError';
  }
}

/**
 * A new Pheromone was refused because its target node already holds
 * `queueMax` entries. The rejection never drops an existing input, so the
 * caller can retry later once the queue has drained.
 */
export class QueueFullError extends Error {
  readonly nodeId: NodeId;
  readonly queueMax: number;
  readonly queueDepth: number;

  constructor(nodeId: NodeId, queueMax: number, queueDepth: number) {
    super(
      `queue for node '${nodeId}' is full (queueMax=${String(queueMax)}, queueDepth=${String(queueDepth)}); refusing new Pheromone`,
    );
    this.name = 'QueueFullError';
    this.nodeId = nodeId;
    this.queueMax = queueMax;
    this.queueDepth = queueDepth;
  }
}

function newPheromoneId(): string {
  return `ph_${randomUUID()}`;
}

function newTraceId(): string {
  return `tr_${randomUUID()}`;
}

/**
 * PheromoneField runtime.
 *
 * A normal node consumes one Pheromone and emits at most one; a node without
 * an outgoing edge is terminal. A Fork consumes one and emits one tagged copy
 * per branch. A Merge groups branch Pheromones by forkId, consumes the required
 * set atomically and emits one combined Pheromone. No cursor, no Run.
 */
export class PheromoneRuntime {
  private readonly definition: CompositionDefinition;
  private readonly executor: NodeExecutor;
  private readonly projectDirectory: string | undefined;
  private readonly now: () => number;
  private readonly onLog: RuntimeLogSink | undefined;
  private readonly guardTimeoutMs: number;
  private readonly onGuard: ((request: GuardRequest) => Promise<GuardDecision>) | undefined;
  private readonly onGuardExpired: ((requestId: string) => void) | undefined;
  private readonly guardWaiters = new Map<string, { readonly requestId: string; resolve: (decision: GuardDecision) => void }>();
  private readonly states: Map<NodeId, NodeState> = new Map();
  /** Answers that arrived before their user node hovered; preserved, not dropped. */
  private readonly preAnswers = new Map<NodeId, Value[]>();
  /**
   * True when the last pump stopped only because a target queue was full. The
   * CLI uses it to sleep a short retry interval instead of spinning at 0ms.
   */
  private blockedByQueue = false;
  /** Blocked activations already logged, so a retry loop does not spam Honey. */
  private readonly reportedBlocks = new Set<string>();
  /** Short critical section for every live field/node state transaction. */
  private readonly stateLock = new StateLock();
  /** One live drain per awake bee; an absent entry means the bee is resting. */
  private readonly drains = new Map<NodeId, Promise<void>>();
  /** The first activation failure; the pump stops starting unrelated bees. */
  private failure: unknown;
  private resting: boolean;

  constructor(definition: CompositionDefinition, options: RuntimeOptions) {
    if (typeof options?.executeForager?.execute !== 'function') {
      throw new TypeError('options.executeForager must implement execute()');
    }

    this.definition = definition;
    this.executor = options.executeForager;
    this.projectDirectory = options.projectDirectory;
    this.now = options.now ?? Date.now;
    this.onLog = options.onLog;
    this.guardTimeoutMs = options.guardTimeoutMs ?? DEFAULT_GUARD_TIMEOUT_MS;
    if (!Number.isFinite(this.guardTimeoutMs) || this.guardTimeoutMs <= 0) {
      throw new TypeError('options.guardTimeoutMs must be a positive number');
    }
    this.onGuard = options.onGuard;
    this.onGuardExpired = options.onGuardExpired;

    for (const id of definition.nodes.keys()) {
      this.states.set(id, createNodeState());
    }
    this.resting = isFieldResting(this.states.values());
  }

  /** Creates a Pheromone at the target node and returns its id. */
  trigger(nodeId: NodeId, value: Value = { kind: 'text', text: '' }): string {
    const node = this.definition.nodes.get(nodeId);
    if (node === undefined) {
      throw new Error(`unknown node '${nodeId}'`);
    }
    if (node.kind !== 'forager' && node.kind !== 'worker' && node.kind !== 'user') {
      throw new Error(
        `trigger target '${nodeId}' must be a forager, worker or user node, got '${node.kind}'`,
      );
    }
    assertValue(value);

    const pheromone: Pheromone = {
      id: newPheromoneId(),
      traceId: newTraceId(),
      value: structuredClone(value),
      // `at` is the enqueue instant: the TTL clock starts here.
      at: this.iso(),
    };

    this.stateLock.runSync(() => {
      const state = this.stateOf(node.id);
      const mailbox = this.ensureMailbox(state);
      const reserved = state.reserved ?? 0;
      if (mailbox.length + reserved >= this.definition.defaults.queueMax) {
        this.rejectQueueFull(
          node,
          mailbox.length + reserved,
          pheromone.id,
          pheromone.traceId,
        );
      }
      mailbox.push(pheromone);
      this.resting = false;
      this.log({
        event: 'pheromone.enqueued',
        nodeId: node.id,
        nodeKind: node.kind,
        pheromoneId: pheromone.id,
        traceId: pheromone.traceId,
        queueDepth: mailbox.length,
      });
    });

    return pheromone.id;
  }

  /**
   * Activates every runnable node until the field is quiet.
   *
   * A node whose output queue is full is not activated and its input stays queued
   * or pending. It is retried in the same pump after other work has had a
   * chance to drain the target, and by the next pump otherwise. Backpressure is
   * therefore discovered before the source is consumed, never after.
   */
  async pump(): Promise<void> {
    this.failure = undefined;
    this.blockedByQueue = false;
    this.stateLock.runSync(() =>
      expireOverdueQueues(this.definition, this.states, this.now(), this.log.bind(this)),
    );
    try {
      for (;;) {
        await this.startRunnableDrains();
        if (this.failure !== undefined) {
          break;
        }
        if (this.drains.size > 0) {
          await Promise.allSettled([...this.drains.values()]);
          if (this.failure !== undefined) {
            break;
          }
          continue;
        }
        // With no bee awake, settle restored joins and deadlines, then look
        // for the work that settlement may have produced.
        const progressed = this.stateLock.runSync(() => this.settleQuietState());
        if (progressed) {
          continue;
        }
        break;
      }
    } finally {
      this.stateLock.runSync(() => this.refreshRest());
      this.blockedByQueue = this.blockedByQueue && !this.resting;
    }
    if (this.failure !== undefined) {
      // Let every started drain settle (their finally removes mailboxes and
      // records Rest) before the failure leaves the pump.
      await Promise.allSettled([...this.drains.values()]);
      throw this.failure;
    }
  }

  /**
   * Starts one drain per runnable bee until no bee can start. The first start
   * runs synchronously, so a caller that pumps and then yields observes the
   * active input. Later starts wait one turn: an activation that fails
   * immediately is then visible before an unrelated bee starts, which keeps the
   * old "a failed pump does not run the next node" behaviour while still
   * overlapping slow activations on different bees.
   */
  private async startRunnableDrains(): Promise<void> {
    for (;;) {
      const next = this.stateLock.runSync(() => this.takeRunnable());
      if (next === null) {
        return;
      }
      const nodeId = next.node.id;
      const drain = this.drain(nodeId, next);
      this.drains.set(nodeId, drain);
      void drain.catch(() => undefined);
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (this.failure !== undefined) {
        return;
      }
    }
  }

  /**
   * Drives one bee's mailbox in FIFO order. Only one drain exists per bee, so
   * its activations can never overlap. The drain removes its mailbox and
   * returns to rest when no pending input is left.
   */
  private async drain(nodeId: NodeId, first: Activation): Promise<void> {
    let activation: Activation | null = first;
    try {
      while (activation !== null) {
        await this.activate(activation.node, activation.pheromone, activation.reservation);
        activation = this.stateLock.runSync(() => {
          // A long activation can outlive `queueTtlMs`: re-check before the
          // drain takes its next input.
          expireOverdueQueues(this.definition, this.states, this.now(), this.log.bind(this));
          return this.takeNextForNode(nodeId);
        });
      }
    } catch (error) {
      if (this.failure === undefined) {
        this.failure = error;
      }
      throw error;
    } finally {
      this.stateLock.runSync(() => {
        this.drains.delete(nodeId);
        restMailboxIfIdle(this.stateOf(nodeId));
      });
    }
  }

  /**
   * Settles restored/blocked joins and deadlines once no activation is running.
   * Returns true when it produced work the pump must drain before it can rest.
   */
  private settleQuietState(): boolean {
    const settled = this.settleCompleteJoins();
    if (settled === 'settled') {
      return true;
    }
    if (settled === 'blocked') {
      this.blockedByQueue = true;
    }
    // A merge deadline that passed while the field was quiet fails its fork.
    if (this.expireDueJoins()) {
      return true;
    }
    // Quiet and still waiting for a branch that is nowhere in the field:
    // that branch can never arrive, so the merge fails instead of leaving the
    // field permanently non-Rest.
    this.failMissingJoins();
    return false;
  }

  /**
   * The earliest deadline of an incomplete Merge join, or undefined when none
   * is waiting. A caller that has no hover to service can sleep until this
   * instant and pump again; it is the runtime's only timed wake signal.
   *
   * While a queue-full block is holding work, a short retry instant is also
   * returned so the caller never busy-spins at 0ms waiting for another node's
   * queue to drain.
   */
  nextWakeAt(): number | undefined {
    let next: number | undefined;
    for (const node of this.definition.nodes.values()) {
      if (node.kind !== 'merge') {
        continue;
      }
      const joins = this.stateOf(node.id).joins;
      if (joins === undefined) {
        continue;
      }
      for (const join of joins.values()) {
        if (isJoinClosed(join) || join.deadlineAt === undefined) {
          continue;
        }
        // A complete join is only waiting for downstream queue space; its old
        // deadline must not wake the caller (or spin it at 0ms) after it passed.
        if (this.requiredComplete(node, join)) {
          continue;
        }
        if (next === undefined || join.deadlineAt < next) {
          next = join.deadlineAt;
        }
      }
    }
    if (this.blockedByQueue) {
      const retryAt = this.now() + QUEUE_RETRY_MS;
      next = next === undefined ? retryAt : Math.min(next, retryAt);
    }
    return next;
  }

  /** Immutable view of the PheromoneField. */
  snapshot(): PheromoneFieldSnapshot {
    return snapshotField(this.definition, this.states, this.resting);
  }

  /**
   * Answers a user node. While the node hovers the answer completes it; before
   * that the answer is queued and applied when the node next hovers. Neither
   * case drops the input.
   */
  answerHover(nodeId: NodeId, value: Value, token?: string): void {
    const node = this.definition.nodes.get(nodeId);
    if (node === undefined) {
      throw new Error(`unknown node '${nodeId}'`);
    }
    if (node.kind !== 'user') {
      throw new Error(`node '${nodeId}' is not a user node, got '${node.kind}'`);
    }
    assertUserValue(node, value);

    const state = this.stateOf(nodeId);
    if (state.hover !== undefined) {
      if (token !== undefined && token !== state.hover.token) {
        throw new Error(`hover token mismatch for node '${nodeId}'`);
      }
      const pheromone = state.hoverPheromone;
      if (pheromone === undefined) {
        throw new Error(`hover for node '${nodeId}' has no Pheromone`);
      }
      this.completeHover(node, pheromone, value, 'answered');
      return;
    }

    const queue = this.preAnswers.get(nodeId) ?? [];
    queue.push(structuredClone(value));
    this.preAnswers.set(nodeId, queue);
    this.log({
      event: 'input.queued',
      nodeId,
      nodeKind: 'user',
      queueDepth: queue.length,
    });
  }

  /** JSON shape for `honey/field.json`; safe to persist at any pause point. */
  exportField(): PersistedField {
    const nodes: Record<NodeId, PersistedNodeState> = {};
    for (const [id, state] of this.states) {
      const persisted: PersistedNodeState = { queue: mailboxOf(state).map(clonePheromone) };      if (state.pending !== undefined) {
        persisted.pending = clonePheromone(state.pending);
      }
      if (state.active !== undefined) {
        persisted.active = clonePheromone(state.active);
      }
      if (state.hover !== undefined) {
        persisted.hover = structuredClone(state.hover);
      }
      if (state.hoverPheromone !== undefined) {
        persisted.hoverPheromone = clonePheromone(state.hoverPheromone);
      }
      if (state.lastActivatedAt !== undefined) {
        persisted.lastActivatedAt = state.lastActivatedAt;
      }
      if (state.state !== undefined) {
        persisted.state = structuredClone(state.state);
      }
      if (state.joins !== undefined && state.joins.size > 0) {
        const entries: [string, PersistedJoinState][] = [];
        for (const [forkId, join] of state.joins) {
          entries.push([
            forkId,
            {
              arrived: [...join.arrived.values()].map(clonePheromone),
              ...(join.lineage === undefined ? {} : { lineage: copyLineage(join.lineage) }),
              ...(join.completedAt === undefined ? {} : { completedAt: join.completedAt }),
              ...(join.deadlineAt === undefined ? {} : { deadlineAt: join.deadlineAt }),
              ...(join.timedOutAt === undefined ? {} : { timedOutAt: join.timedOutAt }),
            },
          ]);
        }
        persisted.joins = Object.fromEntries(entries);
      }
      const earlyInputs = this.preAnswers.get(id);
      if (earlyInputs !== undefined && earlyInputs.length > 0) {
        persisted.inputs = structuredClone(earlyInputs);
      }
      nodes[id] = persisted;
    }

    return {
      schemaVersion: 1,
      compositionId: this.definition.id,
      graphRevision: this.definition.graphRevision,
      rest: this.resting,
      nodes,
    };
  }

  /**
   * Rebuilds a runtime from a persisted field.
   *
   * Queued Pheromones, pending slots and user hovers are resumed. An `active`
   * Pheromone cannot be reattached to a native process: a forager becomes
   * `unknown`, anything else becomes stuck/needs-attention. Neither is replayed.
   */
  static restore(
    definition: CompositionDefinition,
    field: PersistedField,
    options: RuntimeOptions,
  ): { runtime: PheromoneRuntime; report: RecoveryReport } {
    if (field.schemaVersion !== 1) {
      throw new FieldRestoreError(`unsupported field schemaVersion: ${String(field.schemaVersion)}`);
    }
    if (field.compositionId !== definition.id) {
      throw new FieldRestoreError(
        `persisted field belongs to composition '${field.compositionId}', not '${definition.id}'`,
      );
    }
    if (field.graphRevision !== definition.graphRevision) {
      throw new FieldRestoreError(
        `persisted field was written for graph revision '${field.graphRevision}', current is '${definition.graphRevision}'`,
      );
    }

    const runtime = new PheromoneRuntime(definition, options);
    const report = runtime.applyField(field);
    return { runtime, report };
  }

  private applyField(field: PersistedField): RecoveryReport {
    for (const id of Object.keys(field.nodes)) {
      if (!this.definition.nodes.has(id)) {
        throw new FieldRestoreError(`persisted field has unknown node '${id}'`);
      }
    }

    const resumedHovers: NodeId[] = [];
    const unknownActive: NodeId[] = [];
    const stuckActive: NodeId[] = [];
    /**
     * A branch whose process is gone can never reach its Merge. A required
     * branch fails its fork; an optional-only branch is logged and dropped.
     */
    const failedBranches: { forkId: string; branchId?: string }[] = [];
    const seenFailedBranches = new Set<string>();
    const markFailedBranch = (pheromone: Pheromone): void => {
      if (pheromone.forkId === undefined) {
        return;
      }
      const key = `${pheromone.forkId}\u0000${pheromone.branchId ?? ''}`;
      if (seenFailedBranches.has(key)) {
        return;
      }
      seenFailedBranches.add(key);
      failedBranches.push(
        pheromone.branchId === undefined
          ? { forkId: pheromone.forkId }
          : { forkId: pheromone.forkId, branchId: pheromone.branchId },
      );
    };

    for (const [id, node] of this.definition.nodes) {
      const saved = field.nodes[id];
      if (saved === undefined) {
        continue;
      }
      const state = this.stateOf(id);
      // A restored queue is kept exactly as persisted, even when it already
      // holds `queueMax` or more entries (a field written before the limit was
      // enforced, or under a larger limit). Dropping entries here would lose
      // accepted input. Such a queue drains normally, while new enqueues are
      // rejected until its depth falls below `queueMax`.
      setMailbox(state, saved.queue.map(normalizePheromone));
      if (saved.pending !== undefined) {
        state.pending = normalizePheromone(saved.pending);
      }
      if (saved.lastActivatedAt !== undefined) {
        state.lastActivatedAt = saved.lastActivatedAt;
      }
      if (saved.state !== undefined) {
        state.state = structuredClone(saved.state);
      }
      if (saved.inputs !== undefined && saved.inputs.length > 0) {
        this.preAnswers.set(id, structuredClone(saved.inputs));
      }
      if (saved.joins !== undefined) {
        if (node.kind !== 'merge') {
          throw new FieldRestoreError(
            `persisted field has merge joins on non-merge node '${id}'`,
          );
        }
        const joins = this.restoreJoins(node, saved.joins);
        if (joins.size > 0) {
          state.joins = joins;
          // Age out stale closed markers that outlived their retention while
          // the process was down.
          this.pruneJoinTombstones(node);
        }
      }

      if (
        saved.hover !== undefined &&
        saved.hover.kind === 'user' &&
        saved.hoverPheromone !== undefined
      ) {
        state.hover = structuredClone(saved.hover);
        state.hoverPheromone = normalizePheromone(saved.hoverPheromone);
        resumedHovers.push(id);
      } else if (saved.hover !== undefined) {
        // A Guard cannot be answered after the native request is gone: it is
        // cancelled, never resumed and never auto-allowed.
        stuckActive.push(id);
        state.state = { ...(state.state ?? {}), needsAttention: true };
        if (saved.hoverPheromone !== undefined) {
          markFailedBranch(saved.hoverPheromone);
        }
      }

      if (saved.active !== undefined) {
        // No native process can be reattached; never replay the side effect.
        if (node.kind === 'forager') {
          unknownActive.push(id);
          state.state = { ...(state.state ?? {}), lastOutcome: 'unknown' };
        } else {
          stuckActive.push(id);
        }
        state.state = { ...(state.state ?? {}), needsAttention: true };
        markFailedBranch(saved.active);
      }
    }

    for (const failed of failedBranches) {
      this.handleBranchFailure(failed.forkId, failed.branchId, 'unknown-active');
    }

    // A deadline that passed while the process was down fails immediately on
    // restore: the join must never resume waiting past its absolute deadline.
    this.expireDueJoins();

    // Queues are restored exactly as persisted, then aged out here: an entry
    // that outlived `queueTtlMs` while the process was down is dropped (and
    // logged) before the field is handed back as runnable.
    expireOverdueQueues(this.definition, this.states, this.now(), this.log.bind(this));

    this.resting = isFieldResting(this.states.values());
    this.log({
      event: 'runtime.restored',
      outcome: `hovers=${String(resumedHovers.length)} unknown=${String(unknownActive.length)} stuck=${String(stuckActive.length)}`,
    });

    return { resumedHovers, unknownActive, stuckActive };
  }

  /**
   * Marks nodes as needing a human after a forced edit or a guard that cannot
   * be resumed. State is kept; nothing is replayed.
   */
  markNeedsAttention(nodeIds: readonly NodeId[]): void {
    for (const id of nodeIds) {
      const node = this.definition.nodes.get(id);
      if (node === undefined) {
        throw new Error(`unknown node '${id}'`);
      }
      const state = this.stateOf(id);
      state.state = { ...(state.state ?? {}), needsAttention: true };
      this.log({ event: 'runtime.attention', nodeId: id, nodeKind: node.kind });
    }
  }

  private stateOf(nodeId: NodeId): NodeState {
    const state = this.states.get(nodeId);
    if (state === undefined) {
      throw new Error(`unknown node '${nodeId}'`);
    }
    return state;
  }

  /** Creates the mailbox on first enqueue; a resting bee has none. */
  private ensureMailbox(state: NodeState): Pheromone[] {
    return state.queue ?? (state.queue = []);
  }

  /**
   * The queue slots this activation will need. For a worker Condition both
   * possible branches are counted because its exit code is unknowable before
   * it runs; a text/boolean/choice Condition and a Counter are evaluated up
   * front so only the branch that will actually emit is checked.
   */
  private outputTargets(
    node: NodeDefinition,
    pheromone: Pheromone,
  ): readonly { readonly targetId: NodeId; readonly count: number }[] {
    if (node.kind === 'fork') {
      return node.config.branches.map((branch) => ({ targetId: branch.to, count: 1 }));
    }

    if (
      node.kind === 'forager' ||
      node.kind === 'worker' ||
      node.kind === 'merge'
    ) {
      const edge = this.definition.edges.find((candidate) => candidate.from === node.id);
      return edge === undefined ? [] : [{ targetId: edge.to, count: 1 }];
    }

    if (node.kind === 'user') {
      // A user activation only emits when an early answer is already waiting.
      if ((this.preAnswers.get(node.id)?.length ?? 0) === 0) {
        return [];
      }
      return this.userOutputTargets(node);
    }

    if (node.kind === 'condition') {
      if (node.config.mode === 'worker') {
        const targets: { targetId: NodeId; count: number }[] = [];
        for (const when of ['true', 'false'] as const) {
          const edge = this.definition.edges.find(
            (candidate) => candidate.from === node.id && candidate.when === when,
          );
          if (edge !== undefined) {
            targets.push({ targetId: edge.to, count: 1 });
          }
        }
        return targets;
      }

      let branch: 'true' | 'false';
      try {
        branch = evaluateCondition(node.config, pheromone.value);
      } catch {
        // Let activation report the real input error; no output will be emitted.
        return [];
      }
      const edge = this.definition.edges.find(
        (candidate) => candidate.from === node.id && candidate.when === branch,
      );
      return edge === undefined ? [] : [{ targetId: edge.to, count: 1 }];
    }

    const previous = this.stateOf(node.id).state?.['count'];
    const count = (typeof previous === 'number' ? previous : 0) + node.config.step;
    const branch = count >= node.config.max ? 'done' : 'continue';
    const edge = this.definition.edges.find(
      (candidate) => candidate.from === node.id && candidate.when === branch,
    );
    return edge === undefined ? [] : [{ targetId: edge.to, count: 1 }];
  }

  private queueDepthOf(targetId: NodeId): number {
    const state = this.stateOf(targetId);
    return (state.queue?.length ?? 0) + (state.reserved ?? 0);
  }

  /** The static outgoing target of a user node, if it has one. */
  private userOutputTargets(
    node: UserNode,
  ): readonly { readonly targetId: NodeId; readonly count: number }[] {
    const edge = this.definition.edges.find((candidate) => candidate.from === node.id);
    return edge === undefined ? [] : [{ targetId: edge.to, count: 1 }];
  }

  private queueAvailable(targetId: NodeId): number {
    return this.definition.defaults.queueMax - this.queueDepthOf(targetId);
  }

  /**
   * Reserves every required slot atomically: if any target cannot take all of
   * its outputs, nothing is reserved and the caller keeps its input.
   */
  private tryReserve(
    targets: readonly { readonly targetId: NodeId; readonly count: number }[],
  ): ReserveOutcome {
    const needed = new Map<NodeId, number>();
    for (const { targetId, count } of targets) {
      if (!this.definition.nodes.has(targetId)) {
        throw new Error(`unknown edge target '${targetId}'`);
      }
      needed.set(targetId, (needed.get(targetId) ?? 0) + count);
    }

    for (const [targetId, count] of needed) {
      if (count > this.queueAvailable(targetId)) {
        return { ok: false, target: targetId, queueDepth: this.queueDepthOf(targetId) };
      }
    }

    const slots = new Map<NodeId, number>();
    for (const [targetId, count] of needed) {
      const state = this.stateOf(targetId);
      state.reserved = (state.reserved ?? 0) + count;
      slots.set(targetId, count);
    }
    return { ok: true, reservation: { slots } };
  }

  /** Gives back every slot this reservation still holds. */
  private releaseReservation(reservation: OutputReservation): void {
    for (const [targetId, count] of reservation.slots) {
      const state = this.stateOf(targetId);
      const reserved = (state.reserved ?? 0) - count;
      if (reserved <= 0) {
        delete state.reserved;
      } else {
        state.reserved = reserved;
      }
    }
    reservation.slots.clear();
  }

  /** Converts one reserved slot into an enqueued Pheromone. */
  private consumeReservation(reservation: OutputReservation, targetId: NodeId): void {
    const held = reservation.slots.get(targetId);
    if (held === undefined || held <= 0) {
      throw new Error(
        `node '${targetId}' has no reserved output slot for this activation`,
      );
    }
    const state = this.stateOf(targetId);
    const reserved = state.reserved ?? 0;
    if (reserved <= 0) {
      throw new Error(`node '${targetId}' lost its reserved output slot`);
    }
    if (reserved === 1) {
      delete state.reserved;
    } else {
      state.reserved = reserved - 1;
    }
    if (held === 1) {
      reservation.slots.delete(targetId);
    } else {
      reservation.slots.set(targetId, held - 1);
    }
  }

  /** Reserves the single static output of a Merge, if it has one. */
  private reserveMergeOutput(node: MergeNode): ReserveOutcome {
    const edge = this.definition.edges.find((candidate) => candidate.from === node.id);
    if (edge === undefined) {
      return { ok: true, reservation: { slots: new Map() } };
    }
    return this.tryReserve([{ targetId: edge.to, count: 1 }]);
  }

  /**
   * Logs a deferred activation once per source Pheromone. Retrying every 100ms
   * must not append a Honey line per attempt.
   */
  private logBlocked(
    node: NodeDefinition,
    pheromone: Pheromone,
    target: NodeId,
    queueDepth: number,
  ): void {
    const key = `activation\0${pheromone.id}\0${target}`;
    if (this.reportedBlocks.has(key)) {
      return;
    }
    this.reportedBlocks.add(key);
    this.log({
      event: 'pheromone.blocked',
      nodeId: node.id,
      nodeKind: node.kind,
      pheromoneId: pheromone.id,
      traceId: pheromone.traceId,
      queueDepth,
      outcome: `queue-max:${target}`,
    });
  }

  private logHoverBlocked(
    node: UserNode,
    pheromone: Pheromone,
    target: NodeId,
    queueDepth: number,
    hoverOutcome: string,
  ): void {
    const key = `hover\0${pheromone.id}\0${target}`;
    if (this.reportedBlocks.has(key)) {
      return;
    }
    this.reportedBlocks.add(key);
    this.log({
      event: 'hover.blocked',
      nodeId: node.id,
      nodeKind: 'user',
      pheromoneId: pheromone.id,
      traceId: pheromone.traceId,
      queueDepth,
      outcome: `${hoverOutcome}:queue-max:${target}`,
    });
  }

  private logMergeBlocked(
    node: MergeNode,
    forkId: string,
    target: NodeId,
    queueDepth: number,
  ): void {
    const key = `merge\0${node.id}\0${forkId}\0${target}`;
    if (this.reportedBlocks.has(key)) {
      return;
    }
    this.reportedBlocks.add(key);
    this.log({
      event: 'merge.blocked',
      nodeId: node.id,
      nodeKind: 'merge',
      forkId,
      queueDepth,
      outcome: `queue-max:${target}`,
    });
  }

  /**
   * Picks the next activation whose output can be accepted.
   *
   * The target queues are checked (and reserved) before the input is consumed.
   * When a target is full the input stays in `pending` and the bee is skipped;
   * a later scan retries it. No `node.failed` is written and no Pheromone is
   * lost.
   */
  private takeRunnable(): Activation | null {
    const now = this.now();
    for (const node of this.definition.nodes.values()) {
      if (this.drains.has(node.id)) {
        continue;
      }
      const activation = this.takeForNode(node, now);
      if (activation !== null) {
        return activation;
      }
    }
    return null;
  }

  /** The next activation of one bee, called inside that bee's own drain. */
  private takeNextForNode(nodeId: NodeId): Activation | null {
    const node = this.definition.nodes.get(nodeId);
    return node === undefined ? null : this.takeForNode(node, this.now());
  }

  private takeForNode(node: NodeDefinition, now: number): Activation | null {
    const state = this.stateOf(node.id);
    if (state.active !== undefined || state.hover !== undefined) {
      return null;
    }

    const dueAt =
      state.lastActivatedAt === undefined
        ? Number.NEGATIVE_INFINITY
        : Date.parse(state.lastActivatedAt) + node.minIntervalMs;

    this.stagePending(node, state, now, dueAt);
    if (state.pending === undefined || now < dueAt) {
      return null;
    }

    const pheromone = state.pending;
    const reserved = this.tryReserve(this.outputTargets(node, pheromone));
    if (!reserved.ok) {
      // Keep the pending Pheromone exactly where it is. The queue was not
      // allowed to grow, so the source input is preserved instead of being
      // consumed and reported as a failure.
      this.blockedByQueue = true;
      this.logBlocked(node, pheromone, reserved.target, reserved.queueDepth);
      return null;
    }
    delete state.pending;
    return { node, pheromone, reservation: reserved.reservation };
  }

  /** Moves the mailbox head into `pending`, even when its rate limit is future. */
  private stagePending(
    node: NodeDefinition,
    state: NodeState,
    now: number,
    dueAt: number,
  ): void {
    if (state.pending !== undefined || (state.queue?.length ?? 0) === 0) {
      return;
    }
    const head = state.queue?.shift();
    if (head === undefined) {
      return;
    }
    state.pending = head;
    if (now < dueAt) {
      this.log({
        event: 'pheromone.pending',
        nodeId: node.id,
        nodeKind: node.kind,
        pheromoneId: head.id,
        traceId: head.traceId,
        queueDepth: state.queue?.length ?? 0,
      });
    }
  }

  private async activate(
    node: NodeDefinition,
    pheromone: Pheromone,
    reservation: OutputReservation,
  ): Promise<void> {
    const state = this.stateOf(node.id);
    try {
      const startedAt = this.stateLock.runSync(() =>
        this.beginActivation(node, pheromone, reservation, state),
      );
      if (startedAt === null) {
        return;
      }
      try {
        if (node.kind === 'fork' || node.kind === 'merge') {
          this.stateLock.runSync(() =>
            this.finishSyncActivation(node, pheromone, reservation, state, startedAt),
          );
          return;
        }
        // Execution and native waits are outside every state lock.
        const result = await this.runNode(node, pheromone, state);
        this.stateLock.runSync(() =>
          this.finishAsyncActivation(node, pheromone, result, reservation, state, startedAt),
        );
      } catch (error) {
        const optionalOnly = this.stateLock.runSync(() =>
          this.failActivation(node, pheromone, error, state, startedAt),
        );
        if (!optionalOnly) {
          throw error;
        }
      }
    } finally {
      this.stateLock.runSync(() => {
        // Whatever the activation did not emit is released; every consumed slot
        // was already decremented by pushPheromone().
        this.releaseReservation(reservation);
        delete state.active;
      });
    }
  }

  /**
   * Opens the activation: user hovers resolve synchronously and return null;
   * every other node becomes `active` and returns its start instant.
   */
  private beginActivation(
    node: NodeDefinition,
    pheromone: Pheromone,
    reservation: OutputReservation,
    state: NodeState,
  ): number | null {
    state.lastActivatedAt = this.iso();
    this.resting = false;
    if (node.kind === 'user') {
      logActivated(this.log.bind(this), node, pheromone, state);
      this.openHover(node, pheromone, reservation);
      return null;
    }
    state.active = pheromone;
    const startedAt = this.now();
    logActivated(this.log.bind(this), node, pheromone, state);
    return startedAt;
  }

  /** Fork/merge commit their whole output in one short synchronous batch. */
  private finishSyncActivation(
    node: NodeDefinition,
    pheromone: Pheromone,
    reservation: OutputReservation,
    state: NodeState,
    startedAt: number,
  ): void {
    if (node.kind === 'fork') {
      this.emitFork(node, pheromone, reservation);
      logCompleted(this.log.bind(this), node, pheromone, this.now() - startedAt, 'forked');
    } else if (node.kind === 'merge') {
      const outcome = this.arriveAtMerge(node, pheromone, reservation);
      logCompleted(this.log.bind(this), node, pheromone, this.now() - startedAt, outcome);
    } else {
      throw new Error(`node '${node.id}' is not a synchronous activation`);
    }
    delete state.active;
  }

  private finishAsyncActivation(
    node: NodeDefinition,
    pheromone: Pheromone,
    result: NodeResult,
    reservation: OutputReservation,
    state: NodeState,
    startedAt: number,
  ): void {
    logCompleted(
      this.log.bind(this),
      node,
      pheromone,
      this.now() - startedAt,
      result.outcome,
      result.log,
    );
    this.emit(node, pheromone, result, reservation);
    delete state.active;
  }

  /** Returns true when the failure only affected an optional Merge branch. */
  private failActivation(
    node: NodeDefinition,
    pheromone: Pheromone,
    error: unknown,
    state: NodeState,
    startedAt: number,
  ): boolean {
    delete state.active;
    logFailed(this.log.bind(this), node, pheromone, startedAt, this.now(), error);
    if (pheromone.forkId === undefined) {
      return false;
    }
    // A required branch that failed can never reach its Merge; cancel its
    // siblings so no join waits forever. An optional-only branch is logged and
    // dropped without failing the required set.
    return (
      this.handleBranchFailure(pheromone.forkId, pheromone.branchId, 'failed-branch') === 'optional'
    );
  }

  private async runNode(
    node: NodeDefinition,
    pheromone: Pheromone,
    state: NodeState,
  ): Promise<NodeResult> {
    if (node.kind === 'forager') {
      const context: ExecutionContext = {
        requestGuard: (request, decide) => this.requestGuard(node, pheromone, request, decide),
      };
      const output = await this.executor.execute(node, pheromone.value, context);
      assertValue(output);
      return { value: output, outcome: 'ok' };
    }

    if (node.kind === 'worker') {
      const result = await runWorker(node.config, this.requireProjectDirectory(node));
      if (result.exitCode !== 0) {
        throw workerExitError(result);
      }
      return {
        value: { kind: 'text', text: result.stdout },
        outcome: 'ok',
        log: workerLogFields(result),
      };
    }

    if (node.kind === 'condition') {
      if (node.config.mode === 'worker') {
        // Non-zero is a false branch here, not a runtime failure.
        const result = await runWorker(node.config, this.requireProjectDirectory(node));
        const branch = result.exitCode === 0 ? 'true' : 'false';
        return {
          value: pheromone.value,
          outcome: branch,
          branch,
          log: workerLogFields(result),
        };
      }
      const branch = evaluateCondition(node.config, pheromone.value);
      return { value: pheromone.value, outcome: branch, branch };
    }

    if (node.kind === 'user') {
      throw new Error(`user node '${node.id}' waits for input instead of running`);
    }

    if (node.kind !== 'counter') {
      throw new Error(`node '${node.id}' (${node.kind}) cannot run as a task`);
    }

    const previous = state.state?.['count'];
    const count = (typeof previous === 'number' ? previous : 0) + node.config.step;
    state.state = { ...(state.state ?? {}), count };
    const branch = count >= node.config.max ? 'done' : 'continue';
    return { value: pheromone.value, outcome: branch, branch };
  }

  private requireProjectDirectory(node: NodeDefinition): string {
    if (this.projectDirectory === undefined || this.projectDirectory.trim() === '') {
      throw new Error(
        `node '${node.id}' is a worker but no project directory is registered`,
      );
    }
    return this.projectDirectory;
  }

  private openHover(
    node: UserNode,
    pheromone: Pheromone,
    reservation: OutputReservation,
  ): void {
    const state = this.stateOf(node.id);
    const queued = this.preAnswers.get(node.id);
    // Peek before consuming: if the early answer cannot be emitted yet, the
    // answer must stay queued for the next attempt. takeRunnable already
    // reserved the target, so this normally succeeds.
    const early = queued?.[0];

    if (early !== undefined && queued !== undefined) {
      this.completeHover(node, pheromone, early, 'early-input', reservation);
      queued.shift();
      if (queued.length === 0) {
        this.preAnswers.delete(node.id);
      }
      return;
    }

    const hover: HoverSpec = {
      token: `hv_${randomUUID()}`,
      kind: 'user',
      compositionId: this.definition.id,
      nodeId: node.id,
      pheromoneId: pheromone.id,
    };
    state.hover = hover;
    state.hoverPheromone = pheromone;
    this.log({
      event: 'hover.opened',
      nodeId: node.id,
      nodeKind: 'user',
      pheromoneId: pheromone.id,
      traceId: pheromone.traceId,
    });
  }

  /**
   * Resolves one hover and emits its answer.
   *
   * The downstream queue is checked (and reserved) before the hover is
   * deleted. When it is full the hover and its Pheromone stay in place and a
   * `QueueFullError` is thrown, so the answer can be retried once the target
   * drains instead of being consumed and dropped.
   */
  private completeHover(
    node: UserNode,
    pheromone: Pheromone,
    value: Value,
    outcome: string,
    reservation?: OutputReservation,
  ): void {
    const state = this.stateOf(node.id);
    const owned = reservation === undefined;
    let held = reservation;
    if (held === undefined) {
      const reserved = this.tryReserve(this.userOutputTargets(node));
      if (!reserved.ok) {
        this.logHoverBlocked(node, pheromone, reserved.target, reserved.queueDepth, outcome);
        throw new QueueFullError(
          reserved.target,
          this.definition.defaults.queueMax,
          reserved.queueDepth,
        );
      }
      held = reserved.reservation;
    }

    try {
      delete state.hover;
      delete state.hoverPheromone;
      this.log({
        event: 'hover.resolved',
        nodeId: node.id,
        nodeKind: 'user',
        pheromoneId: pheromone.id,
        traceId: pheromone.traceId,
        outcome,
      });
      this.emit(node, pheromone, { value: structuredClone(value), outcome }, held);
    } finally {
      if (owned) {
        this.releaseReservation(held);
      }
    }
  }

  /**
   * Opens a Guard hover for one native approval request and resolves with the
   * decision. A timeout cancels the request; nothing auto-allows.
   */
  private async requestGuard(
    node: NodeDefinition,
    pheromone: Pheromone,
    request: GuardRequest,
    decide?: (request: GuardRequest) => Promise<GuardDecision>,
  ): Promise<GuardDecision> {
    const state = this.stateOf(node.id);
    if (state.hover !== undefined) {
      throw new GuardDecisionError(`node '${node.id}' already has an open hover`);
    }

    const token = `gd_${randomUUID()}`;
    const hover: HoverSpec = {
      token,
      kind: 'guard',
      compositionId: this.definition.id,
      nodeId: node.id,
      pheromoneId: pheromone.id,
      meta: {
        requestId: request.requestId,
        executionId: request.executionId,
        summary: request.summary,
      },
    };
    state.hover = hover;
    this.log({
      event: 'guard.opened',
      nodeId: node.id,
      nodeKind: node.kind,
      pheromoneId: pheromone.id,
      traceId: pheromone.traceId,
      outcome: request.requestId,
    });

    let resolveWaiter: (decision: GuardDecision) => void = () => undefined;
    const waiter = new Promise<GuardDecision>((resolve) => {
      resolveWaiter = resolve;
    });
    this.guardWaiters.set(token, { requestId: request.requestId, resolve: resolveWaiter });

    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      try {
        this.onGuardExpired?.(request.requestId);
      } catch {
        // Notifying the broker is best effort. The runtime must still cancel
        // the guard and must never fall through to the native handler.
      }
      resolveWaiter('cancelled');
    }, this.guardTimeoutMs);
    timer.unref();

    const handler = decide ?? this.onGuard;
    const decisionPromise =
      handler === undefined
        ? Promise.resolve<GuardDecision>('reject_once')
        : Promise.resolve()
            .then(() => handler({ ...request, beeId: node.id }))
            .catch(() => 'reject_once' as GuardDecision);

    let decision: GuardDecision;
    try {
      decision = await Promise.race([decisionPromise, waiter]);
    } finally {
      clearTimeout(timer);
      this.guardWaiters.delete(token);
      if (state.hover?.token === token) {
        delete state.hover;
      }
    }

    this.log({
      event: expired ? 'guard.timeout' : 'guard.resolved',
      nodeId: node.id,
      nodeKind: node.kind,
      pheromoneId: pheromone.id,
      traceId: pheromone.traceId,
      outcome: expired ? 'cancelled' : decision,
    });

    return decision;
  }

  /**
   * Settles the open Guard for `requestId`. An early, late or mismatched
   * decision is rejected so it can never land on a different request.
   */
  settleGuard(nodeId: NodeId, requestId: string, decision: GuardDecision): void {
    const state = this.states.get(nodeId);
    const hover = state?.hover;
    if (hover === undefined || hover.kind !== 'guard' || hover.meta?.['requestId'] !== requestId) {
      throw new GuardDecisionError(`no open guard for request '${requestId}' on node '${nodeId}'`);
    }
    const waiter = this.guardWaiters.get(hover.token);
    if (waiter === undefined || waiter.requestId !== requestId) {
      throw new GuardDecisionError(`guard for request '${requestId}' is not waiting`);
    }
    this.guardWaiters.delete(hover.token);
    waiter.resolve(decision);
  }

  private emit(
    node: NodeDefinition,
    pheromone: Pheromone,
    result: NodeResult,
    reservation: OutputReservation,
  ): void {
    const edge = this.outgoingEdge(node, result);
    if (edge === undefined) {
      return;
    }

    // A branch keeps its full lineage through normal nodes so a downstream
    // Merge can still group it and restore the enclosing tags on output.
    const lineage = currentLineage(pheromone);
    this.pushPheromone(
      edge.to,
      pheromone.traceId,
      result.value,
      lineage.length === 0 ? undefined : lineage,
      reservation,
    );
  }

  /**
   * Fork consumes one Pheromone and emits one tagged copy per branch.
   *
   * Every target was reserved and counted before activation (one slot per
   * branch, so a repeated target needs one slot per occurrence). If the plan
   * could not reserve every branch the fork never ran at all, so no partially
   * filled branch set is ever left behind and the fork input is preserved.
   */
  private emitFork(
    node: ForkNode,
    pheromone: Pheromone,
    reservation: OutputReservation,
  ): void {
    const forkId = `fk_${randomUUID()}`;
    // Stage 5D: a nested Fork appends its tag to the incoming lineage instead
    // of overwriting the enclosing fork/branch tags.
    const parentLineage = currentLineage(pheromone);

    for (const branch of node.config.branches) {
      const target = this.definition.nodes.get(branch.to);
      if (target === undefined) {
        throw new Error(`unknown edge target '${branch.to}'`);
      }
    }

    for (const branch of node.config.branches) {
      this.pushPheromone(
        branch.to,
        pheromone.traceId,
        pheromone.value,
        [...parentLineage, { forkId, branchId: branch.id }],
        reservation,
      );
    }
  }

  private pushPheromone(
    targetId: NodeId,
    traceId: string,
    value: Value,
    lineage?: readonly BranchTag[],
    reservation?: OutputReservation,
  ): void {
    const targetNode = this.definition.nodes.get(targetId);
    if (targetNode === undefined) {
      throw new Error(`unknown edge target '${targetId}'`);
    }

    const targetState = this.stateOf(targetId);
    const current = lineage === undefined ? undefined : currentTag(lineage);
    const emitted: Pheromone = {
      id: newPheromoneId(),
      traceId,
      value: structuredClone(value),
      // `at` is the enqueue instant: the TTL clock starts here.
      at: this.iso(),
      ...(current === undefined
        ? {}
        : { forkId: current.forkId, branchId: current.branchId }),
      ...(lineage === undefined || lineage.length === 0
        ? {}
        : { lineage: copyLineage(lineage) }),
    };
    if (reservation !== undefined) {
      // The slot was reserved before the source was consumed, so it must be
      // available; consuming it first also keeps the capacity check honest.
      this.consumeReservation(reservation, targetId);
    }
    const reserved = targetState.reserved ?? 0;
    const mailbox = this.ensureMailbox(targetState);
    if (mailbox.length + reserved >= this.definition.defaults.queueMax) {
      this.rejectQueueFull(
        targetNode,
        mailbox.length + reserved,
        emitted.id,
        emitted.traceId,
        current === undefined
          ? {}
          : { forkId: current.forkId, branchId: current.branchId },
      );
    }
    mailbox.push(emitted);
    this.resting = false;
    this.log({
      event: 'pheromone.emitted',
      nodeId: targetNode.id,
      nodeKind: targetNode.kind,
      pheromoneId: emitted.id,
      traceId: emitted.traceId,
      ...(current === undefined
        ? {}
        : { forkId: current.forkId, branchId: current.branchId }),
      queueDepth: mailbox.length,
    });
  }

  /**
   * Refuses a new Pheromone for a full target queue. The field is left
   * untouched: nothing is pushed, nothing existing is evicted. The rejection
   * is logged before the error leaves the runtime, so it can never be silent.
   */
  private rejectQueueFull(
    target: NodeDefinition,
    queueDepth: number,
    pheromoneId: string,
    traceId: string,
    extra: { readonly forkId?: string; readonly branchId?: string } = {},
  ): never {
    const queueMax = this.definition.defaults.queueMax;
    this.log({
      event: 'pheromone.rejected',
      nodeId: target.id,
      nodeKind: target.kind,
      pheromoneId,
      traceId,
      ...(extra.forkId === undefined ? {} : { forkId: extra.forkId }),
      ...(extra.branchId === undefined ? {} : { branchId: extra.branchId }),
      queueDepth,
      outcome: 'queue-max',
    });
    throw new QueueFullError(target.id, queueMax, queueDepth);
  }

  private arriveAtMerge(
    node: MergeNode,
    pheromone: Pheromone,
    reservation: OutputReservation,
  ): string {
    // Stage 5D: the current fork is the last lineage tag. The parent lineage is
    // shared by every branch of that fork and becomes the Merge output lineage.
    const lineage = currentLineage(pheromone);
    const current = currentTag(lineage);
    const forkId = current?.forkId;
    const branchId = current?.branchId;
    if (forkId === undefined || branchId === undefined) {
      this.log({
        event: 'merge.failed',
        nodeId: node.id,
        nodeKind: 'merge',
        pheromoneId: pheromone.id,
        traceId: pheromone.traceId,
        outcome: 'invalid-pheromone',
      });
      return 'failed';
    }
    const parentLineage = lineage.slice(0, -1);

    const isRequired = node.config.required.includes(branchId);
    const isOptional = node.config.optional.includes(branchId);
    if (!isRequired && !isOptional) {
      this.failFork(forkId, 'unknown-branch', node);
      return 'failed';
    }

    const state = this.stateOf(node.id);
    // Closed markers are read below; expire the old ones first.
    this.pruneJoinTombstones(node);

    let joins = state.joins;
    if (joins === undefined) {
      joins = new Map<string, JoinState>();
      state.joins = joins;
    }

    const existing = joins.get(forkId);
    if (
      existing !== undefined &&
      !isJoinClosed(existing) &&
      !this.requiredComplete(node, existing) &&
      this.isJoinDue(existing)
    ) {
      // The deadline had already passed before this branch could complete the
      // required set. The join times out instead of emitting; the arrival is
      // then dropped by the closed-tombstone check below.
      this.timeOutJoin(node, forkId);
    }
    if (existing !== undefined && isJoinClosed(existing)) {
      if (isOptional) {
        // Stage 5A/5B: an optional branch that arrives after completion or
        // timeout is dropped; the closed join is never reopened.
        this.log({
          event: 'merge.optional-dropped',
          nodeId: node.id,
          nodeKind: 'merge',
          pheromoneId: pheromone.id,
          traceId: pheromone.traceId,
          forkId,
          branchId,
          outcome: 'late-optional',
        });
        return 'dropped-optional';
      }
      // A required branch cannot legally arrive twice. The join already
      // emitted (or timed out), so this is logged and dropped without a
      // second emit.
      this.log({
        event: 'merge.failed',
        nodeId: node.id,
        nodeKind: 'merge',
        pheromoneId: pheromone.id,
        traceId: pheromone.traceId,
        forkId,
        branchId,
        outcome: 'late-required',
      });
      return 'failed';
    }

    let join = existing;
    if (join === undefined) {
      // Stage 5B: the deadline starts on the first arrival for this forkId and
      // is stored as an absolute instant so it survives a restart unchanged.
      join = {
        forkId,
        ...(parentLineage.length === 0 ? {} : { lineage: copyLineage(parentLineage) }),
        arrived: new Map<string, Pheromone>(),
        deadlineAt: this.now() + node.config.timeoutMs,
      };
      joins.set(forkId, join);
    } else if (!sameLineage(join.lineage ?? [], parentLineage)) {
      // Every branch of one joined fork must come from the same enclosing
      // lineage. A mismatch is corruption, not a new join: fail only this
      // fork and leave the enclosing lineage untouched.
      this.failFork(forkId, 'lineage-mismatch', node);
      return 'failed';
    }
    if (join.arrived.has(branchId)) {
      this.failFork(forkId, 'duplicate-branch', node);
      return 'failed';
    }
    join.arrived.set(branchId, normalizePheromone(pheromone));

    const missing = node.config.required.filter((required) => !join.arrived.has(required));
    if (missing.length > 0) {
      this.log({
        event: 'merge.waiting',
        nodeId: node.id,
        nodeKind: 'merge',
        pheromoneId: pheromone.id,
        traceId: pheromone.traceId,
        forkId,
        branchId,
        outcome: 'waiting',
      });
      return 'waiting';
    }

    const ordered: Pheromone[] = [];
    for (const required of node.config.required) {
      const arrived = join.arrived.get(required);
      if (arrived === undefined) {
        throw new Error(`merge '${node.id}' lost required branch '${required}'`);
      }
      ordered.push(arrived);
    }
    // Only optional branches that already arrived contribute, in the optional
    // config order. A missing optional never blocks the required set.
    for (const optional of node.config.optional) {
      const arrived = join.arrived.get(optional);
      if (arrived !== undefined) {
        ordered.push(arrived);
      }
    }

    // The join is complete, but its output has nowhere to go yet. Keep the
    // joined branches and the open join exactly as they are: clearing them or
    // writing the completed tombstone here would lose the merged output. A
    // later pump settles the join once the downstream queue has room.
    const mergeEdge = this.definition.edges.find((edge) => edge.from === node.id);
    if (mergeEdge !== undefined && (reservation.slots.get(mergeEdge.to) ?? 0) === 0) {
      this.log({
        event: 'merge.blocked',
        nodeId: node.id,
        nodeKind: 'merge',
        pheromoneId: pheromone.id,
        traceId: pheromone.traceId,
        forkId,
        queueDepth: this.queueDepthOf(mergeEdge.to),
        outcome: 'queue-max',
      });
      return 'blocked';
    }

    // The consumed Pheromones are released, and the join becomes a persisted
    // tombstone so a later branch arrival can be dropped.
    join.arrived.clear();
    delete join.deadlineAt;
    join.completedAt = this.iso();
    this.pruneJoinTombstones(node);

    this.finishMerge(node, ordered, pheromone.traceId, parentLineage, reservation);
    return 'merged';
  }

  /**
   * A restored (or previously blocked) join can already be complete; finish it
   * once without replaying the branches that produced it. The downstream queue
   * is checked before the join is cleared, so a full target defers the merge
   * rather than losing the joined output.
   */
  private settleCompleteJoins(): 'settled' | 'blocked' | 'none' {
    let blockedAny = false;
    for (const node of this.definition.nodes.values()) {
      if (node.kind !== 'merge') {
        continue;
      }
      const state = this.stateOf(node.id);
      const joins = state.joins;
      if (joins === undefined) {
        continue;
      }

      for (const forkId of [...joins.keys()]) {
        const join = joins.get(forkId);
        if (join === undefined || isJoinClosed(join)) {
          continue;
        }
        const ordered: Pheromone[] = [];
        for (const required of node.config.required) {
          const arrived = join.arrived.get(required);
          if (arrived === undefined) {
            break;
          }
          ordered.push(arrived);
        }
        if (ordered.length !== node.config.required.length) {
          continue;
        }
        // A restored join can also hold arrived optional branches; include them
        // in the optional config order before the single settle.
        for (const optional of node.config.optional) {
          const arrived = join.arrived.get(optional);
          if (arrived !== undefined) {
            ordered.push(arrived);
          }
        }

        const reserved = this.reserveMergeOutput(node);
        if (!reserved.ok) {
          blockedAny = true;
          this.logMergeBlocked(node, forkId, reserved.target, reserved.queueDepth);
          continue;
        }

        try {
          join.arrived.clear();
          delete join.deadlineAt;
          join.completedAt = this.iso();
          this.pruneJoinTombstones(node);
          const first = ordered[0];
          if (first !== undefined) {
            this.finishMerge(
              node,
              ordered,
              first.traceId,
              join.lineage ?? [],
              reserved.reservation,
            );
          }
        } finally {
          this.releaseReservation(reserved.reservation);
        }
        return 'settled';
      }
    }
    return blockedAny ? 'blocked' : 'none';
  }

  /** True when every required branch of this join has already arrived. */
  private requiredComplete(node: MergeNode, join: JoinState): boolean {
    return node.config.required.every((required) => join.arrived.has(required));
  }

  /** True when an incomplete join's absolute deadline has been reached. */
  private isJoinDue(join: JoinState): boolean {
    return join.deadlineAt !== undefined && this.now() >= join.deadlineAt;
  }

  /**
   * Closes one incomplete join as timed out and fails its fork.
   *
   * The tombstone is written before `failFork` so the fork keeps a reason not
   * to reopen: a late branch is dropped instead of arming a new deadline, and
   * a second emit is impossible. Queue/pending/hover siblings are cancelled;
   * an active sibling cannot be cancelled and is left to finish.
   */
  private timeOutJoin(node: MergeNode, forkId: string): void {
    const join = this.stateOf(node.id).joins?.get(forkId);
    if (join === undefined || isJoinClosed(join)) {
      return;
    }
    this.closeJoinAsTimedOut(node, join);
    this.failFork(forkId, 'timed-out', node);
  }

  /** Writes the timed-out tombstone shape for one incomplete join. */
  private closeJoinAsTimedOut(node: MergeNode, join: JoinState): void {
    join.arrived.clear();
    delete join.deadlineAt;
    join.timedOutAt = this.iso();
    this.pruneJoinTombstones(node);
    this.log({
      event: 'merge.timed-out',
      nodeId: node.id,
      nodeKind: 'merge',
      forkId: join.forkId,
      outcome: 'timed-out',
    });
  }

  /**
   * Fails every incomplete join whose deadline has been reached. A join whose
   * required set is already complete is left for `settleCompleteJoins`: the
   * branches had arrived, so there is nothing left to time out.
   */
  private expireDueJoins(): boolean {
    const dueForks = new Set<string>();
    for (const node of this.definition.nodes.values()) {
      if (node.kind !== 'merge') {
        continue;
      }
      const joins = this.stateOf(node.id).joins;
      if (joins === undefined) {
        continue;
      }
      for (const [forkId, join] of joins) {
        if (isJoinClosed(join) || !this.isJoinDue(join)) {
          continue;
        }
        if (this.requiredComplete(node, join)) {
          continue;
        }
        this.closeJoinAsTimedOut(node, join);
        dueForks.add(forkId);
      }
    }

    // Fail each fork once, after every affected merge has its tombstone, so a
    // second join on another merge node is not removed before it is recorded.
    for (const forkId of dueForks) {
      this.failFork(forkId, 'timed-out');
    }
    return dueForks.size > 0;
  }

  /** Fail joins whose remaining required branches are nowhere in the field. */
  private failMissingJoins(): void {
    const waiting: { node: MergeNode; forkId: string }[] = [];
    for (const node of this.definition.nodes.values()) {
      if (node.kind !== 'merge') {
        continue;
      }
      const state = this.stateOf(node.id);
      if (state.joins === undefined) {
        continue;
      }
      for (const [forkId, join] of state.joins) {
        // Closed tombstones are not waiting on anything.
        if (isJoinClosed(join)) {
          continue;
        }
        // A join whose required set already arrived is complete, not missing:
        // it is only waiting for downstream queue space and must never time out.
        if (this.requiredComplete(node, join)) {
          continue;
        }
        // Stage 5B: a join with time left is never failed early, even when the
        // missing branch is nowhere in the field. It fails only once its
        // deadline is reached (handled above) or when a legacy incomplete join
        // has no deadline at all.
        if (join.deadlineAt !== undefined && this.now() < join.deadlineAt) {
          continue;
        }
        waiting.push({ node, forkId });
      }
    }

    for (const { node, forkId } of waiting) {
      const state = this.stateOf(node.id);
      if (state.joins?.has(forkId) !== true) {
        continue;
      }
      if (this.hasInFlight(forkId)) {
        continue;
      }
      this.failFork(forkId, 'missing-branch', node);
    }
  }

  private hasInFlight(forkId: string): boolean {
    for (const state of this.states.values()) {
      if (state.pending?.forkId === forkId) {
        return true;
      }
      if (state.active?.forkId === forkId) {
        return true;
      }
      if (state.hoverPheromone?.forkId === forkId) {
        return true;
      }
      if ((state.queue ?? []).some((pheromone) => pheromone.forkId === forkId)) {
        return true;
      }
    }
    return false;
  }

  private finishMerge(
    node: MergeNode,
    arrived: readonly Pheromone[],
    traceId: string,
    parentLineage: readonly BranchTag[],
    reservation: OutputReservation,
  ): void {
    const value = combineMergeValues(node.config.combine, arrived);
    const first = arrived[0];
    this.log({
      event: 'merge.completed',
      nodeId: node.id,
      nodeKind: 'merge',
      ...(first === undefined ? {} : { pheromoneId: first.id }),
      traceId,
      outcome: 'merged',
    });

    const edge = this.definition.edges.find(
      (candidate) => candidate.from === node.id && candidate.when === undefined,
    );
    if (edge === undefined) {
      return;
    }
    // Stage 5D: a top-level Merge emits no tags; a nested Merge restores the
    // parent lineage so the enclosing Merge can still group its branch.
    this.pushPheromone(
      edge.to,
      traceId,
      value,
      parentLineage.length === 0 ? undefined : parentLineage,
      reservation,
    );
  }

  /**
   * A branch failure makes its fork unable to complete. Cancel siblings in
   * queues, pending slots and hovers, drop every incomplete join for that
   * forkId, and log the affected merges. Closed tombstones are kept so a late
   * branch can never reopen a join that already finished or timed out. Running
   * side effects are never cancelled or replayed.
   */
  private failFork(forkId: string, reason: string, source?: NodeDefinition): void {
    const affected = new Set<NodeId>();

    for (const [id, state] of this.states) {
      const node = this.definition.nodes.get(id);
      if (node === undefined) {
        continue;
      }
      dropForkFromMailbox(state, forkId);
      if (state.pending?.forkId === forkId) {
        delete state.pending;
      }
      if (state.hoverPheromone?.forkId === forkId) {
        const hover = state.hover;
        const pheromone = state.hoverPheromone;
        delete state.hover;
        delete state.hoverPheromone;
        this.log({
          event: 'hover.cancelled',
          nodeId: id,
          nodeKind: node.kind,
          pheromoneId: hover?.pheromoneId ?? pheromone.id,
          traceId: pheromone.traceId,
          outcome: reason,
        });
      }
      const joins = state.joins;
      if (joins?.has(forkId) === true) {
        const join = joins.get(forkId);
        // A closed tombstone is the only record that this forkId already
        // emitted (or timed out). Keep it: deleting it would let a late active
        // sibling reopen the join and emit a second time.
        if (join === undefined || !isJoinClosed(join)) {
          joins.delete(forkId);
          if (joins.size === 0) {
            delete state.joins;
          }
        }
        affected.add(id);
      }
    }

    for (const id of affected) {
      const node = this.definition.nodes.get(id);
      if (node?.kind === 'merge') {
        this.logMergeFailed(node, forkId, reason);
      }
    }
    if (source?.kind === 'merge' && !affected.has(source.id)) {
      this.logMergeFailed(source, forkId, reason);
    }
  }

  private logMergeFailed(node: MergeNode, forkId: string, reason: string): void {    this.log({
      event: 'merge.failed',
      nodeId: node.id,
      nodeKind: 'merge',
      forkId,
      outcome: reason,
    });
  }

  /**
   * A branch that can never arrive (a failed node, or unknown active work on
   * restore) fails its fork unless every merge that names it treats it as
   * optional. An optional-only failure is logged and never fails the required
   * set.
   */
  private handleBranchFailure(
    forkId: string,
    branchId: string | undefined,
    reason: string,
  ): 'required' | 'optional' {
    if (branchId !== undefined && !this.isRequiredBranch(branchId)) {
      const optionalMerges = this.optionalMergesForBranch(branchId);
      if (optionalMerges.length > 0) {
        for (const node of optionalMerges) {
          this.log({
            event: 'merge.optional-failed',
            nodeId: node.id,
            nodeKind: 'merge',
            forkId,
            branchId,
            outcome: reason,
          });
        }
        return 'optional';
      }
    }

    this.failFork(forkId, reason);
    return 'required';
  }

  private isRequiredBranch(branchId: string): boolean {
    for (const node of this.definition.nodes.values()) {
      if (node.kind === 'merge' && node.config.required.includes(branchId)) {
        return true;
      }
    }
    return false;
  }

  private optionalMergesForBranch(branchId: string): MergeNode[] {
    const merges: MergeNode[] = [];
    for (const node of this.definition.nodes.values()) {
      if (node.kind === 'merge' && node.config.optional.includes(branchId)) {
        merges.push(node);
      }
    }
    return merges;
  }

  /**
   * Bounds closed-join tombstones so they cannot grow forever: a marker older
   * than COMPLETED_JOIN_TTL_MS is forgotten, and only the newest
   * MAX_COMPLETED_JOINS_PER_MERGE markers are kept. Completed (5A) and
   * timed-out (5B) tombstones share the same bound. After that bound a branch
   * that is extremely late is no longer distinguishable from a fresh join.
   */
  private pruneJoinTombstones(node: MergeNode): void {
    const state = this.stateOf(node.id);
    const joins = state.joins;
    if (joins === undefined) {
      return;
    }

    const now = this.now();
    const closed: { forkId: string; closedAt: string }[] = [];
    for (const [forkId, join] of joins) {
      if (!isJoinClosed(join)) {
        continue;
      }
      const closedAt = join.completedAt ?? join.timedOutAt;
      if (closedAt === undefined) {
        continue;
      }
      const at = Date.parse(closedAt);
      if (!Number.isFinite(at) || now - at > COMPLETED_JOIN_TTL_MS) {
        joins.delete(forkId);
      } else {
        closed.push({ forkId, closedAt });
      }
    }

    const excess = closed.length - MAX_COMPLETED_JOINS_PER_MERGE;
    if (excess > 0) {
      closed.sort((left, right) => left.closedAt.localeCompare(right.closedAt));
      for (const entry of closed.slice(0, excess)) {
        joins.delete(entry.forkId);
      }
    }

    if (joins.size === 0) {
      delete state.joins;
    }
  }

  private restoreJoinLineage(input: unknown, path: string): BranchTag[] | undefined {
    if (input === undefined) {
      return undefined;
    }
    if (!Array.isArray(input) || input.length === 0) {
      throw new FieldRestoreError(`${path} lineage: expected a non-empty array`);
    }
    return input.map((entry, index) => {
      if (typeof entry !== 'object' || entry === null) {
        throw new FieldRestoreError(`${path} lineage[${String(index)}]: expected a branch tag`);
      }
      const forkId = (entry as { forkId?: unknown }).forkId;
      const branchId = (entry as { branchId?: unknown }).branchId;
      if (typeof forkId !== 'string' || forkId === '') {
        throw new FieldRestoreError(
          `${path} lineage[${String(index)}].forkId: expected a non-empty string`,
        );
      }
      if (typeof branchId !== 'string' || branchId === '') {
        throw new FieldRestoreError(
          `${path} lineage[${String(index)}].branchId: expected a non-empty string`,
        );
      }
      return { forkId, branchId };
    });
  }

  private restoreJoins(
    node: MergeNode,
    saved: Record<string, PersistedJoinState>,
  ): Map<string, JoinState> {
    const joins = new Map<string, JoinState>();
    for (const [forkId, entry] of Object.entries(saved)) {
      const joinPath = `persisted join '${forkId}' on node '${node.id}'`;
      if (forkId === '') {
        throw new FieldRestoreError(`persisted join on node '${node.id}' has an empty forkId`);
      }
      if (!Array.isArray(entry.arrived)) {
        throw new FieldRestoreError(
          `${joinPath} has no branch Pheromones`,
        );
      }
      const parentLineage = this.restoreJoinLineage(entry.lineage, joinPath);
      if (entry.completedAt !== undefined && entry.timedOutAt !== undefined) {
        throw new FieldRestoreError(
          `${joinPath} is both completed and timed out`,
        );
      }
      if (entry.completedAt !== undefined) {
        // A completed tombstone holds no Pheromones; it only remembers that the
        // join already emitted so a later branch can be dropped.
        if (
          typeof entry.completedAt !== 'string' ||
          !Number.isFinite(Date.parse(entry.completedAt))
        ) {
          throw new FieldRestoreError(`${joinPath} has an invalid completedAt`);
        }
        if (entry.arrived.length > 0) {
          throw new FieldRestoreError(
            `persisted completed join '${forkId}' on node '${node.id}' still holds branch Pheromones`,
          );
        }
        joins.set(forkId, {
          forkId,
          ...(parentLineage === undefined ? {} : { lineage: parentLineage }),
          arrived: new Map<string, Pheromone>(),
          completedAt: entry.completedAt,
        });
        continue;
      }
      if (entry.timedOutAt !== undefined) {
        // A timed-out tombstone holds no Pheromones: the fork is failed and
        // late branches must be dropped instead of reopening the join.
        if (
          typeof entry.timedOutAt !== 'string' ||
          !Number.isFinite(Date.parse(entry.timedOutAt))
        ) {
          throw new FieldRestoreError(`${joinPath} has an invalid timedOutAt`);
        }
        if (entry.arrived.length > 0) {
          throw new FieldRestoreError(
            `persisted timed-out join '${forkId}' on node '${node.id}' still holds branch Pheromones`,
          );
        }
        joins.set(forkId, {
          forkId,
          ...(parentLineage === undefined ? {} : { lineage: parentLineage }),
          arrived: new Map<string, Pheromone>(),
          timedOutAt: entry.timedOutAt,
        });
        continue;
      }
      if (entry.arrived.length === 0) {
        throw new FieldRestoreError(
          `${joinPath} has no branch Pheromones`,
        );
      }
      if (entry.deadlineAt === undefined || !Number.isSafeInteger(entry.deadlineAt)) {
        throw new FieldRestoreError(`${joinPath} has no valid deadlineAt`);
      }

      const arrived = new Map<string, Pheromone>();
      let derivedParent: BranchTag[] | undefined;
      for (const pheromone of entry.arrived) {
        const normalized = normalizePheromone(pheromone);
        if (normalized.forkId !== forkId) {
          throw new FieldRestoreError(
            `persisted join '${forkId}' on node '${node.id}' holds a Pheromone for '${String(normalized.forkId)}'`,
          );
        }
        const branchId = normalized.branchId;
        if (branchId === undefined) {
          throw new FieldRestoreError(
            `persisted join '${forkId}' on node '${node.id}' holds an untagged Pheromone`,
          );
        }
        if (
          !node.config.required.includes(branchId) &&
          !node.config.optional.includes(branchId)
        ) {
          throw new FieldRestoreError(
            `persisted join '${forkId}' on node '${node.id}' holds unknown branch '${branchId}'`,
          );
        }
        if (arrived.has(branchId)) {
          throw new FieldRestoreError(
            `persisted join '${forkId}' on node '${node.id}' repeats branch '${branchId}'`,
          );
        }
        const lineage = currentLineage(normalized);
        const parent = copyLineage(lineage.slice(0, -1));
        if (derivedParent === undefined) {
          derivedParent = parent;
        } else if (!sameLineage(derivedParent, parent)) {
          throw new FieldRestoreError(
            `persisted join '${forkId}' on node '${node.id}' mixes parent lineages`,
          );
        }
        arrived.set(branchId, normalized);
      }
      const effectiveParent = derivedParent ?? [];
      if (parentLineage !== undefined && !sameLineage(parentLineage, effectiveParent)) {
        throw new FieldRestoreError(
          `${joinPath} lineage does not match its branch Pheromones`,
        );
      }
      joins.set(forkId, {
        forkId,
        ...(effectiveParent.length === 0
          ? {}
          : { lineage: copyLineage(effectiveParent) }),
        arrived,
        deadlineAt: entry.deadlineAt,
      });
    }
    return joins;
  }

  private outgoingEdge(node: NodeDefinition, result: NodeResult): EdgeDefinition | undefined {
    if (node.kind === 'condition' || node.kind === 'counter') {
      const branch: EdgeWhen | undefined = result.branch;
      return this.definition.edges.find((edge) => edge.from === node.id && edge.when === branch);
    }
    return this.definition.edges.find((edge) => edge.from === node.id);
  }

  private refreshRest(): void {
    const resting = isFieldResting(this.states.values());
    if (resting && !this.resting) {
      this.resting = true;
      this.log({ event: 'runtime.rest' });
    } else if (!resting) {
      this.resting = false;
    }
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  private log(entry: Omit<RuntimeLogEntry, 'at' | 'compositionId' | 'graphRevision'>): void {
    if (this.onLog === undefined) {
      return;
    }
    this.onLog({
      at: this.iso(),
      compositionId: this.definition.id,
      graphRevision: this.definition.graphRevision,
      ...entry,
    });
  }
}
