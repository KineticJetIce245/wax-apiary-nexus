import { randomUUID } from 'node:crypto';

import {
  GraphNotLoadedError,
  GraphUnloadingError,
  type LiveHiveId,
  type GraphLease,
} from '../../graph/registry.js';
import {
  type CompositionDefinition,
  type NodeId,
  type PheromoneFieldSnapshot,
  type PheromoneRuntime,
  type Value,
} from '../../runtime/index.js';
import type { RunOutput, RunRecord, RunStatus } from '../../storage/run-store.js';
import { messageOf, snapshotHovered } from './context.js';
import type { LiveHiveHostContext } from './context.js';
import { startRunDriver } from './driver.js';
import type { LiveHiveHostRead } from './read.js';
import { earliestDue } from './schedule.js';
import {
  LiveHiveHostAnswerError,
  LiveHiveHostDisposedError,
  LiveHiveHostNotFoundError,
  type LiveHiveAdmission,
  type LiveHiveRunResult,
  type LiveGraph,
} from './types.js';

type GraphRunCore = Omit<LiveHiveRunResult, 'runId' | 'requestId'>;

interface QuiescenceOutcome {
  readonly pumps: number;
  readonly snapshot: PheromoneFieldSnapshot;
  readonly persisted: boolean;
  readonly persistError?: string;
}

interface AnswerOutcome {
  readonly core: GraphRunCore;
  readonly traceId?: string;
}

/** Trigger admission and synchronous answer execution. */
export class LiveHiveHostExecution {
  constructor(
    private readonly context: LiveHiveHostContext,
    private readonly read: LiveHiveHostRead,
  ) {}

  /**
   * Admit one wake. The host lock covers only the enqueue and run record;
   * native execution is driven afterwards by the per-live runtime pump.
   */
  trigger(graphId: LiveHiveId, nodeId: NodeId, value: Value): Promise<LiveHiveAdmission> {
    if (this.context.disposed) {
      return Promise.reject(new LiveHiveHostDisposedError());
    }
    return this.context.lock
      .run(graphId, () => admitTrigger(this.context, graphId, nodeId, value))
      .then((admission) => {
        startRunDriver(this.context, graphId);
        return admission;
      });
  }

  /**
   * Answers one open user hover. It keeps its synchronous result contract and
   * waits for the trace to quiesce; the downstream trace outputs are read from
   * the run tracker rather than a global forager snapshot.
   */
  answer(
    graphId: LiveHiveId,
    nodeId: NodeId,
    value: Value,
    token?: string,
  ): Promise<LiveHiveRunResult> {
    if (this.context.disposed) {
      return Promise.reject(new LiveHiveHostDisposedError());
    }
    return this.context.lock.run(graphId, () =>
      answerRecorded(this.context, this.read, graphId, nodeId, value, token),
    );
  }
}

async function admitTrigger(
  context: LiveHiveHostContext,
  graphId: LiveHiveId,
  nodeId: NodeId,
  value: Value,
): Promise<LiveHiveAdmission> {
  context.assertNotDisposed();
  const runId = randomUUID();
  const traceId = `tr_${randomUUID()}`;
  const startedAt = isoNow(context);
  const lease = acquireLease(context, graphId);
  try {
    const live = lease.value;
    // The enqueue validates the node before any run becomes visible.
    live.runtime.admit(nodeId, value, traceId);
    context.runs.accept({ liveId: graphId, runId, traceId, operation: 'trigger', startedAt });
    touchSessions(context, live);
    if (!live.ephemeral) {
      context.updateCatalog(graphId, 'access', (catalog) => catalog.markAccessed(graphId));
    }
  } finally {
    lease.release();
  }
  return { graphId, runId, traceId, status: 'accepted' };
}

/** One answer's ids and durable record, generated under the live lock. */
async function answerRecorded(
  context: LiveHiveHostContext,
  read: LiveHiveHostRead,
  graphId: LiveHiveId,
  nodeId: NodeId,
  value: Value,
  token?: string,
): Promise<LiveHiveRunResult> {
  const runId = randomUUID();
  const requestId = randomUUID();
  const startedAt = isoNow(context);
  try {
    const outcome = await answerLocked(context, read, graphId, nodeId, value, token);
    const result: LiveHiveRunResult = { ...outcome.core, runId, requestId };
    saveRun(context, {
      runId,
      requestId,
      liveId: graphId,
      operation: 'answer',
      status: runStatus(outcome.core),
      outputs: outputsForTrace(context, outcome.traceId),
      startedAt,
      finishedAt: isoNow(context),
      ...(outcome.traceId === undefined ? {} : { traceId: outcome.traceId }),
    });
    return result;
  } catch (error) {
    saveRun(context, {
      runId,
      requestId,
      liveId: graphId,
      operation: 'answer',
      status: 'failed',
      outputs: [],
      startedAt,
      finishedAt: isoNow(context),
      error: 'run failed',
    });
    throw error;
  }
}

async function answerLocked(
  context: LiveHiveHostContext,
  read: LiveHiveHostRead,
  graphId: LiveHiveId,
  nodeId: NodeId,
  value: Value,
  token?: string,
): Promise<AnswerOutcome> {
  context.assertNotDisposed();
  const lease = acquireLease(context, graphId);
  let traceId: string | undefined;
  let outcome: QuiescenceOutcome | undefined;
  try {
    const live = lease.value;
    assertAnswerable(live, graphId, nodeId, token);
    traceId = live.runtime.answerHover(nodeId, value, token);
    outcome = await pumpToQuiescence(context, live);
    touchSessions(context, live);
    context.updateCatalog(graphId, 'access', (catalog) => catalog.markAccessed(graphId));
  } finally {
    lease.release();
  }
  if (outcome === undefined) {
    throw new LiveHiveHostNotFoundError(graphId);
  }
  return { core: resultOf(read, graphId, outcome), ...(traceId === undefined ? {} : { traceId }) };
}

function outputsForTrace(
  context: LiveHiveHostContext,
  traceId: string | undefined,
): readonly RunOutput[] {
  return traceId === undefined ? [] : [...context.runs.outputsForTrace(traceId)];
}

function saveRun(context: LiveHiveHostContext, record: Omit<RunRecord, 'schemaVersion'>): void {
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

function isoNow(context: LiveHiveHostContext): string {
  return new Date(context.now()).toISOString();
}

function resultOf(
  read: LiveHiveHostRead,
  graphId: LiveHiveId,
  outcome: QuiescenceOutcome,
): GraphRunCore {
  const status = read.statusOf(graphId);
  if (status === undefined) {
    throw new LiveHiveHostNotFoundError(graphId);
  }
  return {
    graphId,
    rest: outcome.snapshot.rest,
    hovered: snapshotHovered(outcome.snapshot),
    pumps: outcome.pumps,
    status,
    persisted: outcome.persisted,
    ...(outcome.persistError === undefined ? {} : { persistError: outcome.persistError }),
  };
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
      // have failed; neither changes the run's result.
    }
  }
}

/**
 * Pumps to Rest/a hover, then flushes Honey. The caller holds the lease, so a
 * TTL sweep cannot unload between the last pump and the flush.
 */
async function pumpToQuiescence(
  context: LiveHiveHostContext,
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

function runStatus(result: GraphRunCore): RunStatus {
  if (result.rest) {
    return 'completed';
  }
  return result.hovered ? 'hovered' : 'incomplete';
}
