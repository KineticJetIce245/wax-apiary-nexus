import { activate, applyRestoredOutcome, nextDrainStep } from './activation.js';
import type { EngineContext, LateActivationOutcome, PacingTimer } from './engine-context.js';
import { restReceptorIfIdle } from './field.js';
import { expireOverdueQueues, markChanged, stateOf } from './queue.js';

/**
 * Per-Bee receptor drain. An enqueue wakes its Bee: if no drain is running one
 * starts; otherwise the entry joins the same FIFO. Each drain runs at most one
 * activation at a time and stops when its receptor and pending slot are empty.
 * A pacing wait schedules the Bee's own timer and ends the current round.
 *
 * There is no field-wide pump and no host driver pass. `settle` is an
 * observation of running drains, not a driver loop.
 */

/** Starts a Bee's drain when it has work and no drain is running or scheduled. */
export function wakeBee(ctx: EngineContext, nodeId: string): void {
  if (ctx.detached || ctx.drains.has(nodeId) || ctx.scheduledWakes.has(nodeId)) {
    return;
  }
  const state = ctx.states.get(nodeId);
  if (state === undefined || state.hover !== undefined || state.active !== undefined) {
    return;
  }
  const token = Symbol('wake');
  ctx.scheduledWakes.set(nodeId, token);
  // A macrotask keeps admission observable as `receptor` before the drain
  // starts; `settle` flushes a scheduled wake immediately when it is called.
  setImmediate(() => {
    if (ctx.scheduledWakes.get(nodeId) !== token) {
      return;
    }
    ctx.scheduledWakes.delete(nodeId);
    startDrain(ctx, nodeId);
  });
}

/** Wakes every restored receptor/pending Bee; hovers stay parked until answer. */
export function wakeRestored(ctx: EngineContext): void {
  for (const [nodeId, state] of ctx.states) {
    if (state.hover !== undefined || state.active !== undefined) {
      continue;
    }
    if ((state.receptor?.length ?? 0) > 0 || state.pending !== undefined) {
      wakeBee(ctx, nodeId);
    }
  }
}

/**
 * Waits until every running drain has finished and every drain started during
 * that wait has finished too, bounded by `maxWaitMs` when it is supplied.
 * With a bound, due pacing timers inside the budget are also observed.
 */
export async function settleField(
  ctx: EngineContext,
  maxWaitMs?: number,
): Promise<void> {
  const deadline = maxWaitMs === undefined ? undefined : Date.now() + Math.max(0, maxWaitMs);
  for (;;) {
    ctx.stateLock.runSync(() => expireOverdueQueues(ctx.queue));
    wakeDueTimers(ctx);
    flushScheduledWakes(ctx);
    const drains = [...ctx.drains.values()];
    if (drains.length > 0) {
      const remaining = remainingMs(deadline);
      if (remaining !== undefined && remaining <= 0) {
        return;
      }
      await waitForDrains(drains, remaining);
      continue;
    }
    const wait = pacingWait(ctx, deadline);
    if (wait === undefined) {
      return;
    }
    if (wait <= 0) {
      continue;
    }
    await ctx.sleep(wait);
  }
}

/**
 * How long until the next due pacing timer, bounded by the host wait deadline.
 * `undefined` means there is nothing left to observe; `0` means wake now.
 */
function pacingWait(ctx: EngineContext, deadline: number | undefined): number | undefined {
  if (deadline === undefined) {
    // Without a host wait bound, a future pacing timer is not work to join;
    // the Bee's own timer wakes it when due.
    return undefined;
  }
  const dueAt = nextTimerDueAt(ctx);
  if (dueAt === undefined) {
    return undefined;
  }
  const wait = dueAt - ctx.now();
  if (wait <= 0) {
    return 0;
  }
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    return undefined;
  }
  return Math.min(wait, remaining);
}

/** Completes one restored active; the host calls this after a late result. */
export function completeRestored(
  ctx: EngineContext,
  nodeId: string,
  outcome: LateActivationOutcome,
): void {
  ctx.stateLock.runSync(() => applyRestoredOutcome(ctx, nodeId, outcome));
  markChanged(ctx.queue);
  wakeBee(ctx, nodeId);
}

/** Marks the field released; running activations hand their result to the host. */
export function detachField(ctx: EngineContext): void {
  ctx.detached = true;
  ctx.scheduledWakes.clear();
  ctx.timers.clear();
}

