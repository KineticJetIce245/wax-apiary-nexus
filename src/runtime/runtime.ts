import { randomUUID } from 'node:crypto';

import { serializeValue, type NodeExecutor } from './executor.js';
import { createNodeState, isFieldResting, snapshotField } from './field.js';
import type { RuntimeLogEntry, RuntimeLogSink } from './log.js';
import type {
  CompositionDefinition,
  ConditionConfig,
  EdgeDefinition,
  EdgeWhen,
  NodeDefinition,
  NodeId,
  NodeState,
  Pheromone,
  PheromoneFieldSnapshot,
  Value,
} from './types.js';

export interface RuntimeOptions {
  executeForager: NodeExecutor;
  /** Injectable clock for tests; defaults to Date.now. */
  now?: () => number;
  onLog?: RuntimeLogSink;
}

interface NodeResult {
  value: Value;
  outcome: string;
  branch?: 'true' | 'false' | 'continue' | 'done';
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
  private readonly states: Map<NodeId, NodeState> = new Map();
  private resting: boolean;

  constructor(definition: CompositionDefinition, options: RuntimeOptions) {
    if (typeof options?.executeForager?.execute !== 'function') {
      throw new TypeError('options.executeForager must implement execute()');
    }

    this.definition = definition;
    this.executor = options.executeForager;
    this.now = options.now ?? Date.now;
    this.onLog = options.onLog;

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
    if (node.kind !== 'forager') {
      throw new Error(`trigger target '${nodeId}' must be a forager node, got '${node.kind}'`);
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
    for (;;) {
      const next = this.takeRunnable();
      if (next === null) {
        break;
      }
      await this.activate(next.node, next.pheromone);
    }
    this.refreshRest();
  }

  /** Immutable view of the PheromoneField. */
  snapshot(): PheromoneFieldSnapshot {
    return snapshotField(this.definition, this.states, this.resting);
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
      if (state.active !== undefined) {
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
    state.active = pheromone;
    state.lastActivatedAt = this.iso();
    const startedAt = this.now();
    this.resting = false;

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
      const output = await this.executor.execute(node, pheromone.value);
      assertValue(output);
      return { value: output, outcome: 'ok' };
    }

    if (node.kind === 'condition') {
      const branch = evaluateCondition(node.config, pheromone.value);
      return { value: pheromone.value, outcome: branch, branch };
    }

    const previous = state.state?.['count'];
    const count = (typeof previous === 'number' ? previous : 0) + node.config.step;
    state.state = { ...(state.state ?? {}), count };
    const branch = count >= node.config.max ? 'done' : 'continue';
    return { value: pheromone.value, outcome: branch, branch };
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
    if (node.kind === 'forager') {
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
