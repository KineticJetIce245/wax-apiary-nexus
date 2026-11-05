import { randomUUID } from 'node:crypto';

import {
  serializeValue,
  type ExecutionContext,
  type GuardDecision,
  type GuardRequest,
  type NodeExecutor,
} from './executor.js';
import { clonePheromone, createNodeState, isFieldResting, snapshotField } from './field.js';
import type { RuntimeLogEntry, RuntimeLogSink } from './log.js';
import {
  runWorker,
  workerExitError,
  WorkerExecutionError,
  type WorkerResult,
} from './worker.js';
import type {
  CompositionDefinition,
  ConditionConfig,
  EdgeDefinition,
  EdgeWhen,
  ForkNode,
  HoverSpec,
  JoinState,
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
}

const DEFAULT_GUARD_TIMEOUT_MS = 3_600_000;

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

const VALUE_KINDS = ['text', 'choice', 'boolean', 'message', 'attachments'] as const;

function assertValue(value: unknown): asserts value is Value {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('value must be an object');
  }
  const kind = (value as { kind?: unknown }).kind;
  if (typeof kind !== 'string' || !(VALUE_KINDS as readonly string[]).includes(kind)) {
    throw new TypeError(`value.kind must be one of ${VALUE_KINDS.join(', ')}`);
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
  private readonly guardWaiters = new Map<string, { readonly requestId: string; resolve: (decision: GuardDecision) => void }>();
  private readonly states: Map<NodeId, NodeState> = new Map();
  /** Answers that arrived before their user node hovered; preserved, not dropped. */
  private readonly preAnswers = new Map<NodeId, Value[]>();
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
      at: this.iso(),
    };

    const state = this.stateOf(node.id);
    state.queue.push(pheromone);
    this.resting = false;
    this.log({
      event: 'pheromone.enqueued',
      nodeId: node.id,
      nodeKind: node.kind,
      pheromoneId: pheromone.id,
      traceId: pheromone.traceId,
      queueDepth: state.queue.length,
    });

    return pheromone.id;
  }

  /** Activates every runnable node until the field is quiet. */
  async pump(): Promise<void> {
    try {
      for (;;) {
        const next = this.takeRunnable();
        if (next === null) {
          // A restored join can already hold every required branch; finish it
          // without replaying any of those branches.
          if (this.settleCompleteJoins()) {
            continue;
          }
          // Quiet and still waiting for a branch that is nowhere in the field:
          // that branch can never arrive, so the merge fails instead of
          // leaving the field permanently non-Rest.
          this.failMissingJoins();
          break;
        }
        await this.activate(next.node, next.pheromone);
      }
    } finally {
      // A failed activation still changes the field (active is cleared), so
      // Rest must be recomputed before the error leaves pump().
      this.refreshRest();
    }
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
    this.assertUserValue(node, value);

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
      const persisted: PersistedNodeState = { queue: state.queue.map(clonePheromone) };
      if (state.pending !== undefined) {
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
            { arrived: [...join.arrived.values()].map(clonePheromone) },
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
    /** A branch whose process is gone can never reach its Merge; fail the fork. */
    const failedForkIds = new Set<string>();

    for (const [id, node] of this.definition.nodes) {
      const saved = field.nodes[id];
      if (saved === undefined) {
        continue;
      }
      const state = this.stateOf(id);
      state.queue = saved.queue.map(clonePheromone);
      if (saved.pending !== undefined) {
        state.pending = clonePheromone(saved.pending);
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
        }
      }

      if (
        saved.hover !== undefined &&
        saved.hover.kind === 'user' &&
        saved.hoverPheromone !== undefined
      ) {
        state.hover = structuredClone(saved.hover);
        state.hoverPheromone = clonePheromone(saved.hoverPheromone);
        resumedHovers.push(id);
      } else if (saved.hover !== undefined) {
        // A Guard cannot be answered after the native request is gone: it is
        // cancelled, never resumed and never auto-allowed.
        stuckActive.push(id);
        state.state = { ...(state.state ?? {}), needsAttention: true };
        if (saved.hoverPheromone?.forkId !== undefined) {
          failedForkIds.add(saved.hoverPheromone.forkId);
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
        if (saved.active.forkId !== undefined) {
          failedForkIds.add(saved.active.forkId);
        }
      }
    }

    for (const forkId of failedForkIds) {
      this.failFork(forkId, 'unknown-active');
    }

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

  private takeRunnable(): { node: NodeDefinition; pheromone: Pheromone } | null {
    const now = this.now();

    for (const node of this.definition.nodes.values()) {
      const state = this.stateOf(node.id);
      if (state.active !== undefined || state.hover !== undefined) {
        continue;
      }

      const dueAt =
        state.lastActivatedAt === undefined
          ? Number.NEGATIVE_INFINITY
          : Date.parse(state.lastActivatedAt) + node.minIntervalMs;

      if (state.pending === undefined && state.queue.length > 0) {
        const head = state.queue.shift();
        if (head === undefined) {
          continue;
        }
        state.pending = head;
        if (now < dueAt) {
          this.log({
            event: 'pheromone.pending',
            nodeId: node.id,
            nodeKind: node.kind,
            pheromoneId: head.id,
            traceId: head.traceId,
            queueDepth: state.queue.length,
          });
        }
      }

      if (state.pending !== undefined && now >= dueAt) {
        const pheromone = state.pending;
        delete state.pending;
        return { node, pheromone };
      }
    }

    return null;
  }

  private async activate(node: NodeDefinition, pheromone: Pheromone): Promise<void> {
    const state = this.stateOf(node.id);
    state.lastActivatedAt = this.iso();
    this.resting = false;

    if (node.kind === 'user') {
      this.logActivated(node, pheromone, state);
      this.openHover(node, pheromone);
      return;
    }

    state.active = pheromone;
    const startedAt = this.now();
    this.logActivated(node, pheromone, state);

    try {
      if (node.kind === 'fork') {
        this.emitFork(node, pheromone);
        this.logCompleted(node, pheromone, startedAt, 'forked');
      } else if (node.kind === 'merge') {
        const outcome = this.arriveAtMerge(node, pheromone);
        this.logCompleted(node, pheromone, startedAt, outcome);
      } else {
        const result = await this.runNode(node, pheromone, state);
        this.logCompleted(node, pheromone, startedAt, result.outcome, result.log);
        this.emit(node, pheromone, result);
      }
    } catch (error) {
      delete state.active;
      this.logFailed(node, pheromone, startedAt, error);
      if (pheromone.forkId !== undefined) {
        // A branch that failed can never reach its Merge. Cancel its siblings
        // so no join waits forever.
        this.failFork(pheromone.forkId, 'failed-branch');
      }
      throw error;
    }

    delete state.active;
  }

  private logActivated(node: NodeDefinition, pheromone: Pheromone, state: NodeState): void {
    this.log({
      event: 'node.activated',
      nodeId: node.id,
      nodeKind: node.kind,
      pheromoneId: pheromone.id,
      traceId: pheromone.traceId,
      queueDepth: state.queue.length,
      ...(pheromone.forkId === undefined ? {} : { forkId: pheromone.forkId }),
      ...(pheromone.branchId === undefined ? {} : { branchId: pheromone.branchId }),
    });
  }

  private logCompleted(
    node: NodeDefinition,
    pheromone: Pheromone,
    startedAt: number,
    outcome: string,
    extra?: Partial<RuntimeLogEntry>,
  ): void {
    this.log({
      event: 'node.completed',
      nodeId: node.id,
      nodeKind: node.kind,
      pheromoneId: pheromone.id,
      traceId: pheromone.traceId,
      outcome,
      durationMs: this.now() - startedAt,
      ...(extra ?? {}),
    });
  }

  private logFailed(
    node: NodeDefinition,
    pheromone: Pheromone,
    startedAt: number,
    error: unknown,
  ): void {
    this.log({
      event: 'node.failed',
      nodeId: node.id,
      nodeKind: node.kind,
      pheromoneId: pheromone.id,
      traceId: pheromone.traceId,
      outcome: 'failed',
      durationMs: this.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      ...(error instanceof WorkerExecutionError ? workerLogFields(error) : {}),
    });
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

  private openHover(node: UserNode, pheromone: Pheromone): void {
    const state = this.stateOf(node.id);
    const queued = this.preAnswers.get(node.id);
    const early = queued?.shift();
    if (queued !== undefined && queued.length === 0) {
      this.preAnswers.delete(node.id);
    }

    if (early !== undefined) {
      this.completeHover(node, pheromone, early, 'early-input');
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

  private completeHover(node: UserNode, pheromone: Pheromone, value: Value, outcome: string): void {
    const state = this.stateOf(node.id);
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
    this.emit(node, pheromone, { value: structuredClone(value), outcome });
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
      resolveWaiter('cancelled');
    }, this.guardTimeoutMs);
    timer.unref();

    const handler = decide ?? this.onGuard;
    const decisionPromise =
      handler === undefined
        ? Promise.resolve<GuardDecision>('reject_once')
        : Promise.resolve()
            .then(() => handler(request))
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

  private assertUserValue(node: UserNode, value: Value): void {
    if (node.config.modality === 'text') {
      if (value.kind !== 'text') {
        throw new TypeError(`user node '${node.id}' expects a text value, got '${value.kind}'`);
      }
      return;
    }
    if (node.config.modality === 'yes-no') {
      if (value.kind !== 'boolean') {
        throw new TypeError(`user node '${node.id}' expects a boolean value, got '${value.kind}'`);
      }
      return;
    }

    if (value.kind !== 'choice') {
      throw new TypeError(`user node '${node.id}' expects a choice value, got '${value.kind}'`);
    }
    const choices = node.config.choices ?? [];
    if (!choices.includes(value.choice)) {
      throw new TypeError(
        `user node '${node.id}' does not offer choice '${value.choice}' (${choices.join(', ')})`,
      );
    }
  }

  private emit(node: NodeDefinition, pheromone: Pheromone, result: NodeResult): void {
    const edge = this.outgoingEdge(node, result);
    if (edge === undefined) {
      return;
    }

    // A branch keeps its forkId/branchId through normal nodes so a downstream
    // Merge can still group it. A Merge output deliberately drops both tags.
    this.pushPheromone(edge.to, pheromone.traceId, result.value, branchTags(pheromone));
  }

  /** Fork consumes one Pheromone and emits one tagged copy per branch. */
  private emitFork(node: ForkNode, pheromone: Pheromone): void {
    const forkId = `fk_${randomUUID()}`;
    for (const branch of node.config.branches) {
      this.pushPheromone(branch.to, pheromone.traceId, pheromone.value, {
        forkId,
        branchId: branch.id,
      });
    }
  }

  private pushPheromone(
    targetId: NodeId,
    traceId: string,
    value: Value,
    tags?: { forkId: string; branchId: string },
  ): void {
    const targetNode = this.definition.nodes.get(targetId);
    if (targetNode === undefined) {
      throw new Error(`unknown edge target '${targetId}'`);
    }

    const targetState = this.stateOf(targetId);
    const emitted: Pheromone = {
      id: newPheromoneId(),
      traceId,
      value: structuredClone(value),
      at: this.iso(),
      ...(tags ?? {}),
    };
    targetState.queue.push(emitted);
    this.resting = false;

    this.log({
      event: 'pheromone.emitted',
      nodeId: targetNode.id,
      nodeKind: targetNode.kind,
      pheromoneId: emitted.id,
      traceId: emitted.traceId,
      ...(tags ?? {}),
      queueDepth: targetState.queue.length,
    });
  }

  private arriveAtMerge(node: MergeNode, pheromone: Pheromone): string {
    const forkId = pheromone.forkId;
    const branchId = pheromone.branchId;
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

    if (!node.config.required.includes(branchId)) {
      this.failFork(forkId, 'unknown-branch', node);
      return 'failed';
    }

    const state = this.stateOf(node.id);
    let joins = state.joins;
    if (joins === undefined) {
      joins = new Map<string, JoinState>();
      state.joins = joins;
    }

    let join = joins.get(forkId);
    if (join === undefined) {
      join = { forkId, arrived: new Map<string, Pheromone>() };
      joins.set(forkId, join);
    }
    if (join.arrived.has(branchId)) {
      this.failFork(forkId, 'duplicate-branch', node);
      return 'failed';
    }
    join.arrived.set(branchId, clonePheromone(pheromone));

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
    joins.delete(forkId);
    if (joins.size === 0) {
      delete state.joins;
    }

    this.finishMerge(node, ordered, pheromone.traceId);
    return 'merged';
  }

  /**
   * A restored join can already be complete; finish it once without replaying
   * the branches that produced it.
   */
  private settleCompleteJoins(): boolean {
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
        if (join === undefined) {
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
        joins.delete(forkId);
        if (joins.size === 0) {
          delete state.joins;
        }
        const first = ordered[0];
        if (first !== undefined) {
          this.finishMerge(node, ordered, first.traceId);
        }
        return true;
      }
    }
    return false;
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
      for (const forkId of state.joins.keys()) {
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
      if (state.queue.some((pheromone) => pheromone.forkId === forkId)) {
        return true;
      }
    }
    return false;
  }

  private finishMerge(node: MergeNode, arrived: readonly Pheromone[], traceId: string): void {
    const text = arrived.map((pheromone) => serializeValue(pheromone.value)).join('\n');
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
    this.pushPheromone(edge.to, traceId, { kind: 'text', text });
  }

  /**
   * A branch failure makes its fork unable to complete. Cancel siblings in
   * queues, pending slots and hovers, drop every join for that forkId, and log
   * the affected merges. Running side effects are never cancelled or replayed.
   */
  private failFork(forkId: string, reason: string, source?: NodeDefinition): void {
    const affected = new Set<NodeId>();

    for (const [id, state] of this.states) {
      const node = this.definition.nodes.get(id);
      if (node === undefined) {
        continue;
      }
      if (state.queue.some((pheromone) => pheromone.forkId === forkId)) {
        state.queue = state.queue.filter((pheromone) => pheromone.forkId !== forkId);
      }
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
        joins.delete(forkId);
        if (joins.size === 0) {
          delete state.joins;
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

  private logMergeFailed(node: MergeNode, forkId: string, reason: string): void {
    this.log({
      event: 'merge.failed',
      nodeId: node.id,
      nodeKind: 'merge',
      forkId,
      outcome: reason,
    });
  }

  private restoreJoins(
    node: MergeNode,
    saved: Record<string, PersistedJoinState>,
  ): Map<string, JoinState> {
    const joins = new Map<string, JoinState>();
    for (const [forkId, entry] of Object.entries(saved)) {
      if (forkId === '') {
        throw new FieldRestoreError(`persisted join on node '${node.id}' has an empty forkId`);
      }
      if (!Array.isArray(entry.arrived) || entry.arrived.length === 0) {
        throw new FieldRestoreError(
          `persisted join '${forkId}' on node '${node.id}' has no branch Pheromones`,
        );
      }

      const arrived = new Map<string, Pheromone>();
      for (const pheromone of entry.arrived) {
        if (pheromone.forkId !== forkId) {
          throw new FieldRestoreError(
            `persisted join '${forkId}' on node '${node.id}' holds a Pheromone for '${String(pheromone.forkId)}'`,
          );
        }
        const branchId = pheromone.branchId;
        if (branchId === undefined) {
          throw new FieldRestoreError(
            `persisted join '${forkId}' on node '${node.id}' holds an untagged Pheromone`,
          );
        }
        if (!node.config.required.includes(branchId)) {
          throw new FieldRestoreError(
            `persisted join '${forkId}' on node '${node.id}' holds unknown branch '${branchId}'`,
          );
        }
        if (arrived.has(branchId)) {
          throw new FieldRestoreError(
            `persisted join '${forkId}' on node '${node.id}' repeats branch '${branchId}'`,
          );
        }
        arrived.set(branchId, clonePheromone(pheromone));
      }
      joins.set(forkId, { forkId, arrived });
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

function branchTags(
  pheromone: Pheromone,
): { forkId: string; branchId: string } | undefined {
  if (pheromone.forkId === undefined || pheromone.branchId === undefined) {
    return undefined;
  }
  return { forkId: pheromone.forkId, branchId: pheromone.branchId };
}

/**
 * Worker metadata safe for the composition log: the program name, pid and byte
 * counts only. The output bodies stay in the Value (stdout) or the error
 * (stderr), never in the log.
 */
function workerLogFields(
  worker: WorkerResult | WorkerExecutionError,
): Partial<RuntimeLogEntry> {
  return {
    program: worker.program,
    ...(worker.pid === undefined ? {} : { pid: worker.pid }),
    stdoutBytes: worker.stdoutBytes,
    stderrBytes: worker.stderrBytes,
    ...(worker.exitCode === undefined ? {} : { exitCode: worker.exitCode }),
  };
}

function evaluateCondition(
  config: Exclude<ConditionConfig, { mode: 'worker' }>,
  value: Value,
): 'true' | 'false' {
  if (config.mode === 'boolean') {
    if (value.kind !== 'boolean') {
      throw new Error(`condition 'boolean' expects a boolean value, got '${value.kind}'`);
    }
    return value.value ? 'true' : 'false';
  }

  if (config.mode === 'choice') {
    if (value.kind !== 'choice') {
      throw new Error(`condition 'choice' expects a choice value, got '${value.kind}'`);
    }
    return value.choice === config.choice ? 'true' : 'false';
  }

  const text = serializeValue(value);
  if (config.contains !== undefined) {
    return text.includes(config.contains) ? 'true' : 'false';
  }
  if (config.equals !== undefined) {
    return text === config.equals ? 'true' : 'false';
  }
  throw new Error('condition text mode needs contains or equals');
}
