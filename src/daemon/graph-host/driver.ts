import { traceStateFromSnapshot } from '../../runtime/index.js';
import type { LiveHiveHostContext } from './context.js';
import { messageOf, snapshotHovered } from './context.js';
import { earliestDue } from './schedule.js';
import type { LiveGraph } from './types.js';

/**
 * Drives a live hive after an admission. The host lock is intentionally not
 * held: the runtime's own short state lock protects every field mutation.
 * Several drivers may coexist; `pump()` starts only bees without an active
 * drain, so they do not duplicate a bee's FIFO.
 */
export function startRunDriver(context: LiveHiveHostContext, graphId: string): void {
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
  for (;;) {
    const live = context.graphs.peek(graphId)?.value;
    if (live === undefined || context.disposed) {
      return;
    }
    try {
      await live.runtime.pump();
    } catch {
      // The runtime reported the failing trace to the run tracker; other runs
      // must still be able to finish.
    }
    pumps += 1;
    const snapshot = live.runtime.snapshot();
    context.runs.reconcile(graphId, (traceId) => traceStateFromSnapshot(snapshot, traceId));
    if (snapshot.rest || snapshotHovered(snapshot) || pumps >= context.maxPumps) {
      await flush(context, live);
      return;
    }
    const due = earliestDue(live.definition, live.runtime, snapshot);
    const wait = waitFor(due, context, waitedMs);
    if (wait === undefined) {
      await flush(context, live);
      return;
    }
    await context.sleep(wait);
    waitedMs += wait;
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