function flushScheduledWakes(ctx: EngineContext): void {
  if (ctx.scheduledWakes.size === 0) {
    return;
  }
  const nodeIds = [...ctx.scheduledWakes.keys()];
  ctx.scheduledWakes.clear();
  for (const nodeId of nodeIds) {
    startDrain(ctx, nodeId);
  }
}

function startDrain(ctx: EngineContext, nodeId: string): void {
  if (ctx.detached || ctx.drains.has(nodeId)) {
    return;
  }
  const node = ctx.definition.nodes.get(nodeId);
  if (node === undefined) {
    return;
  }
  // Register the drain before its body runs: every drain path is allowed to
  // finish synchronously, and `finishDrain` must be able to delete this entry.
  const promise = Promise.resolve().then(() => drainBee(ctx, nodeId));
  ctx.drains.set(nodeId, promise);
  void promise.catch(() => undefined);
}

async function drainBee(ctx: EngineContext, nodeId: string): Promise<void> {
  try {
    for (;;) {
      if (ctx.detached) {
        finishDrain(ctx, nodeId);
        return;
      }
      const step = ctx.stateLock.runSync(() => nextDrainStep(ctx, nodeId));
      if (step.kind === 'activation') {
        await activate(ctx, step.activation);
        if (ctx.detached) {
          finishDrain(ctx, nodeId);
          return;
        }
        continue;
      }
      if (step.kind === 'pacing') {
        finishDrain(ctx, nodeId);
        schedulePacing(ctx, nodeId, step.dueAt);
        return;
      }
      finishDrain(ctx, nodeId);
      return;
    }
  } catch (error) {
    const node = ctx.definition.nodes.get(nodeId);
    if (node !== undefined && !ctx.detached) {
      ctx.log({
        event: 'node.failed',
        nodeId,
        nodeKind: node.kind,
        outcome: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
    finishDrain(ctx, nodeId);
  }
}

function finishDrain(ctx: EngineContext, nodeId: string): void {
  ctx.stateLock.runSync(() => {
    ctx.drains.delete(nodeId);
    const state = ctx.states.get(nodeId);
    if (state !== undefined) {
      restReceptorIfIdle(state);
    }
  });
  if (!ctx.detached) {
    markChanged(ctx.queue);
  }
}

function schedulePacing(ctx: EngineContext, nodeId: string, dueAt: number): void {
  if (ctx.detached || ctx.drains.has(nodeId) || ctx.timers.has(nodeId)) {
    return;
  }
  const timer: PacingTimer = { dueAt, token: Symbol('pacing') };
  ctx.timers.set(nodeId, timer);
  const wait = Math.max(0, dueAt - ctx.now());
  void ctx
    .sleep(wait)
    .then(() => {
      if (ctx.detached || ctx.timers.get(nodeId)?.token !== timer.token) {
        return;
      }
      ctx.timers.delete(nodeId);
      wakeBee(ctx, nodeId);
    })
    .catch(() => {
      if (ctx.timers.get(nodeId)?.token === timer.token) {
        ctx.timers.delete(nodeId);
      }
    });
}

function wakeDueTimers(ctx: EngineContext): void {
  const now = ctx.now();
  for (const [nodeId, timer] of [...ctx.timers]) {
    if (timer.dueAt > now) {
      continue;
    }
    ctx.timers.delete(nodeId);
    wakeBee(ctx, nodeId);
  }
}

function nextTimerDueAt(ctx: EngineContext): number | undefined {
  let next: number | undefined;
  for (const timer of ctx.timers.values()) {
    if (next === undefined || timer.dueAt < next) {
      next = timer.dueAt;
    }
  }
  return next;
}

function remainingMs(deadline: number | undefined): number | undefined {
  return deadline === undefined ? undefined : deadline - Date.now();
}

async function waitForDrains(
  drains: readonly Promise<void>[],
  maxWaitMs: number | undefined,
): Promise<void> {
  if (maxWaitMs !== undefined && maxWaitMs <= 0) {
    return;
  }
  const settled = Promise.allSettled(drains).then(() => undefined);
  if (maxWaitMs === undefined) {
    await settled;
    return;
  }
  let handle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    handle = setTimeout(() => resolve('timeout'), Math.max(0, maxWaitMs));
    unref(handle);
  });
  await Promise.race([settled.then(() => 'settled' as const), timeout]);
  if (handle !== undefined) {
    clearTimeout(handle);
  }
}

function unref(handle: ReturnType<typeof setTimeout>): void {
  const candidate = handle as unknown as { unref?: () => void };
  candidate.unref?.();
}
