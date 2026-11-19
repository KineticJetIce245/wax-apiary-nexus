import { randomUUID } from 'node:crypto';

import {
  GraphNotLoadedError,
  GraphUnloadingError,
  type GraphId,
  type GraphLease,
} from '../../graph/registry.js';
import {
  type CompositionDefinition,
  type NodeId,
  type PheromoneFieldSnapshot,
  type PheromoneRuntime,
  type Value,
} from '../../runtime/index.js';
import type { RunOperation, RunOutput, RunRecord, RunStatus } from '../../storage/run-store.js';
import type { QueuedRun } from '../session-execution-queue.js';
import { messageOf, snapshotHovered } from './context.js';
import type { GraphHostContext } from './context.js';
import type { GraphHostRead } from './read.js';
import {
  GraphAnswerError,
  GraphHostDisposedError,
  GraphNotFoundError,
  type GraphRunResult,
  type LiveGraph,
} from './types.js';

type GraphRunCore = Omit<GraphRunResult, 'runId' | 'requestId'>;

interface QuiescenceOutcome {
  readonly pumps: number;
  readonly snapshot: PheromoneFieldSnapshot;
  readonly persisted: boolean;
  readonly persistError?: string;
}

/** Trigger and answer execution: lock, lease, pump, flush and run record. */
export class GraphHostExecution {
  constructor(
    private readonly context: GraphHostContext,
    private readonly read: GraphHostRead,
  ) {}

  /**
   * Trigger one node. A forager node that already holds a session goes through
   * the per-session execution queue: a free session runs now, a session another
   * loaded LiveHive is executing returns a `QueuedRun` instead of a busy error.
   * Nodes without a session (condition/fork/merge/user/worker) keep the plain
   * per-live lock path.
   */
  trigger(graphId: GraphId, nodeId: NodeId, value: Value): Promise<GraphRunResult | QueuedRun> {
    if (this.context.disposed) {
      return Promise.reject(new GraphHostDisposedError());
    }
    const run = (): Promise<GraphRunResult> =>
      this.context.lock.run(graphId, () =>
        runRecorded(this.context, this.read, graphId, 'trigger', () =>
          triggerLocked(this.context, this.read, graphId, nodeId, value),
        ),
      );
    const sessionId = this.sessionIdOf(graphId, nodeId);
    if (sessionId === undefined) {
      return run();
    }
    return this.context.sessionQueue.start(
      sessionId,
      { liveId: graphId, beeId: nodeId },
      run,
    );
  }

  /**
   * Answers one open user hover. It is refused instead of queued when no user
   * hover is open; the run holds the lease and flushes Honey like `trigger`.
   */
  answer(
    graphId: GraphId,
    nodeId: NodeId,
    value: Value,
    token?: string,
  ): Promise<GraphRunResult> {
    if (this.context.disposed) {
      return Promise.reject(new GraphHostDisposedError());
    }
    return this.context.lock.run(graphId, () =>
      runRecorded(this.context, this.read, graphId, 'answer', () =>
        answerLocked(this.context, this.read, graphId, nodeId, value, token),
      ),
    );
  }

  /**
   * The session a trigger would execute on, read without taking any lock.
   * Only forager nodes have one; the map is immutable after a load.
   */
  private sessionIdOf(graphId: GraphId, nodeId: NodeId): string | undefined {
    const live = this.context.graphs.peek(graphId)?.value;
    return live?.instantiated.sessions.get(nodeId)?.sessionId;
  }
}

async function triggerLocked(
  context: GraphHostContext,
  read: GraphHostRead,
  graphId: GraphId,
  nodeId: NodeId,
  value: Value,
): Promise<GraphRunCore> {
  context.assertNotDisposed();
  const lease = acquireLease(context, graphId);
  let outcome: QuiescenceOutcome | undefined;
  try {
    const live = lease.value;
    live.runtime.trigger(nodeId, value);
    outcome = await pumpToQuiescence(context, live);
    touchSessions(context, live);
    context.updateCatalog(graphId, 'access', (catalog) => catalog.markAccessed(graphId));
  } finally {
    lease.release();
  }

  if (outcome === undefined) {
    // Unreachable: `pumpToQuiescence` either returns or throws.
    throw new GraphNotFoundError(graphId);
  }
  return resultOf(read, graphId, outcome);
}

