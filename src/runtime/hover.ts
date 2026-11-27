import { randomUUID } from 'node:crypto';

import type { EngineContext } from './engine-context.js';
import { emitAlong } from './emit.js';
import type { GuardDecision, GuardRequest, GuardResolution } from './executor.js';
import { logHoverBlocked } from './runtime-log.js';
import { markChanged, queueDepth, stateOf } from './queue.js';
import { ReceptorFullError } from './receptor-overflow.js';
import { cloneJson } from './value-paths.js';
import type { HoverSpec, Pheromone, UserNode, Value } from './types.js';

/** Opens a user hover; the parked Pheromone stays part of the field. */
export function openUserHover(
  ctx: EngineContext,
  node: UserNode,
  pheromone: Pheromone,
): void {
  const state = ctx.states.get(node.id);
  if (state === undefined) {
    throw new Error(`unknown node '${node.id}'`);
  }
  const hover: HoverSpec = {
    token: `hv_${randomUUID()}`,
    kind: 'user',
    compositionId: ctx.definition.id,
    nodeId: node.id,
  };
  state.hover = hover;
  state.hoverPheromone = pheromone;
  markChanged(ctx.queue);
  ctx.log({ event: 'hover.opened', nodeId: node.id, nodeKind: 'user' });
}

/**
 * Resolves one user hover and moves the answered value along the beeline.
 * The downstream capacity is checked before the hover is consumed: when it is
 * full the hover stays answerable and the typed receptor error is thrown.
 */
export function completeHover(
  ctx: EngineContext,
  node: UserNode,
  pheromone: Pheromone,
  value: Value,
  outcome: string,
): void {
  const state = ctx.states.get(node.id);
  if (state === undefined) {
    throw new Error(`unknown node '${node.id}'`);
  }
  assertAnswerCapacity(ctx, node, outcome);
  delete state.hover;
  delete state.hoverPheromone;
  markChanged(ctx.queue);
  ctx.log({ event: 'hover.resolved', nodeId: node.id, nodeKind: 'user', outcome });
  pheromone.value = value;
  state.lastOutput = cloneJson(value);
  emitAlong(ctx, node, pheromone);
}

function assertAnswerCapacity(
  ctx: EngineContext,
  node: UserNode,
  outcome: string,
): void {
  const edge = ctx.definition.edges.find((candidate) => candidate.from === node.id);
  if (edge === undefined) {
    return;
  }
  const depth = queueDepth(stateOf(ctx.queue, edge.to));
  if (depth < ctx.definition.defaults.queueMax) {
    return;
  }
  logHoverBlocked(ctx.log, ctx.reportedBlocks, node, edge.to, {
    queueDepth: depth,
    hoverOutcome: outcome,
  });
  throw new ReceptorFullError(
    edge.to,
    ctx.definition.defaults.queueMax,
    depth,
    { liveId: ctx.definition.id },
  );
}

/**
 * Opens a Guard hover for one native approval request and resolves with the
 * decision and its timeout provenance. A timeout cancels the request; nothing
 * auto-allows.
 */
export async function requestGuard(
  ctx: EngineContext,
  node: UserNode | import('./types.js').ForagerNode,
  request: GuardRequest,
  decide?: (request: GuardRequest) => Promise<GuardDecision>,
): Promise<GuardResolution> {
  const token = openGuardHover(ctx, node, request);
  const outcome = await waitForGuard(ctx, node, token, request, decide);
  ctx.log({
    event: outcome.expired ? 'guard.timeout' : 'guard.resolved',
    nodeId: node.id,
    nodeKind: node.kind,
    outcome: outcome.expired ? 'cancelled' : outcome.decision,
  });
  return outcome;
}

function openGuardHover(
  ctx: EngineContext,
  node: UserNode | import('./types.js').ForagerNode,
  request: GuardRequest,
): string {
  const state = ctx.states.get(node.id);
  if (state === undefined) {
    throw new Error(`unknown node '${node.id}'`);
  }
  if (state.hover !== undefined) {
    throw new Error(`node '${node.id}' already has an open hover`);
  }
  const token = `gd_${randomUUID()}`;
  state.hover = {
    token,
    kind: 'guard',
    compositionId: ctx.definition.id,
    nodeId: node.id,
    meta: {
      requestId: request.requestId,
      executionId: request.executionId,
      summary: request.summary,
    },
  };
  markChanged(ctx.queue);
  ctx.log({
    event: 'guard.opened',
    nodeId: node.id,
    nodeKind: node.kind,
    outcome: request.requestId,
  });
  return token;
}

async function waitForGuard(
  ctx: EngineContext,
  node: UserNode | import('./types.js').ForagerNode,
  token: string,
  request: GuardRequest,
  decide?: (request: GuardRequest) => Promise<GuardDecision>,
): Promise<GuardResolution> {
  const state = ctx.states.get(node.id);
  if (state === undefined) {
    throw new Error(`unknown node '${node.id}'`);
  }

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<GuardResolution>((resolve) => {
    timer = setTimeout(() => {
      try {
        ctx.onGuardExpired?.(request.requestId);
      } catch {
        // Best effort; the runtime still cancels and never falls through.
      }
      resolve({ decision: 'cancelled', expired: true });
    }, ctx.guardTimeoutMs);
    timer.unref();
  });

  try {
    const handler = decide ?? ctx.onGuard;
    const decisionPromise: Promise<GuardResolution> =
      handler === undefined
        ? Promise.resolve({ decision: 'reject_once', expired: false })
        : Promise.resolve()
            .then(() => handler({ ...request, beeId: node.id }))
            .then((decision) => ({ decision, expired: false }))
            .catch(() => ({ decision: 'reject_once' as GuardDecision, expired: false }));
    return await Promise.race([decisionPromise, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (state.hover?.token === token) {
      delete state.hover;
      markChanged(ctx.queue);
    }
  }
}
