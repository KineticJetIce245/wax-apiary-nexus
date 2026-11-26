import type { LiveHiveHostContext } from './context.js';
import { messageOf } from './context.js';

/**
 * Rest is an observation of the field, not a driver pass. When a graph reaches
 * Rest the host flushes its Honey (best effort) and releases an ephemeral
 * dispatch graph. No loop polls the field: the runtime reports the transition.
 */
export function handleRestTransition(context: LiveHiveHostContext, graphId: string): void {
  const live = context.graphs.peek(graphId)?.value;
  if (live === undefined) {
    return;
  }
  if (live.ephemeral) {
    void releaseEphemeral(context, graphId);
    return;
  }
  if (live.honey !== undefined) {
    void flushRest(context, graphId);
  }
}

async function flushRest(context: LiveHiveHostContext, graphId: string): Promise<void> {
  const live = context.graphs.peek(graphId)?.value;
  if (live?.honey === undefined) {
    return;
  }
  try {
    await live.honey.save(live.runtime.exportField());
  } catch (error) {
    context.reportCleanupFailure({
      type: 'graph.cleanup-failed',
      graphId,
      phase: 'routing',
      error: messageOf(error),
    });
  }
}

/**
 * A dispatch graph is released once its field is quiet. `settle` is the quiet
 * observation (bounded by the host's `maxWaitMs`), never an execution budget:
 * if the field is not quiet yet, the next Rest transition asks again.
 */
async function releaseEphemeral(
  context: LiveHiveHostContext,
  graphId: string,
): Promise<void> {
  const live = context.graphs.peek(graphId)?.value;
  if (live?.ephemeral !== true) {
    return;
  }
  await live.runtime.settle(context.maxWaitMs);
  const current = context.graphs.peek(graphId)?.value;
  if (current?.ephemeral !== true || !current.runtime.snapshot().rest) {
    return;
  }
  await context.lock.tryRun(graphId, async () => {
    const again = context.graphs.peek(graphId)?.value;
    if (again?.ephemeral !== true) {
      return false;
    }
    return context.graphs.unload(graphId);
  });
}