async function answerLocked(
  context: GraphHostContext,
  read: GraphHostRead,
  graphId: GraphId,
  nodeId: NodeId,
  value: Value,
  token?: string,
): Promise<GraphRunCore> {
  context.assertNotDisposed();
  const lease = acquireLease(context, graphId);
  let outcome: QuiescenceOutcome | undefined;
  try {
    const live = lease.value;
    assertAnswerable(live, graphId, nodeId, token);
    live.runtime.answerHover(nodeId, value, token);
    outcome = await pumpToQuiescence(context, live);
    touchSessions(context, live);
    context.updateCatalog(graphId, 'access', (catalog) => catalog.markAccessed(graphId));
  } finally {
    lease.release();
  }

  if (outcome === undefined) {
    // Unreachable: `pumpToQuiescence` either returns or throws.
    throw new GraphNotFoundError(graphId);
  }
  return resultOf(read, graphId, outcome);
}

/** One mutating run's ids and durable record, generated under the live lock. */
async function runRecorded(
  context: GraphHostContext,
  read: GraphHostRead,
  graphId: GraphId,
  operation: RunOperation,
  execute: () => Promise<GraphRunCore>,
): Promise<GraphRunResult> {
  const runId = randomUUID();
  const requestId = randomUUID();
  const startedAt = isoNow(context);
  try {
    const core = await execute();
    const result: GraphRunResult = { ...core, runId, requestId };
    saveRun(context, {
      runId,
      requestId,
      liveId: graphId,
      operation,
      status: runStatus(core),
      outputs: snapshotOutputs(read, graphId),
      startedAt,
      finishedAt: isoNow(context),
    });
    return result;
  } catch (error) {
    saveRun(context, {
      runId,
      requestId,
      liveId: graphId,
      operation,
      status: 'failed',
      outputs: [],
      startedAt,
      finishedAt: isoNow(context),
      error: 'run failed',
    });
    throw error;
  }
}

function saveRun(context: GraphHostContext, record: Omit<RunRecord, 'schemaVersion'>): void {
  const runStore = context.runStore;
  if (runStore === undefined) {
    return;
  }
  try {
    runStore.save({ schemaVersion: 1, ...record });
  } catch (error) {
    context.reportCleanupFailure({
      type: 'graph.run-store-failed',
      graphId: record.liveId,
      runId: record.runId,
      error: messageOf(error),
    });
  }
}

function snapshotOutputs(read: GraphHostRead, graphId: GraphId): readonly RunOutput[] {
  try {
    return [...read.outputsOf(graphId).entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([nodeId, value]) => ({ nodeId, value }));
  } catch {
    return [];
  }
}

function isoNow(context: GraphHostContext): string {
  return new Date(context.now()).toISOString();
}

function resultOf(
  read: GraphHostRead,
  graphId: GraphId,
  outcome: QuiescenceOutcome,
): GraphRunCore {
  const status = read.statusOf(graphId);
  if (status === undefined) {
    throw new GraphNotFoundError(graphId);
  }
  return {
    graphId,
    rest: outcome.snapshot.rest,
    hovered: snapshotHovered(outcome.snapshot),
    pumps: outcome.pumps,
    status,
    persisted: outcome.persisted,
    ...(outcome.persistError === undefined
      ? {}
      : { persistError: outcome.persistError }),
  };
}

function acquireLease(context: GraphHostContext, graphId: GraphId): GraphLease<LiveGraph> {
  try {
    return context.graphs.acquire(graphId);
  } catch (error) {
    if (error instanceof GraphNotLoadedError || error instanceof GraphUnloadingError) {
      throw new GraphNotFoundError(graphId, { cause: error });
    }
    throw error;
  }
}

/**
 * Refresh the idle clock of every session bound to a graph that just ran.
 * Best effort: touching is observability for idle cleanup and must never turn
 * a completed trigger/answer into a failure.
 */
function touchSessions(context: GraphHostContext, live: LiveGraph): void {
  for (const record of live.instantiated.sessions.values()) {
    try {
      context.registry.touch(record.sessionId);
    } catch {
      // The session may have been closed concurrently or its store write may
      // have failed; neither changes the run's result.
    }
  }
}

