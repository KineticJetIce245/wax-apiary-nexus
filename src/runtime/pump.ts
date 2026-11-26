import { activate, takeNextForNode, takeRunnable, type Activation } from './activation.js';
import type { EngineContext } from './engine-context.js';
import { isFieldResting, restReceptorIfIdle } from './field.js';
import { expireOverdueQueues, stateOf } from './queue.js';

/**
 * Activates every runnable Bee until the field is quiet. `maxPumps`/waits are a
 * host driver concern; this function ends only when no drain is left.
 */
export async function pumpField(ctx: EngineContext): Promise<void> {
  ctx.failure = undefined;
  ctx.stateLock.runSync(() => {
    expireOverdueQueues(ctx.queue);
    ctx.receptorOverflow?.notifyAll();
  });
  try {
    await drainUntilQuiet(ctx);
  } finally {
    ctx.stateLock.runSync(() => refreshRest(ctx));
  }
  if (ctx.failure !== undefined) {
    // Let every started drain settle before the failure leaves the pump.
    await Promise.allSettled([...ctx.drains.values()]);
    throw ctx.failure;
  }
}

async function drainUntilQuiet(ctx: EngineContext): Promise<void> {
  for (;;) {
    await startRunnableDrains(ctx);
    if (ctx.failure !== undefined) {
      return;
    }
    if (ctx.drains.size > 0) {
      await Promise.allSettled([...ctx.drains.values()]);
      if (ctx.failure !== undefined) {
        return;
      }
      continue;
    }
    return;
  }
}

async function startRunnableDrains(ctx: EngineContext): Promise<void> {
  for (;;) {
    const next = ctx.stateLock.runSync(() => takeRunnable(ctx));
    if (next === null) {
      return;
    }
    startDrain(ctx, next);
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (ctx.failure !== undefined) {
      return;
    }
  }
}

/** Starts a drain for every runnable Bee that does not already own one. */
export function startOtherDrains(ctx: EngineContext): void {
  for (;;) {
    if (ctx.failure !== undefined) {
      return;
    }
    const next = ctx.stateLock.runSync(() => takeRunnable(ctx));
    if (next === null) {
      return;
    }
    startDrain(ctx, next);
  }
}

function startDrain(ctx: EngineContext, first: Activation): void {
  const nodeId = first.node.id;
  const drain = drainBee(ctx, nodeId, first);
  ctx.drains.set(nodeId, drain);
  void drain.catch(() => undefined);
}

async function drainBee(
  ctx: EngineContext,
  nodeId: string,
  first: Activation,
): Promise<void> {
  let activation: Activation | null = first;
  try {
    while (activation !== null) {
      await activate(ctx, activation);
      startOtherDrains(ctx);
      activation = ctx.stateLock.runSync(() => {
        expireOverdueQueues(ctx.queue);
        ctx.receptorOverflow?.notifyAll();
        return takeNextForNode(ctx, nodeId);
      });
    }
  } catch (error) {
    ctx.failure ??= error;
    throw error;
  } finally {
    ctx.stateLock.runSync(() => {
      ctx.drains.delete(nodeId);
      restReceptorIfIdle(stateOf(ctx.queue, nodeId));
      refreshRest(ctx);
    });
  }
}

/** Recomputes Rest, logging the transition when the field becomes quiet. */
export function refreshRest(ctx: EngineContext): void {
  const resting = isFieldResting(ctx.states.values());
  if (resting && !ctx.resting) {
    ctx.resting = true;
    ctx.log({ event: 'runtime.rest' });
  } else if (!resting) {
    ctx.resting = false;
  }
}
