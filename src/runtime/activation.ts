import type { EngineContext } from './engine-context.js';
import { emitAlong } from './emit.js';
import type { ExecutionContext } from './executor.js';
import { openUserHover, requestGuard } from './hover.js';
import { runGather } from './gather.js';
import {
  logActivated,
  logActivationBlocked,
  logCompleted,
  logDropMissing,
  logFailed,
} from './runtime-log.js';
import {
  releaseReservation,
  stagePending,
  stateOf,
  tryReserve,
  type OutputReservation,
  type OutputTarget,
} from './queue.js';
import { evaluateCondition, workerLogFields } from './runtime-values.js';
import { runSpread } from './spread.js';
import { assertValue } from './runtime-input.js';
import { applyWriteBack } from './value-merge.js';
import { cloneJson } from './value-paths.js';
import {
  runWorker,
  workerExitError,
  type WorkerResult,
} from './worker.js';
import type {
  ConditionNode,
  CounterNode,
  ForagerNode,
  NodeDefinition,
  NodeState,
  Pheromone,
  UserNode,
  Value,
  WorkerNode,
} from './types.js';

/** One input already removed from its bee's receptor and reserved for output. */
export interface Activation {
  readonly node: NodeDefinition;
  readonly pheromone: Pheromone;
  readonly reservation: OutputReservation;
}

interface NodeResult {
  /** The reply to merge; undefined for condition/counter, which emit no value. */
  readonly value?: Value;
  readonly outcome: string;
  readonly branch?: 'true' | 'false' | 'continue' | 'done';
  readonly drop?: readonly string[];
  readonly log?: Partial<import('./log.js').RuntimeLogEntry>;
}

export function takeRunnable(ctx: EngineContext): Activation | null {
  const now = ctx.now();
  for (const node of ctx.definition.nodes.values()) {
    if (ctx.drains.has(node.id)) {
      continue;
    }
    const activation = takeForNode(ctx, node, now);
    if (activation !== null) {
      return activation;
    }
  }
  return null;
}

export function takeNextForNode(ctx: EngineContext, nodeId: string): Activation | null {
  const node = ctx.definition.nodes.get(nodeId);
  return node === undefined ? null : takeForNode(ctx, node, ctx.now());
}

/**
 * Takes the Bee's pending input only when every output slot is already
 * reserved. A full target keeps the pending Pheromone in place; the pump
 * retries instead of consuming and failing the input.
 */
function takeForNode(
  ctx: EngineContext,
  node: NodeDefinition,
  now: number,
): Activation | null {
  const state = stateOf(ctx.queue, node.id);
  if (state.active !== undefined || state.hover !== undefined) {
    return null;
  }
  const dueAt =
    state.lastActivatedAt === undefined
      ? Number.NEGATIVE_INFINITY
      : Date.parse(state.lastActivatedAt) + node.minIntervalMs;
  stagePending(ctx.queue, node, state, now < dueAt);
  if (state.pending === undefined || now < dueAt) {
    return null;
  }
  const pheromone = state.pending;
  const reserved = tryReserve(ctx.queue, outputTargets(ctx, node, pheromone, state));
  if (!reserved.ok) {
    ctx.blockedByQueue = true;
    logActivationBlocked(
      ctx.log,
      ctx.reportedBlocks,
      node,
      reserved.target,
      reserved.queueDepth,
      ctx.definition.defaults.queueMax,
    );
    return null;
  }
  delete state.pending;
  return { node, pheromone, reservation: reserved.reservation };
}

/**
 * The queue slots this activation will need. Spread/gather reserve nothing
 * here: their execution path is a typed not-implemented error until M19c/M19d.
 */
function outputTargets(
  ctx: EngineContext,
  node: NodeDefinition,
  pheromone: Pheromone,
  state: NodeState,
): readonly OutputTarget[] {
  if (node.kind === 'spread' || node.kind === 'gather' || node.kind === 'user') {
    return [];
  }
  if (node.kind === 'condition') {
    return conditionTargets(ctx, node, pheromone);
  }
  if (node.kind === 'counter') {
    const branch = counterBranch(node, state);
    const edge = ctx.definition.edges.find(
      (candidate) => candidate.from === node.id && candidate.when === branch,
    );
    return edge === undefined ? [] : [{ targetId: edge.to, count: 1 }];
  }
  const edge = ctx.definition.edges.find((candidate) => candidate.from === node.id);
  return edge === undefined ? [] : [{ targetId: edge.to, count: 1 }];
}

