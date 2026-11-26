import {
  GraphNotLoadedError,
  GraphUnloadingError,
  type LiveHiveId,
  type GraphLease,
} from '../../graph/registry.js';
import type { NodeId, Value } from '../../runtime/index.js';
import type { LiveHiveHostContext } from './context.js';
import {
  LiveHiveHostAnswerError,
  LiveHiveHostDisposedError,
  LiveHiveHostNotFoundError,
  type LiveGraph,
} from './types.js';

/**
 * Trigger delivery and answer binding.
 *
 * Both operations hand work to the field and return no identity: a trigger
 * resolves once its Pheromone is enqueued, and an answer resolves once the open
 * hover is bound. Execution continues in the background on that Bee's own
 * drain; the field is the only observable execution state (`inspect`, output,
 * hovers, logs).
 */
export class LiveHiveHostExecution {
  constructor(private readonly context: LiveHiveHostContext) {}

  /**
   * Deliver one Pheromone to a bee. The live lock is deliberately not held
   * across admission: a `block` policy may wait for receptor capacity outside
   * every field lock. The graph lease keeps the live hive loaded for the whole
   * wait. Admission wakes the bee; no host driver follows.
   */
  trigger(graphId: LiveHiveId, nodeId: NodeId, value: Value): Promise<void> {
    if (this.context.disposed) {
      return Promise.reject(new LiveHiveHostDisposedError());
    }
    return admitTrigger(this.context, graphId, nodeId, value);
  }

  /**
   * Bind one answer to the currently open user hover and hand the resulting
   * work to the field. There is no waiting for quiescence and no run result;
   * the caller reads the field when it needs the output.
   */
  answer(
    graphId: LiveHiveId,
    nodeId: NodeId,
    value: Value,
    token?: string,
  ): Promise<void> {
    if (this.context.disposed) {
      return Promise.reject(new LiveHiveHostDisposedError());
    }
    return this.context.lock.run(graphId, () =>
      answerBound(this.context, graphId, nodeId, value, token),
    );
  }
}

async function admitTrigger(
  context: LiveHiveHostContext,
  graphId: LiveHiveId,
  nodeId: NodeId,
  value: Value,
): Promise<void> {
  context.assertNotDisposed();
  const lease = acquireLease(context, graphId);
  try {
    const live = lease.value;
    // `admit` validates the node and enqueues. In block mode it awaits
    // receptor capacity while the lease pins the graph.
    await live.runtime.admit(nodeId, value);
    context.assertNotDisposed();
    touchSessions(context, live);
    if (!live.ephemeral) {
      context.updateCatalog(graphId, 'access', (catalog) => catalog.markAccessed(graphId));
    }
  } finally {
    lease.release();
  }
}

async function answerBound(
  context: LiveHiveHostContext,
  graphId: LiveHiveId,
  nodeId: NodeId,
  value: Value,
  token?: string,
): Promise<void> {
  context.assertNotDisposed();
  const lease = acquireLease(context, graphId);
  try {
    const live = lease.value;
    assertAnswerable(live, graphId, nodeId, token);
    live.runtime.answerHover(nodeId, value, token);
    touchSessions(context, live);
    context.updateCatalog(graphId, 'access', (catalog) => catalog.markAccessed(graphId));
  } finally {
    lease.release();
  }
}

function acquireLease(context: LiveHiveHostContext, graphId: LiveHiveId): GraphLease<LiveGraph> {
  try {
    return context.graphs.acquire(graphId);
  } catch (error) {
    if (error instanceof GraphNotLoadedError || error instanceof GraphUnloadingError) {
      throw new LiveHiveHostNotFoundError(graphId, { cause: error });
    }
    throw error;
  }
}

/**
 * Refresh the idle clock of every session bound to a graph that just ran.
 * Best effort: touching is observability for idle cleanup and must never turn
 * a completed trigger/answer into a failure.
 */
function touchSessions(context: LiveHiveHostContext, live: LiveGraph): void {
  for (const record of live.instantiated.sessions.values()) {
    try {
      context.registry.touch(record.sessionId);
    } catch {
      // The session may have been closed concurrently or its store write may
      // have failed; neither changes the delivery's outcome.
    }
  }
}

/**
 * Reject an answer that does not match the currently open user hover. The
 * control surface answers a parked Pheromone, never seeds a future one.
 */
function assertAnswerable(
  live: LiveGraph,
  graphId: LiveHiveId,
  nodeId: NodeId,
  token: string | undefined,
): void {
  const node = live.definition.nodes.get(nodeId);
  if (node === undefined) {
    throw new LiveHiveHostAnswerError(graphId, nodeId, 'unknown-node');
  }
  if (node.kind !== 'user') {
    throw new LiveHiveHostAnswerError(graphId, nodeId, 'not-user-node');
  }
  const hover = live.runtime.snapshot().nodes[nodeId]?.hover;
  if (hover === undefined || hover.kind !== 'user') {
    throw new LiveHiveHostAnswerError(graphId, nodeId, 'no-hover');
  }
  if (token !== undefined && token !== hover.token) {
    throw new LiveHiveHostAnswerError(graphId, nodeId, 'token-mismatch');
  }
}
