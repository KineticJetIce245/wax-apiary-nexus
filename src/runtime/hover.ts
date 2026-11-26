import { randomUUID } from 'node:crypto';

import type { EngineContext } from './engine-context.js';
import { emitAlong } from './emit.js';
import type { GuardDecision, GuardRequest } from './executor.js';
import { logHoverBlocked } from './runtime-log.js';
import {
  releaseReservation,
  tryReserve,
  type OutputReservation,
} from './queue.js';
import { ReceptorFullError } from './receptor-overflow.js';
import { cloneJson } from './value-paths.js';
import type { HoverSpec, Pheromone, UserNode, Value } from './types.js';

/** A Guard decision that does not belong to the current request. */
export class GuardDecisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GuardDecisionError';
  }
}

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
  ctx.log({ event: 'hover.opened', nodeId: node.id, nodeKind: 'user' });
}

/**
 * Resolves one user hover and moves the answered value along the beeline.
 * The downstream queue is reserved before the hover is consumed: when it is
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
  const reservation = reserveAnswer(ctx, node, pheromone, outcome);
  try {
    delete state.hover;
    delete state.hoverPheromone;
    ctx.log({ event: 'hover.resolved', nodeId: node.id, nodeKind: 'user', outcome });
    pheromone.value = value;
    state.lastOutput = cloneJson(value);
    emitAlong(ctx, node, pheromone, undefined, reservation ?? undefined);
  } finally {
    if (reservation !== undefined) {
      releaseReservation(ctx.queue, reservation);
    }
  }
}

function reserveAnswer(
  ctx: EngineContext,
  node: UserNode,
  pheromone: Pheromone,
  outcome: string,
): OutputReservation | undefined {
  const edge = ctx.definition.edges.find((candidate) => candidate.from === node.id);
  if (edge === undefined) {
    return undefined;
  }
  const reserved = tryReserve(ctx.queue, [{ targetId: edge.to, count: 1 }]);
  if (reserved.ok) {
    return reserved.reservation;
  }
  logHoverBlocked(ctx.log, ctx.reportedBlocks, node, reserved.target, {
    queueDepth: reserved.queueDepth,
    hoverOutcome: outcome,
  });
  throw new ReceptorFullError(
    reserved.target,
    ctx.definition.defaults.queueMax,
    reserved.queueDepth,
    { liveId: ctx.definition.id },
  );
}

/**
 * Opens a Guard hover for one native approval request and resolves with the
 * decision. A timeout cancels the request; nothing auto-allows.
 */
export async function requestGuard(
  ctx: EngineContext,
  node: UserNode | import('./types.js').ForagerNode,
  request: GuardRequest,
  decide?: (request: GuardRequest) => Promise<GuardDecision>,
): Promise<GuardDecision> {
  const token = openGuardHover(ctx, node, request);
  const outcome = await waitForGuard(ctx, node, token, request, decide);
  ctx.log({
    event: outcome.expired ? 'guard.timeout' : 'guard.resolved',
    nodeId: node.id,
    nodeKind: node.kind,
    outcome: outcome.expired ? 'cancelled' : outcome.decision,
  });
  return outcome.decision;
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
    throw new GuardDecisionError(`node '${node.id}' already has an open hover`);
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
  ctx.log({
    event: 'guard.opened',
    nodeId: node.id,
    nodeKind: node.kind,
    outcome: request.requestId,
  });
  return token;
}

interface GuardOutcome {
  readonly decision: GuardDecision;
  readonly expired: boolean;
}

async function waitForGuard(
  ctx: EngineContext,
  node: UserNode | import('./types.js').ForagerNode,
  token: string,
  request: GuardRequest,
  decide?: (request: GuardRequest) => Promise<GuardDecision>,
): Promise<GuardOutcome> {
  const state = ctx.states.get(node.id);
  if (state === undefined) {
    throw new Error(`unknown node '${node.id}'`);
  }
  let resolveWaiter: (decision: GuardDecision) => void = () => undefined;
  const waiter = new Promise<GuardDecision>((resolve) => {
    resolveWaiter = resolve;
  });
  ctx.guardWaiters.set(token, { requestId: request.requestId, resolve: resolveWaiter });
  let expired = false;
  const timer = setTimeout(() => {
    try {
      ctx.onGuardExpired?.(request.requestId);
    } catch {
      // Best effort; the runtime still cancels and never falls through.
    }
    expired = true;
    resolveWaiter('cancelled');
  }, ctx.guardTimeoutMs);
  timer.unref();

  try {
    const handler = decide ?? ctx.onGuard;
    const decisionPromise =
      handler === undefined
        ? Promise.resolve<GuardDecision>('reject_once')
        : Promise.resolve().then(() => handler({ ...request, beeId: node.id })).catch(
            () => 'reject_once' as GuardDecision,
          );
    const decision = await Promise.race([decisionPromise, waiter]);
    return { decision, expired };
  } finally {
    clearTimeout(timer);
    ctx.guardWaiters.delete(token);
    if (state.hover?.token === token) {
      delete state.hover;
    }
  }
}

/**
 * Settles the open Guard for `requestId`. An early, late or mismatched
 * decision is rejected so it can never land on a different request.
 */
export function settleGuard(
  ctx: EngineContext,
  nodeId: string,
  requestId: string,
  decision: GuardDecision,
): void {
  const state = ctx.states.get(nodeId);
  const hover = state?.hover;
  if (hover === undefined || hover.kind !== 'guard' || hover.meta?.['requestId'] !== requestId) {
    throw new GuardDecisionError(`no open guard for request '${requestId}' on node '${nodeId}'`);
  }
  const waiter = ctx.guardWaiters.get(hover.token);
  if (waiter === undefined || waiter.requestId !== requestId) {
    throw new GuardDecisionError(`guard for request '${requestId}' is not waiting`);
  }
  ctx.guardWaiters.delete(hover.token);
  waiter.resolve(decision);
}