function conditionTargets(
  ctx: EngineContext,
  node: ConditionNode,
  pheromone: Pheromone,
): readonly OutputTarget[] {
  if (node.config.mode === 'worker') {
    const targets: OutputTarget[] = [];
    for (const when of ['true', 'false'] as const) {
      const edge = ctx.definition.edges.find(
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
  const edge = ctx.definition.edges.find(
    (candidate) => candidate.from === node.id && candidate.when === branch,
  );
  return edge === undefined ? [] : [{ targetId: edge.to, count: 1 }];
}

function counterBranch(node: CounterNode, state: NodeState): 'continue' | 'done' {
  const previous = state.state?.['count'];
  const count = (typeof previous === 'number' ? previous : 0) + node.config.step;
  return count >= node.config.max ? 'done' : 'continue';
}

/** Commits the counter step and returns the branch that step selects. */
function advanceCounter(node: CounterNode, state: NodeState): 'continue' | 'done' {
  const previous = state.state?.['count'];
  const count = (typeof previous === 'number' ? previous : 0) + node.config.step;
  state.state = { ...(state.state ?? {}), count };
  return count >= node.config.max ? 'done' : 'continue';
}

/** Runs one activation to completion; the caller consumes the reservation. */
export async function activate(ctx: EngineContext, activation: Activation): Promise<void> {
  const { node, pheromone, reservation } = activation;
  const state = stateOf(ctx.queue, node.id);
  const startedAt = beginActivation(ctx, node, pheromone, state);
  if (startedAt === null) {
    return;
  }
  try {
    if (node.kind === 'spread') {
      await controlActivation(ctx, node, startedAt, () => runSpread(node));
      return;
    }
    if (node.kind === 'gather') {
      await controlActivation(ctx, node, startedAt, () => runGather(node));
      return;
    }
    await taskActivation(ctx, node, pheromone, state, reservation, startedAt);
  } finally {
    releaseReservation(ctx.queue, reservation);
    delete state.active;
  }
}

/** Opens the activation: a user Bee parks; every other Bee becomes active. */
function beginActivation(
  ctx: EngineContext,
  node: NodeDefinition,
  pheromone: Pheromone,
  state: NodeState,
): number | null {
  state.lastActivatedAt = ctx.iso();
  ctx.resting = false;
  logActivated(ctx.log, node, state.receptor?.length ?? 0);
  if (node.kind === 'user') {
    openUserHover(ctx, node, pheromone);
    return null;
  }
  state.active = pheromone;
  return ctx.now();
}

async function controlActivation(
  ctx: EngineContext,
  node: NodeDefinition,
  startedAt: number,
  run: () => never,
): Promise<void> {
  try {
    run();
  } catch (error) {
    logFailed(ctx.log, node, startedAt, ctx.now(), error);
    ctx.failure ??= error;
    throw error;
  }
}

async function taskActivation(
  ctx: EngineContext,
  node: NodeDefinition,
  pheromone: Pheromone,
  state: NodeState,
  reservation: OutputReservation,
  startedAt: number,
): Promise<void> {
  try {
    const result = await runNode(ctx, node, pheromone, state);
    finishActivation(ctx, node, pheromone, reservation, startedAt, result);
  } catch (error) {
    logFailed(ctx.log, node, startedAt, ctx.now(), error);
    ctx.failure ??= error;
    throw error;
  }
}

function finishActivation(
  ctx: EngineContext,
  node: NodeDefinition,
  pheromone: Pheromone,
  reservation: OutputReservation,
  startedAt: number,
  result: NodeResult,
): void {
  const state = stateOf(ctx.queue, node.id);
  logCompleted(ctx.log, node, ctx.now() - startedAt, result.outcome, result.log);
  if ((node.kind === 'forager' || node.kind === 'worker') && result.value !== undefined) {
    applyReply(ctx, node, pheromone, state, result);
  }
  emitAlong(ctx, node, pheromone, result.branch, reservation);
}

/** Merges a producing Bee's reply into the value and caches the last output. */
function applyReply(
  ctx: EngineContext,
  node: NodeDefinition,
  pheromone: Pheromone,
  state: NodeState,
  result: NodeResult,
): void {
  const reply = result.value as Value;
  const applied = applyWriteBack(pheromone.value, reply, result.drop, (path) => {
    logDropMissing(ctx.log, node, [path]);
  });
  pheromone.value = applied.value;
  state.lastOutput = cloneJson(reply);
}

async function runNode(
  ctx: EngineContext,
  node: NodeDefinition,
  pheromone: Pheromone,
  state: NodeState,
): Promise<NodeResult> {
  if (node.kind === 'forager') {
    return runForager(ctx, node, pheromone);
  }
  if (node.kind === 'worker') {
    return runWorkerNode(ctx, node);
  }
  if (node.kind === 'condition') {
    return runCondition(ctx, node, pheromone);
  }
  if (node.kind === 'user') {
    throw new Error(`user node '${node.id}' waits for input instead of running`);
  }
  if (node.kind !== 'counter') {
    throw new Error(`node '${node.id}' (${node.kind}) cannot run as a task`);
  }
  const branch = advanceCounter(node, state);
  return { outcome: branch, branch };
}

async function runForager(
  ctx: EngineContext,
  node: ForagerNode,
  pheromone: Pheromone,
): Promise<NodeResult> {
  const context: ExecutionContext = {
    requestGuard: (request, decide) => requestGuard(ctx, node, request, decide),
  };
  const output = await ctx.executor.execute(node, pheromone.value, context);
  assertValue(output, `forager '${node.id}' reply`);
  return { value: output, outcome: 'ok' };
}

async function runWorkerNode(ctx: EngineContext, node: WorkerNode): Promise<NodeResult> {
  const result = await runWorker(node.config, requireProjectDirectory(ctx, node));
  if (result.exitCode !== 0) {
    throw workerExitError(result);
  }
  return workerReply(result, `worker '${node.id}' reply`);
}

function workerReply(result: WorkerResult, label: string): NodeResult {
  const reply: Value = { message: result.stdout.trimEnd() };
  assertValue(reply, label);
  return { value: reply, outcome: 'ok', log: workerLogFields(result) };
}

function requireProjectDirectory(ctx: EngineContext, node: NodeDefinition): string {
  if (ctx.projectDirectory === undefined || ctx.projectDirectory.trim() === '') {
    throw new Error(`node '${node.id}' is a worker but no project directory is registered`);
  }
  return ctx.projectDirectory;
}

async function runCondition(
  ctx: EngineContext,
  node: ConditionNode,
  pheromone: Pheromone,
): Promise<NodeResult> {
  if (node.config.mode === 'worker') {
    const result = await runWorker(node.config, requireProjectDirectory(ctx, node));
    const branch = result.exitCode === 0 ? 'true' : 'false';
    return { outcome: branch, branch, log: workerLogFields(result) };
  }
  const branch = evaluateCondition(node.config, pheromone.value);
  return { outcome: branch, branch };
}

/** A user answer is completed by the hover path, not by `runNode`. */
export type { UserNode };
