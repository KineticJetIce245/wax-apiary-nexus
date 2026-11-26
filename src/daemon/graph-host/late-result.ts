import type { LiveHiveId } from '../../graph/registry.js';
import type { LateActivationOutcome, NodeId } from '../../runtime/index.js';
import type { LiveHiveHostContext } from './context.js';
import { messageOf } from './context.js';

/** Loads the field again from Honey; supplied by the lifecycle loader. */
export type LateResultReload = () => Promise<void>;

/**
 * A native activation completed after its field was released. The host loads
 * the field again (same LiveHive id, same sessions) and hands the result to the
 * restored active. It is the completion of that activation, not a replay and
 * not a second Bee execution.
 */
export function handleLateResult(
  context: LiveHiveHostContext,
  graphId: LiveHiveId,
  reload: LateResultReload,
  releaseOld: () => void,
  nodeId: NodeId,
  outcome: LateActivationOutcome,
): void {
  void applyLateResult(context, graphId, reload, releaseOld, nodeId, outcome);
}

async function applyLateResult(
  context: LiveHiveHostContext,
  graphId: LiveHiveId,
  reload: LateResultReload,
  releaseOld: () => void,
  nodeId: NodeId,
  outcome: LateActivationOutcome,
): Promise<void> {
  try {
    if (context.disposed) {
      return;
    }
    if (context.graphs.peek(graphId) === undefined) {
      try {
        await reload();
      } catch (error) {
        if (context.graphs.peek(graphId) === undefined) {
          context.reportCleanupFailure({
            type: 'graph.cleanup-failed',
            graphId,
            phase: 'routing',
            error: `late-result-reload: ${messageOf(error)}`,
          });
          return;
        }
      }
    }
    await applyToLoaded(context, graphId, nodeId, outcome);
  } finally {
    releaseOld();
  }
}

async function applyToLoaded(
  context: LiveHiveHostContext,
  graphId: LiveHiveId,
  nodeId: NodeId,
  outcome: LateActivationOutcome,
): Promise<void> {
  await context.lock.run(graphId, async () => {
    const live = context.graphs.peek(graphId)?.value;
    if (live === undefined) {
      return;
    }
    try {
      live.runtime.applyRestoredResult(nodeId, outcome);
    } catch (error) {
      context.reportCleanupFailure({
        type: 'graph.cleanup-failed',
        graphId,
        phase: 'routing',
        error: `late-result-apply: ${messageOf(error)}`,
      });
    }
  });
}
