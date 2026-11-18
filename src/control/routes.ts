import {
  GraphAnswerError,
  GraphHost,
  GraphLoadError,
  GraphNotFoundError,
  type LoadGraphOptions,
} from '../daemon/graph-host.js';
import { GraphManifestError, loadGraphManifest, type ManifestLoadSpec } from '../graph/manifest.js';
import { GraphAlreadyLoadedError } from '../graph/registry.js';
import { parseComposition, QueueFullError } from '../runtime/index.js';
import { BindingValidationError } from '../session/instantiate-foragers.js';
import { SessionBusyError, SessionNotFoundError } from '../session/session-registry.js';
import { GuardAlreadySettledError, GuardNotFoundError } from './guard-broker.js';
import { dispatchLiveRoute } from './live-routes.js';
import {
  ANSWERABLE_NODE_KINDS,
  TRIGGERABLE_NODE_KINDS,
} from './server-constants.js';
import type { ControlServerContext } from './server-context.js';
import type { LazyLoadRequest, Route } from './server-types.js';
import { HttpError } from './server-types.js';
import {
  assertExactFields,
  parseAnswerBody,
  parseBindings,
  parseGuardDecision,
  parseLoadBody,
  parseSessionCloseBody,
  parseTriggerBody,
  parseUnloadBody,
  requirePayload,
} from './validation.js';
import { outputBody, queryParam } from './route-output.js';

/** Route dispatch: request validation and the `/health`/graph/session surface. */
export class ControlRoutes {
  constructor(private readonly context: ControlServerContext) {}

  dispatch(
    route: Route,
    payload: Record<string, unknown> | undefined,
    rawUrl?: string,
    method?: string,
  ): Promise<Record<string, unknown>> {
    return dispatchRoutes(this.context, route, payload, rawUrl, method);
  }
}

async function dispatchRoutes(
  context: ControlServerContext,
  route: Route,
  payload: Record<string, unknown> | undefined,
  rawUrl?: string,
  method?: string,
): Promise<Record<string, unknown>> {
  const host = context.requireGraphHost();

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
    case 'status':
      return { ok: true, status: host.status() };
    case 'graph-status': {
      const graphId = route.graphId;
      if (graphId === undefined) {
        throw new HttpError(404, 'not-found', 'not found');
      }
      const status = host.statusOf(graphId);
      if (status === undefined) {
        throw new HttpError(404, 'not-found', 'graph is not loaded');
      }
      return { ok: true, status };
    }
    case 'graph-output': {
      const graphId = route.graphId;
      if (graphId === undefined) {
        throw new HttpError(404, 'not-found', 'not found');
      }
      const runId = queryParam(rawUrl, 'runId');
      if (runId !== undefined) {
        const record = context.runStore?.get(runId);
        if (record === undefined || record.liveId !== graphId) {
          throw new HttpError(404, 'not-found', 'unknown run');
        }
        return outputBody(record);
      }
      const latest = context.runStore?.latestForLive(graphId);
      if (latest !== undefined) {
        return outputBody(latest);
      }
      // No run has been written yet. A loaded graph still exposes its live
      // snapshot; an unloaded graph without a run is a 404 as before.
      const outputs = host.outputsOf(graphId);
      const ordered = [...outputs.entries()]
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([nodeId, value]) => ({ nodeId, value }));
      return { ok: true, graphId, outputs: ordered };
    }
    case 'load': {
      const loadOptions = parseLoadBody(requirePayload(payload));
      try {
        const status = await host.loadGraph(loadOptions);
        return { ok: true, status };
      } catch (error) {
        if (error instanceof GraphLoadError) {
          const current = host.statusOf(error.graphId);
          // GraphHost reports a duplicate either through the registry cause
          // or the message; the loaded status is the strongest signal.
          const duplicate =
            current !== undefined ||
            error.cause instanceof GraphAlreadyLoadedError ||
            /already loaded/i.test(error.message);
          if (duplicate) {
            throw new HttpError(409, 'conflict', 'graph is already loaded', {
              ...(current === undefined ? {} : { body: { status: current } }),
            });
          }
        }
        throw error;
      }
    }
    case 'trigger': {
      const trigger = parseTriggerBody(requirePayload(payload));
      let current = host.statusOf(trigger.graphId);
      if (current === undefined) {
        const graphRef = trigger.graphRef;
        if (graphRef === undefined) {
          throw new HttpError(404, 'not-found', 'graph is not loaded');
        }
        await loadGraphFromRef(host, {
          graphId: trigger.graphId,
          nodeId: trigger.nodeId,
          graphRef,
          allowedNodeKinds: TRIGGERABLE_NODE_KINDS,
          nodeErrorMessage: 'unknown or untriggerable node',
        });
        current = host.statusOf(trigger.graphId);
        if (current === undefined) {
          throw new HttpError(500, 'internal', 'internal error');
        }
      }
      const node = current.nodes.find((candidate) => candidate.nodeId === trigger.nodeId);
      if (node === undefined || !TRIGGERABLE_NODE_KINDS.includes(node.kind)) {
        throw new HttpError(400, 'bad-request', 'unknown or untriggerable node');
      }
      try {
        const result = await host.trigger(trigger.graphId, trigger.nodeId, trigger.value);
        return { ok: true, result };
      } catch (error) {
        if (error instanceof GraphNotFoundError) {
          throw new HttpError(404, 'not-found', 'graph is not loaded');
        }
        if (error instanceof QueueFullError) {
          throw new HttpError(409, 'conflict', 'graph queue is full');
        }
        if (error instanceof TypeError) {
          throw new HttpError(400, 'bad-request', 'invalid trigger value');
        }
        throw error;
      }
    }
    case 'answer': {
      const answer = parseAnswerBody(requirePayload(payload));
      let current = host.statusOf(answer.graphId);
      if (current === undefined) {
        const graphRef = answer.graphRef;
        if (graphRef === undefined) {
          throw new HttpError(404, 'not-found', 'graph is not loaded');
        }
        await loadGraphFromRef(host, {
          graphId: answer.graphId,
          nodeId: answer.nodeId,
          graphRef,
          allowedNodeKinds: ANSWERABLE_NODE_KINDS,
          nodeErrorMessage: 'unknown or unanswerable node',
        });
        current = host.statusOf(answer.graphId);
        if (current === undefined) {
          throw new HttpError(500, 'internal', 'internal error');
        }
      }
      const node = current.nodes.find((candidate) => candidate.nodeId === answer.nodeId);
      if (node === undefined || node.kind !== 'user') {
        throw new HttpError(400, 'bad-request', 'unknown or unanswerable node');
      }
      try {
        const result = await host.answer(
          answer.graphId,
          answer.nodeId,
          answer.value,
          answer.token,
        );
        return { ok: true, result };
      } catch (error) {
        if (error instanceof GraphNotFoundError) {
          throw new HttpError(404, 'not-found', 'graph is not loaded');
        }
        if (error instanceof GraphAnswerError) {
          throw answerErrorToHttp(error);
        }
        if (error instanceof QueueFullError) {
          throw new HttpError(409, 'conflict', 'graph queue is full');
        }
        if (error instanceof TypeError) {
          throw new HttpError(400, 'bad-request', 'invalid answer value');
        }
        throw error;
      }
    }
    case 'unload': {
      const graphId = parseUnloadBody(requirePayload(payload));
      const current = host.statusOf(graphId);
      if (current === undefined) {
        throw new HttpError(404, 'not-found', 'graph is not loaded');
      }
      const unloaded = await host.unload(graphId);
      if (!unloaded) {
        const latest = host.statusOf(graphId);
        if (latest === undefined) {
          throw new HttpError(404, 'not-found', 'graph is not loaded');
        }
        throw new HttpError(409, 'conflict', 'graph is not unloadable', {
          body: { status: latest },
        });
      }
      return { ok: true, unloaded: true };
    }
    case 'sweep': {
      const body = requirePayload(payload);
      assertExactFields(body, [], 'sweep request');
      const report = await context.sweepGraphs();
      return { ok: true, report };
    }
    case 'catalog':
      return { ok: true, entries: host.catalogEntries() };
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
    case 'lives-create':
    case 'lives-list':
    case 'lives-load':
    case 'lives-instantiate':
    case 'lives-wake':
    case 'lives-answer':
    case 'lives-save':
    case 'lives-unload':
    case 'lives-migrate':
    case 'lives-inspect':
    case 'lives-output':
    case 'templates':
    case 'dispatch':
      return dispatchLiveRoute(context, route, payload, method, rawUrl);
  }
}

