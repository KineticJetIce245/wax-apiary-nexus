import { assertUserValue, assertValue } from './runtime-input.js';
import {
  appendEntry,
  createEntry,
  expireOverdueQueues,
  queueDepth,
  stateOf,
  tryAppendEntry,
  type QueueContext,
} from './queue.js';
import { createNodeState, isFieldResting, snapshotField } from './field.js';
import { applyPersistedField, exportField as exportPersistedField } from './restore.js';
import { completeHover, settleGuard as settleGuardHover } from './hover.js';
import { pumpField, refreshRest, startOtherDrains } from './pump.js';
import {
  ReceptorFullError,
  ReceptorOverflow,
  readReceptorOverflowOptions,
  type ReceptorOverflowPolicy,
} from './receptor-overflow.js';
import { StateLock } from './state-lock.js';
import type { EngineContext, GuardWaiter } from './engine-context.js';
import type {
  CompositionDefinition,
  NodeDefinition,
  NodeId,
  NodeState,
  PersistedField,
  PheromoneFieldSnapshot,
  RecoveryReport,
  Value,
} from './types.js';
import type { GuardDecision, GuardRequest, NodeExecutor } from './executor.js';
import type { RuntimeLogEntry, RuntimeLogFields, RuntimeLogFieldsSink, RuntimeLogSink } from './log.js';

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
  /**
   * What to do when a bee already holds `defaults.queueMax` waiting entries:
   * `reject` (default) fails immediately, `block` waits for receptor capacity.
   */
  receptorOverflowPolicy?: ReceptorOverflowPolicy;
  /** Positive integer; only used by `block`; defaults to 30s. */
  receptorBlockTimeoutMs?: number;
}

const DEFAULT_GUARD_TIMEOUT_MS = 3_600_000;

/** Re-exported so callers that imported it from the runtime keep working. */
export { ReceptorFullError } from './receptor-overflow.js';
export { GuardDecisionError } from './hover.js';

/**
 * PheromoneField runtime.
 *
 * A normal Bee consumes one value and moves the same Pheromone object along its
 * beeline. A Spread creates one new value per target BeeId (clone or cleave); a
 * Gather assembles one package and its execution path is M19d. There is no
 * message identity, branch or join.
 */
export class PheromoneRuntime {
  private readonly engine: EngineContext;
  private readonly definition: CompositionDefinition;
  private readonly onLog: RuntimeLogSink | undefined;

  constructor(definition: CompositionDefinition, options: RuntimeOptions) {
    if (typeof options?.executeForager?.execute !== 'function') {
      throw new TypeError('options.executeForager must implement execute()');
    }
    this.definition = definition;
    this.onLog = options.onLog;
    const guardTimeoutMs = readGuardTimeout(options);
    const states = new Map<NodeId, NodeState>();
    for (const id of definition.nodes.keys()) {
      states.set(id, createNodeState());
    }
    const stateLock = new StateLock();
    const now = options.now ?? Date.now;
    const iso = () => new Date(now()).toISOString();
    const log = (entry: RuntimeLogFields) => this.log(entry);
    let overflow: ReceptorOverflow | undefined;
    const queue: QueueContext = {
      definition,
      states,
      now,
      log,
      notifyOverflow: (nodeId) => overflow?.notify(nodeId),
    };
    overflow = createOverflow(definition, options, stateLock, queue, iso, log);
    this.engine = buildEngine({
      definition,
      options,
      states,
      stateLock,
      queue,
      iso,
      log,
      overflow,
      guardTimeoutMs,
    });
  }

  /**
   * Admission helper for the host: enqueues one Value at the target Bee. Any
   * loaded Bee may be the entry Bee; a control Bee applies its own rules. The
   * call hands the Value to the field and never exposes an identity.
   */
  readonly admit = async (nodeId: NodeId, value: Value): Promise<void> => {
    const node = this.requireNode(nodeId);
    assertValue(value, 'trigger value');
    const admitted = structuredClone(value);
    if (this.engine.receptorOverflow !== undefined) {
      await this.engine.receptorOverflow.admit(node.id, admitted);
      this.engine.resting = false;
      return;
    }
    this.engine.stateLock.runSync(() => {
      appendEntry(
        this.engine.queue,
        node.id,
        createEntry(admitted, this.engine.iso()),
        'pheromone.enqueued',
      );
      this.engine.resting = false;
    });
  };

  /** Activates every runnable Bee until the field is quiet. */
  pump(): Promise<void> {
    return pumpField(this.engine);
  }

  /** Immutable view of the PheromoneField. */
  snapshot(): PheromoneFieldSnapshot {
    return snapshotField(this.definition, this.engine.states, this.engine.resting);
  }

