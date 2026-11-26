import type { EngineContext, LateActivationOutcome } from './engine-context.js';
import { matchesRule } from './definition-rules.js';
import { emitAlong } from './emit.js';
import { isBeeResult, type ExecutionContext } from './executor.js';
import { openUserHover, requestGuard } from './hover.js';
import { runGather } from './gather.js';
import {
  logActivated,
  logCompleted,
  logDropMissing,
  logFailed,
  logFiltered,
} from './runtime-log.js';
import {
  expireReceptorOfNode,
  markChanged,
  stagePending,
  stateOf,
} from './queue.js';
import { workerLogFields } from './runtime-values.js';
import { runSpread } from './spread.js';
import { assertValue } from './runtime-input.js';
import {
  applyFilter,
  applyWriteBack,
  assertNoDropOverlap,
  assertWrites,
  resolveReads,
} from './value-merge.js';
import { cloneJson } from './value-paths.js';
import { runWorker, workerExitError, type WorkerResult } from './worker.js';
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

/** One input already moved out of its bee's receptor for this activation. */
export interface Activation {
  readonly node: NodeDefinition;
  readonly pheromone: Pheromone;
}

/** What one per-Bee drain step found: work, a pacing due instant, or quiet. */
export type DrainStep =
  | { readonly kind: 'activation'; readonly activation: Activation }
  | { readonly kind: 'pacing'; readonly dueAt: number }
  | { readonly kind: 'waiting' }
  | { readonly kind: 'idle' };

interface NodeResult {
  /** The reply to merge; undefined for condition/counter, which emit no value. */
  readonly value?: Value;
  readonly outcome: string;
  readonly branch?: 'true' | 'false' | 'continue' | 'done';
  readonly drop?: readonly string[];
  readonly log?: Partial<import('./log.js').RuntimeLogEntry>;
}

/**
 * Takes the next step for one Bee's drain. The head of the receptor becomes
 * `pending`; an activation is handed over only once `minIntervalMs` has passed
 * since the previous activation. Nothing is reserved here: a full downstream
 * receptor drops the emitted value at the move (§9), it never holds the source
 * input back.
 */
export function nextDrainStep(ctx: EngineContext, nodeId: string): DrainStep {
  const node = ctx.definition.nodes.get(nodeId);
  if (node === undefined) {
    return { kind: 'idle' };
  }
  expireReceptorOfNode(ctx.queue, nodeId);
  const state = stateOf(ctx.queue, nodeId);
  if (state.active !== undefined || state.hover !== undefined) {
    return { kind: 'waiting' };
  }
  const now = ctx.now();
  const dueAt = nextDueAt(node, state);
  if (state.pending === undefined) {
    if ((state.receptor?.length ?? 0) === 0) {
      return { kind: 'idle' };
    }
    stagePending(ctx.queue, node, state, now < dueAt);
  }
  if (state.pending === undefined) {
    return { kind: 'idle' };
  }
  if (now < dueAt) {
    return { kind: 'pacing', dueAt };
  }
  const pheromone = state.pending;
  delete state.pending;
  markChanged(ctx.queue);
  return { kind: 'activation', activation: { node, pheromone } };
}

function nextDueAt(node: NodeDefinition, state: NodeState): number {
  return state.lastActivatedAt === undefined
    ? Number.NEGATIVE_INFINITY
    : Date.parse(state.lastActivatedAt) + node.minIntervalMs;
}

/**
 * Runs one activation to completion.
 *
 * A failed input is dropped and logged; the same Bee's drain then continues
 * with its next entry and other Bees are unaffected (§9.2). The failure is
 * never replayed. When the field was detached while a native execution was in
 * flight, its result is handed back to the host instead of being written back.
 */
