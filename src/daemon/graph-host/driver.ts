import type { LiveHiveHostContext } from './context.js';
import { messageOf, snapshotHovered } from './context.js';
import { earliestDue } from './schedule.js';
import type { LiveGraph } from './types.js';

/** How often an ephemeral graph is re-checked while it is still busy. */
const EPHEMERAL_RELEASE_POLL_MS = 25;

/**
 * Drives a live hive after a delivery. The host lock is intentionally not held:
 * the runtime's own short state lock protects every field mutation. Several
 * drivers may coexist; `pump()` starts only bees without an active drain, so
 * they do not duplicate a bee's FIFO.
 *
 * A dispatch graph is ephemeral: once its field reaches Rest (silent end) the
 * driver releases it. There is no execution record and no public id for this;
 * the graph simply stops existing in the host.
 */
export function startFieldDriver(context: LiveHiveHostContext, graphId: string): void {
  void drive(context, graphId).catch((error) => {
    context.reportCleanupFailure({
      type: 'graph.cleanup-failed',
      graphId,
      phase: 'routing',
      error: messageOf(error),
    });
  });
}

async function drive(context: LiveHiveHostContext, graphId: string): Promise<void> {
  let pumps = 0;
  let waitedMs = 0;
  try {
    for (;;) {
      const live = context.graphs.peek(graphId)?.value;
      if (live === undefined || context.disposed) {
        return;
      }
      let failed = false;
      try {
        await live.runtime.pump();
      } catch {
        // A failed activation is already logged on the field; the driver still
        // stops at Rest so an ephemeral graph can be released.
        failed = true;
      }
      pumps += 1;
      const snapshot = live.runtime.snapshot();
      if (failed || snapshot.rest || snapshotHovered(snapshot) || pumps >= context.maxPumps) {
        await flush(context, live);
        return;
      }
      const due = earliestDue(live.definition, snapshot);
      const wait = waitFor(due, context, waitedMs);
      if (wait === undefined) {
        await flush(context, live);
        return;
      }
      await context.sleep(wait);
      waitedMs += wait;
    }
  } finally {
    await releaseEphemeral(context, graphId);
  }
}

function waitFor(
  due: number | undefined,
  context: LiveHiveHostContext,
  waitedMs: number,
): number | undefined {
  if (due === undefined) {
    return undefined;
  }
  const dueInMs = due > context.now() ? due - context.now() : 0;
  const remainingMs = context.maxWaitMs - waitedMs;
  if (dueInMs <= 0 || remainingMs <= 0) {
    return undefined;
  }
  return Math.min(dueInMs, remainingMs);
}

async function flush(context: LiveHiveHostContext, live: LiveGraph): Promise<void> {
  if (live.honey === undefined) {
    return;
  }
  try {
    await live.honey.save(live.runtime.exportField());
  } catch (error) {
    context.reportCleanupFailure({
      type: 'graph.cleanup-failed',
      graphId: live.definition.id,
      phase: 'routing',
      error: messageOf(error),
    });
  }
}

/**
 * Release a dispatch graph once its field is at Rest. It is not in the catalog
 * and never becomes a LiveHive, so no unload event is recorded for it.
 *
 * There is deliberately no time bound: D1 says the temporary Bee is released
 * at silent end, not after a deadline. A native turn that never settles keeps
 * the ephemeral graph loaded (observable through `statusOf` and the host's own
 * lookup) instead of silently leaking an unreaped graph. The 25ms sleep is a
 * yield, not a CPU spin; host disposal ends the wait.
 */
async function releaseEphemeral(
  context: LiveHiveHostContext,
  graphId: string,
): Promise<void> {
  const entry = context.graphs.peek(graphId);
  if (entry === undefined || entry.value.ephemeral !== true) {
    return;
  }
  for (;;) {
    if (context.disposed) {
      return;
    }
    const current = context.graphs.peek(graphId)?.value;
    if (current === undefined) {
      return;
    }
    if (current.runtime.snapshot().rest) {
      try {
        if (await context.graphs.unload(graphId)) {
          return;
        }
      } catch {
        // Best effort: the registry reports cleanup failures itself.
      }
    }
    await context.sleep(EPHEMERAL_RELEASE_POLL_MS);
  }
}