  /**
   * Answers the node's open user hover. An answer that does not match the
   * current hover is rejected; there is no early-answer queue.
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
    const state = this.engine.states.get(nodeId);
    if (state?.hover === undefined) {
      throw new Error(`node '${nodeId}' has no open hover`);
    }
    if (token !== undefined && token !== state.hover.token) {
      throw new Error(`hover token mismatch for node '${nodeId}'`);
    }
    const pheromone = state.hoverPheromone;
    if (pheromone === undefined) {
      throw new Error(`hover for node '${nodeId}' has no Pheromone`);
    }
    completeHover(this.engine, node, pheromone, value, 'answered');
    startOtherDrains(this.engine);
    refreshRest(this.engine);
  }

  /**
   * JSON shape for `honey/field.json`. The field-owned last output is
   * deliberately not persisted.
   */
  exportField(): PersistedField {
    return exportPersistedField(this.definition, this.engine.states, this.engine.resting);
  }

  /**
   * Rebuilds a runtime from a persisted field. Queue entries, pending slots and
   * user hovers are resumed; an `active` execution becomes unknown and is never
   * replayed.
   */
  static restore(
    definition: CompositionDefinition,
    field: PersistedField,
    options: RuntimeOptions,
  ): { runtime: PheromoneRuntime; report: RecoveryReport } {
    const runtime = new PheromoneRuntime(definition, options);
    const report = applyPersistedField(definition, runtime.engine.states, field, (entry) =>
      runtime.log(entry),
    );
    const stateLock = runtime.engine.stateLock;
    stateLock.runSync(() => {
      expireOverdueQueues(runtime.engine.queue);
      runtime.engine.resting = isFieldResting(runtime.engine.states.values());
    });
    return { runtime, report };
  }

  /**
   * Marks nodes as needing a human after a forced edit or a guard that cannot
   * be resumed. State is kept; nothing is replayed.
   */
  markNeedsAttention(nodeIds: readonly NodeId[]): void {
    for (const id of nodeIds) {
      const node = this.requireNode(id);
      const state = stateOf(this.engine.queue, id);
      state.state = { ...(state.state ?? {}), needsAttention: true };
      this.log({ event: 'runtime.attention', nodeId: id, nodeKind: node.kind });
    }
  }

  /** Settles the open Guard for `requestId`. */
  settleGuard(nodeId: NodeId, requestId: string, decision: GuardDecision): void {
    settleGuardHover(this.engine, nodeId, requestId, decision);
  }

  private requireNode(nodeId: NodeId): NodeDefinition {
    const node = this.definition.nodes.get(nodeId);
    if (node === undefined) {
      throw new Error(`unknown node '${nodeId}'`);
    }
    return node;
  }

  private log(entry: RuntimeLogFields): void {
    if (this.onLog === undefined) {
      return;
    }
    this.onLog({
      at: this.engine.iso(),
      compositionId: this.definition.id,
      graphRevision: this.definition.graphRevision,
      ...entry,
    });
  }
}

function readGuardTimeout(options: RuntimeOptions): number {
  const guardTimeoutMs = options.guardTimeoutMs ?? DEFAULT_GUARD_TIMEOUT_MS;
  if (!Number.isFinite(guardTimeoutMs) || guardTimeoutMs <= 0) {
    throw new TypeError('options.guardTimeoutMs must be a positive number');
  }
  return guardTimeoutMs;
}

function createOverflow(
  definition: CompositionDefinition,
  options: RuntimeOptions,
  stateLock: StateLock,
  queue: QueueContext,
  iso: () => string,
  log: RuntimeLogFieldsSink,
): ReceptorOverflow | undefined {
  const receptor = readReceptorOverflowOptions(options);
  if (receptor.policy !== 'block') {
    return undefined;
  }
  return new ReceptorOverflow(
    {
      liveId: definition.id,
      limit: definition.defaults.queueMax,
      now: queue.now,
      locked: () => stateLock.locked,
      transaction: (action) => stateLock.runSync(action),
      depth: (nodeId) => queueDepth(stateOf(queue, nodeId)),
      tryAppend: (nodeId, value) => tryAppendEntry(queue, nodeId, createEntry(value, iso())),
      log,
    },
    receptor.blockTimeoutMs,
  );
}

interface EngineParts {
  readonly definition: CompositionDefinition;
  readonly options: RuntimeOptions;
  readonly states: Map<NodeId, NodeState>;
  readonly stateLock: StateLock;
  readonly queue: QueueContext;
  readonly iso: () => string;
  readonly log: RuntimeLogFieldsSink;
  readonly overflow: ReceptorOverflow | undefined;
  readonly guardTimeoutMs: number;
}

function buildEngine(parts: EngineParts): EngineContext {
  return {
    definition: parts.definition,
    states: parts.states,
    now: parts.queue.now,
    iso: parts.iso,
    log: parts.log,
    queue: parts.queue,
    receptorOverflow: parts.overflow,
    stateLock: parts.stateLock,
    drains: new Map(),
    executor: parts.options.executeForager,
    projectDirectory: parts.options.projectDirectory,
    guardTimeoutMs: parts.guardTimeoutMs,
    guardWaiters: new Map<string, GuardWaiter>(),
    onGuard: parts.options.onGuard,
    onGuardExpired: parts.options.onGuardExpired,
    reportedBlocks: new Set(),
    failure: undefined,
    resting: isFieldResting(parts.states.values()),
  };
}