/**
 * Pumps to Rest/a hover, then flushes Honey. The caller holds the lease, so a
 * TTL sweep cannot unload between the last pump and the flush.
 */
async function pumpToQuiescence(
  context: GraphHostContext,
  live: LiveGraph,
): Promise<QuiescenceOutcome> {
  let pumps = 0;
  let waitedMs = 0;
  let snapshot = live.runtime.snapshot();
  let persisted = true;
  let persistError: string | undefined;

  while (pumps < context.maxPumps && !snapshot.rest && !snapshotHovered(snapshot)) {
    await live.runtime.pump();
    pumps += 1;
    snapshot = live.runtime.snapshot();
    if (snapshot.rest || snapshotHovered(snapshot) || pumps >= context.maxPumps) {
      break;
    }

    const due = earliestDue(live.definition, live.runtime, snapshot);
    if (due === undefined) {
      break;
    }
    const remainingWaitMs = context.maxWaitMs - waitedMs;
    if (remainingWaitMs <= 0) {
      break;
    }
    const current = context.now();
    const dueInMs = due > current ? due - current : 0;
    if (dueInMs <= 0) {
      // Do not 0ms-spin: a due instant in the past means backpressure or
      // an already-expired wake signal, not work a new pump can finish.
      break;
    }
    const waitMs = Math.min(dueInMs, remainingWaitMs);
    if (waitMs <= 0) {
      break;
    }
    await context.sleep(waitMs);
    waitedMs += waitMs;
  }

  if (live.honey !== undefined) {
    try {
      await live.honey.save(live.runtime.exportField());
    } catch (error) {
      persisted = false;
      persistError = messageOf(error);
    }
  }

  return {
    pumps,
    snapshot,
    persisted,
    ...(persistError === undefined ? {} : { persistError }),
  };
}

/**
 * Reject an answer that does not match the currently open user hover. The
 * control surface answers a parked Pheromone, never seeds a future one.
 */
function assertAnswerable(
  live: LiveGraph,
  graphId: GraphId,
  nodeId: NodeId,
  token: string | undefined,
): void {
  const node = live.definition.nodes.get(nodeId);
  if (node === undefined) {
    throw new GraphAnswerError(graphId, nodeId, 'unknown-node');
  }
  if (node.kind !== 'user') {
    throw new GraphAnswerError(graphId, nodeId, 'not-user-node');
  }
  const hover = live.runtime.snapshot().nodes[nodeId]?.hover;
  if (hover === undefined || hover.kind !== 'user') {
    throw new GraphAnswerError(graphId, nodeId, 'no-hover');
  }
  if (token !== undefined && token !== hover.token) {
    throw new GraphAnswerError(graphId, nodeId, 'token-mismatch');
  }
}

/** Earliest runtime wake or pending-node due instant. */
function earliestDue(
  definition: CompositionDefinition,
  runtime: PheromoneRuntime,
  snapshot: PheromoneFieldSnapshot,
): number | undefined {
  const runtimeWake = runtime.nextWakeAt();
  const pendingDue = nextPendingAt(definition, snapshot);
  if (runtimeWake === undefined) {
    return pendingDue;
  }
  if (pendingDue === undefined) {
    return runtimeWake;
  }
  return Math.min(runtimeWake, pendingDue);
}

/** Earliest `lastActivatedAt + minIntervalMs` among pending nodes. */
function nextPendingAt(
  definition: CompositionDefinition,
  snapshot: PheromoneFieldSnapshot,
): number | undefined {
  let next: number | undefined;
  for (const [id, node] of definition.nodes) {
    const state = snapshot.nodes[id];
    if (state?.pending === undefined) {
      continue;
    }
    const last = state.lastActivatedAt;
    const due = last === undefined ? 0 : Date.parse(last) + node.minIntervalMs;
    if (!Number.isFinite(due)) {
      continue;
    }
    if (next === undefined || due < next) {
      next = due;
    }
  }
  return next;
}

function runStatus(result: GraphRunCore): RunStatus {
  if (result.rest) {
    return 'completed';
  }
  return result.hovered ? 'hovered' : 'incomplete';
}
