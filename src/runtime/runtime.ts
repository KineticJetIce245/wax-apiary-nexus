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
import type {
  CompositionDefinition,
  ConditionConfig,
  EdgeDefinition,
  EdgeWhen,
  HoverSpec,
  NodeDefinition,
  NodeId,
  NodeState,
  PersistedField,
  PersistedNodeState,
  Pheromone,
  PheromoneFieldSnapshot,
  RecoveryReport,
  UserNode,
  Value,
} from './types.js';

export interface RuntimeOptions {
  executeForager: NodeExecutor;
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
 * Single-Pheromone runtime slice.
 *
 * One Pheromone is consumed by one node; the node produces at most one
 * Pheromone on its single outgoing edge; a node without an outgoing edge is
 * terminal. No cursor, no Run, no fork/merge.
 */
export class PheromoneRuntime {
  private readonly definition: CompositionDefinition;
  private readonly executor: NodeExecutor;
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
    if (node.kind !== 'forager' && node.kind !== 'user') {
      throw new Error(
        `trigger target '${nodeId}' must be a forager or user node, got '${node.kind}'`,
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
      }
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
      this.log({
        event: 'node.activated',
        nodeId: node.id,
        nodeKind: node.kind,
        pheromoneId: pheromone.id,
        traceId: pheromone.traceId,
        queueDepth: state.queue.length,
      });
      this.openHover(node, pheromone);
      return;
    }

    state.active = pheromone;
    const startedAt = this.now();

    this.log({
      event: 'node.activated',
      nodeId: node.id,
      nodeKind: node.kind,
      pheromoneId: pheromone.id,
      traceId: pheromone.traceId,
      queueDepth: state.queue.length,
    });

    let result: NodeResult;
    try {
      result = await this.runNode(node, pheromone, state);
    } catch (error) {
      delete state.active;
      this.log({
        event: 'node.failed',
        nodeId: node.id,
        nodeKind: node.kind,
        pheromoneId: pheromone.id,
        traceId: pheromone.traceId,
        outcome: 'failed',
        durationMs: this.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    delete state.active;
    this.log({
      event: 'node.completed',
      nodeId: node.id,
      nodeKind: node.kind,
      pheromoneId: pheromone.id,
      traceId: pheromone.traceId,
      outcome: result.outcome,
      durationMs: this.now() - startedAt,
    });

    this.emit(node, pheromone, result);
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

    if (node.kind === 'condition') {
      const branch = evaluateCondition(node.config, pheromone.value);
      return { value: pheromone.value, outcome: branch, branch };
    }

    if (node.kind === 'user') {
      throw new Error(`user node '${node.id}' waits for input instead of running`);
    }

    const previous = state.state?.['count'];
    const count = (typeof previous === 'number' ? previous : 0) + node.config.step;
    state.state = { ...(state.state ?? {}), count };
    const branch = count >= node.config.max ? 'done' : 'continue';
    return { value: pheromone.value, outcome: branch, branch };
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

    const targetNode = this.definition.nodes.get(edge.to);
    if (targetNode === undefined) {
      throw new Error(`unknown edge target '${edge.to}'`);
    }

    const targetState = this.stateOf(edge.to);
    const emitted: Pheromone = {
      id: newPheromoneId(),
      traceId: pheromone.traceId,
      value: structuredClone(result.value),
      at: this.iso(),
    };
    targetState.queue.push(emitted);
    this.resting = false;

    this.log({
      event: 'pheromone.emitted',
      nodeId: targetNode.id,
      nodeKind: targetNode.kind,
      pheromoneId: emitted.id,
      traceId: emitted.traceId,
      queueDepth: targetState.queue.length,
    });
  }

  private outgoingEdge(node: NodeDefinition, result: NodeResult): EdgeDefinition | undefined {
    if (node.kind === 'forager' || node.kind === 'user') {
      return this.definition.edges.find((edge) => edge.from === node.id);
    }
    const branch: EdgeWhen | undefined = result.branch;
    return this.definition.edges.find((edge) => edge.from === node.id && edge.when === branch);
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

function evaluateCondition(config: ConditionConfig, value: Value): 'true' | 'false' {
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
