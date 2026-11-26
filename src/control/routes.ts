import { SessionBusyError, SessionNotFoundError } from '../session/session-registry.js';
import {
  GuardAlreadySettledError,
  GuardExpiredError,
  GuardNotFoundError,
} from './guard-broker.js';
import { dispatchLiveRoute, LIVE_ROUTE_KINDS } from './live-routes.js';
import type { ControlServerContext } from './server-context.js';
import type { Route, RouteReply } from './server-types.js';
import { HttpError } from './server-types.js';
import {
  assertExactFields,
  parseGuardDecision,
  parseSessionCloseBody,
  requirePayload,
} from './validation.js';

/** Route dispatch for the B surface plus health, guards and sessions. */
export class ControlRoutes {
  constructor(private readonly context: ControlServerContext) {}

  dispatch(
    route: Route,
    payload: Record<string, unknown> | undefined,
    method?: string,
  ): Promise<Record<string, unknown> | RouteReply> {
    return dispatchRoutes(this.context, route, payload, method);
  }
}

async function dispatchRoutes(
  context: ControlServerContext,
  route: Route,
  payload: Record<string, unknown> | undefined,
  method?: string,
): Promise<Record<string, unknown> | RouteReply> {
  const host = context.requireLiveHiveHost();
  if (LIVE_ROUTE_KINDS.has(route.kind)) {
    return dispatchLiveRoute(context, route, payload, method);
  }

  switch (route.kind) {
    case 'health': {
      const info = context.currentInfo;
      if (info === undefined) {
        throw new HttpError(500, 'internal', 'internal error');
      }
      return {
        ok: true,
        harnesses: context.registry.harnesses(),
        pid: process.pid,
        startedAt: info.startedAt,
      };
    }
    case 'guards':
      return { ok: true, guards: context.guardBroker?.list() ?? [] };
    case 'guard-decide': {
      const broker = context.guardBroker;
      if (broker === undefined) {
        throw new HttpError(500, 'internal', 'internal error');
      }
      const { requestId, decision } = parseGuardDecision(requirePayload(payload));
      try {
        broker.decide(requestId, decision);
      } catch (error) {
        if (error instanceof GuardNotFoundError) {
          throw new HttpError(404, 'not-found', 'unknown guard request');
        }
        if (error instanceof GuardExpiredError) {
          throw new HttpError(409, 'guard-expired', 'guard request expired');
        }
        if (error instanceof GuardAlreadySettledError) {
          throw new HttpError(409, 'conflict', 'guard request already settled');
        }
        throw error;
      }
      return { ok: true, requestId, decision };
    }
    case 'sessions': {
      const registry = context.registry;
      const bound = host.loadedSessionIds();
      return {
        ok: true,
        sessions: registry.list().map((record) => ({
          sessionId: record.sessionId,
          harness: record.harness,
          projectId: record.projectId,
          busy: registry.isBusy(record.sessionId),
          bound: bound.has(record.sessionId),
        })),
      };
    }
    case 'session-close': {
      const sessionId = parseSessionCloseBody(requirePayload(payload));
      const registry = context.registry;
      if (registry.get(sessionId) === undefined) {
        throw new HttpError(404, 'not-found', 'unknown session');
      }
      if (registry.isBusy(sessionId)) {
        throw new HttpError(409, 'conflict', 'session is busy');
      }
      if (host.loadedSessionIds().has(sessionId)) {
        throw new HttpError(409, 'conflict', 'session is bound to a loaded graph');
      }
      try {
        await registry.close(sessionId);
      } catch (error) {
        if (error instanceof SessionNotFoundError) {
          throw new HttpError(404, 'not-found', 'unknown session');
        }
        if (error instanceof SessionBusyError) {
          throw new HttpError(409, 'conflict', 'session is busy');
        }
        throw new HttpError(500, 'internal', 'internal error');
      }
      return { ok: true, closed: true };
    }
    case 'session-sweep': {
      const body = requirePayload(payload);
      assertExactFields(body, [], 'session sweep request');
      const report = await context.sweepIdleSessions();
      return { ok: true, report };
    }
  }
  throw new HttpError(500, 'internal', 'internal error');
}