async function loadGraphFromRef(
  host: GraphHost,
  request: LazyLoadRequest,
): Promise<void> {
  const { graphId, nodeId, graphRef, allowedNodeKinds, nodeErrorMessage } = request;
  let spec: ManifestLoadSpec;
  try {
    spec = loadGraphManifest(graphRef);
  } catch (error) {
    if (error instanceof GraphManifestError) {
      throw new HttpError(400, 'bad-request', 'invalid graph manifest');
    }
    throw error;
  }

  const definition = parseComposition(spec.definition);
  if (definition.id !== graphId) {
    throw new HttpError(400, 'bad-request', 'manifest composition id does not match graphId');
  }
  const node = definition.nodes.get(nodeId);
  if (node === undefined || !allowedNodeKinds.includes(node.kind)) {
    throw new HttpError(400, 'bad-request', nodeErrorMessage);
  }

  const bindings = parseBindings(spec.bindings);
  const loadOptions: LoadGraphOptions = {
    definition,
    bindings,
    project: spec.project,
    defaultHarness: spec.harness,
    ...(spec.idleTtlMs === undefined ? {} : { idleTtlMs: spec.idleTtlMs }),
  };
  try {
    await host.loadGraph(loadOptions);
  } catch (error) {
    if (error instanceof BindingValidationError) {
      throw new HttpError(400, 'bad-request', 'invalid graph bindings');
    }
    if (error instanceof GraphLoadError) {
      throw new HttpError(409, 'conflict', 'graph is already loaded');
    }
    throw error;
  }
}

export function answerErrorToHttp(error: GraphAnswerError): HttpError {
  switch (error.reason) {
    case 'unknown-node':
    case 'not-user-node':
      return new HttpError(400, 'bad-request', 'unknown or unanswerable node');
    case 'no-hover':
    case 'token-mismatch':
      return new HttpError(409, 'conflict', 'hover is not open');
  }
}