export async function activate(ctx: EngineContext, activation: Activation): Promise<void> {
  const { node, pheromone } = activation;
  const state = stateOf(ctx.queue, node.id);
  const startedAt = beginActivation(ctx, node, pheromone, state);
  if (startedAt === null) {
    return;
  }
  try {
    if (node.kind === 'spread') {
      runControl(ctx, node, () => runSpread(ctx, node, pheromone), startedAt);
      return;
    }
    if (node.kind === 'gather') {
      runControl(ctx, node, () => runGather(node), startedAt);
      return;
    }
    const result = await runNode(ctx, node, pheromone, state);
    if (ctx.detached) {
      handOffResult(ctx, node, result, startedAt);
      return;
    }
    finishActivation(ctx, node, pheromone, startedAt, result);
  } catch (error) {
    if (ctx.detached) {
      handOffFailure(ctx, node, error, startedAt);
    } else {
      logFailed(ctx.log, node, startedAt, ctx.now(), error);
      markChanged(ctx.queue);
    }
  } finally {
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
  markChanged(ctx.queue);
  logActivated(ctx.log, node, state.receptor?.length ?? 0);
  if (node.kind === 'user') {
    openUserHover(ctx, node, pheromone);
    return null;
  }
  state.active = pheromone;
  return ctx.now();
}

/**
 * Runs one control Bee synchronously. A typed error (unknown target, missing
 * cleave path, not-implemented gather) drops only this input; it is logged and
 * the field keeps running.
 */
function runControl(
  ctx: EngineContext,
  node: NodeDefinition,
  run: () => string,
  startedAt: number,
): void {
  try {
    const outcome = run();
    logCompleted(ctx.log, node, ctx.now() - startedAt, outcome);
    markChanged(ctx.queue);
  } catch (error) {
    logFailed(ctx.log, node, startedAt, ctx.now(), error);
    markChanged(ctx.queue);
  }
}

function finishActivation(
  ctx: EngineContext,
  node: NodeDefinition,
  pheromone: Pheromone,
  startedAt: number,
  result: NodeResult,
): void {
  const state = stateOf(ctx.queue, node.id);
  logCompleted(ctx.log, node, ctx.now() - startedAt, result.outcome, result.log);
  if ((node.kind === 'forager' || node.kind === 'worker') && result.value !== undefined) {
    applyReply(ctx, node, pheromone, state, result);
  }
  markChanged(ctx.queue);
  emitAlong(ctx, node, pheromone, result.branch);
}

/**
 * Filters the raw reply, checks the declared writes, merges the remainder and
 * applies the result's independent drop list. The last output is the filtered
 * reply (not the merged value): it is the Bee's own output, memory-only.
 */
function applyReply(
  ctx: EngineContext,
  node: NodeDefinition,
  pheromone: Pheromone,
  state: NodeState,
  result: NodeResult,
): void {
  const reply = result.value as Value;
  const filtered = applyFilter(reply, node.filter);
  logFiltered(ctx.log, node, filtered.removed);
  assertWrites(filtered.value, node.writes, node.id);
  if (result.drop !== undefined) {
    // The result asked to drop what it also carried: configuration error, even
    // when a filter would have removed the path before the merge.
    assertNoDropOverlap(reply, result.drop);
  }
  const applied = applyWriteBack(pheromone.value, filtered.value, result.drop, (path) => {
    logDropMissing(ctx.log, node, [path]);
  });
  pheromone.value = applied.value;
  state.lastOutput = cloneJson(filtered.value);
}

/** Hands one completed native result to the host after the field was released. */
function handOffResult(
  ctx: EngineContext,
  node: NodeDefinition,
  result: NodeResult,
  startedAt: number,
): void {
  const handler = ctx.onLateResult;
  if (handler === undefined || result.value === undefined) {
    logFailed(
      ctx.log,
      node,
      startedAt,
      ctx.now(),
      new Error(`late result for '${node.id}' has no destination field`),
    );
    markChanged(ctx.queue);
    return;
  }
  handler(node.id, {
    ok: true,
    value: result.value,
    outcome: result.outcome,
    startedAt,
    ...(result.drop === undefined ? {} : { drop: result.drop }),
    ...(result.branch === undefined ? {} : { branch: result.branch }),
  });
}

/** Hands one failed native result to the host after the field was released. */
function handOffFailure(
  ctx: EngineContext,
  node: NodeDefinition,
  error: unknown,
  startedAt: number,
): void {
  const handler = ctx.onLateResult;
  if (handler === undefined) {
    logFailed(ctx.log, node, startedAt, ctx.now(), error);
    markChanged(ctx.queue);
    return;
  }
  handler(node.id, {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    startedAt,
  });
}

/**
 * Completes one restored active with the late result of its own native
 * execution. It is the same activation: write-back and the outgoing move, never
 * a second Bee execution.
 */
export function applyRestoredOutcome(
  ctx: EngineContext,
  nodeId: string,
  outcome: LateActivationOutcome,
): void {
  const node = ctx.definition.nodes.get(nodeId);
  if (node === undefined) {
    throw new Error(`unknown node '${nodeId}'`);
  }
  const state = stateOf(ctx.queue, nodeId);
  const pheromone = state.active;
  if (pheromone === undefined) {
    throw new Error(`node '${nodeId}' has no restored active activation`);
  }
  try {
    if (!outcome.ok) {
      logFailed(ctx.log, node, outcome.startedAt, ctx.now(), new Error(outcome.error));
      markChanged(ctx.queue);
      return;
    }
    const result: NodeResult = {
      value: outcome.value,
      outcome: outcome.outcome,
      ...(outcome.drop === undefined ? {} : { drop: outcome.drop }),
      ...(outcome.branch === undefined ? {} : { branch: outcome.branch }),
    };
    finishActivation(ctx, node, pheromone, outcome.startedAt, result);
  } finally {
    delete state.active;
  }
}

async function runNode(
  ctx: EngineContext,
  node: NodeDefinition,
  pheromone: Pheromone,
  state: NodeState,
): Promise<NodeResult> {
  // Every task Bee resolves its declared reads; built-in defaults mean a worker
  // or condition still reads nothing unless the instance overrides the list.
  const input = resolveReads(pheromone.value, node.reads, node.fallback, node.id);
  if (node.kind === 'forager') {
    return runForager(ctx, node, input);
  }
  if (node.kind === 'worker') {
    // A worker never receives the Value: its argv is static and its output is
    // stdout. Only the declared read precondition applies.
    return runWorkerNode(ctx, node);
  }
  if (node.kind === 'condition') {
    return runCondition(node, input);
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
  input: Value,
): Promise<NodeResult> {
  const context: ExecutionContext = {
    requestGuard: (request, decide) => requestGuard(ctx, node, request, decide),
  };
  const output = await ctx.executor.execute(node, input, context);
  const reply = isBeeResult(output) ? output.value : output;
  const drop = isBeeResult(output) ? output.drop : undefined;
  assertValue(reply, `forager '${node.id}' reply`);
  return { value: reply, outcome: 'ok', ...(drop === undefined ? {} : { drop }) };
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

function runCondition(node: ConditionNode, input: Value): NodeResult {
  const branch = matchesRule(node.config.when, input, `condition '${node.id}'`) ? 'true' : 'false';
  return { outcome: branch, branch };
}

/** Commits the counter step and returns the branch that step selects. */
function advanceCounter(node: CounterNode, state: NodeState): 'continue' | 'done' {
  const previous = state.state?.['count'];
  const count = (typeof previous === 'number' ? previous : 0) + node.config.step;
  state.state = { ...(state.state ?? {}), count };
  return count >= node.config.max ? 'done' : 'continue';
}

/** A user answer is completed by the hover path, not by `runNode`. */
export type { UserNode };
