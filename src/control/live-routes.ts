import {
  parseAnswerLiveBody,
  parseDispatchBody,
  parseInstantiateBody,
  parseLiveIdBody,
  parseLoadLiveBody,
  parseMigrateLiveBody,
  parseNewLiveBody,
  parseTemplateBody,
  parseWakeLiveBody,
} from './b-validation.js';
import type { LiveHiveService } from '../b/live-hive-service.js';
import { GraphLoadError } from '../daemon/graph-host.js';
import { isQueuedRun } from '../daemon/session-execution-queue.js';
import { queryParam } from './route-output.js';
import type { ControlServerContext } from './server-context.js';
import type { Route } from './server-types.js';
import { HttpError } from './server-types.js';

/** B operation routes; deliberately separate from the legacy graph routes. */
export async function dispatchLiveRoute(
  context: ControlServerContext,
  route: Route,
  payload: Record<string, unknown> | undefined,
  method?: string,
  rawUrl?: string,
): Promise<Record<string, unknown>> {
  const service = context.requireLiveHiveService();
  switch (route.kind) {
    case 'lives-create':
    case 'lives-load':
    case 'lives-instantiate':
    case 'lives-migrate':
      return dispatchLifecycle(service, route.kind, payload);
    case 'lives-list':
      return { ok: true, lives: service.read.list() };
    case 'lives-wake':
    case 'lives-answer':
      return dispatchLiveRun(service, route.kind, payload);
    case 'lives-save':
    case 'lives-unload':
    case 'lives-inspect':
      return dispatchLiveState(service, route, payload);
    case 'lives-output':
      return dispatchLiveOutput(service, route, rawUrl);
    case 'templates':
    case 'dispatch':
      return dispatchLiveUtility(service, route.kind, payload, method);
    default:
      throw new HttpError(500, 'internal', 'internal error');
  }
}

function dispatchLiveOutput(
  service: LiveHiveService,
  route: Route,
  rawUrl: string | undefined,
): Record<string, unknown> {
  const liveId = route.graphId;
  if (liveId === undefined) {
    throw new HttpError(404, 'not-found', 'not found');
  }
  return {
    ok: true,
    ...service.read.output(liveId, queryParam(rawUrl, 'runId')),
  };
}

async function dispatchLifecycle(
  service: LiveHiveService,
  kind: 'lives-create' | 'lives-load' | 'lives-instantiate' | 'lives-migrate',
  payload: Record<string, unknown> | undefined,
): Promise<Record<string, unknown>> {
  if (kind === 'lives-create') {
    const body = parseNewLiveBody(payload);
    const result = await loadWithConflict(service, body.live.liveId, () =>
      service.new(body.live, body.project),
    );
    return { ok: true, liveId: result.liveId, status: result.status };
  }
  if (kind === 'lives-load') {
    const body = parseLoadLiveBody(payload);
    const result = await loadWithConflict(service, body.liveId, () =>
      service.load(body.liveId, body.live ?? body.path, body.project),
    );
    return { ok: true, liveId: result.liveId, status: result.status };
  }
  if (kind === 'lives-instantiate') {
    const body = parseInstantiateBody(payload);
    const result = await loadWithConflict(service, body.liveId, () =>
      service.instantiate(body.templateId, body.liveId, body.overrides, body.project),
    );
    return { ok: true, liveId: result.liveId, status: result.status };
  }
  const body = parseMigrateLiveBody(payload);
  const result = await service.migrate(body.liveId, body.hive, body.project);
  return { ok: true, liveId: result.liveId, status: result.status };
}

async function dispatchLiveRun(
  service: LiveHiveService,
  kind: 'lives-wake' | 'lives-answer',
  payload: Record<string, unknown> | undefined,
): Promise<Record<string, unknown>> {
  if (kind === 'lives-wake') {
    const body = parseWakeLiveBody(payload);
    const result = await service.wake(body.liveId, body.beeId, body.input);
    if (isQueuedRun(result)) {
      // MVP keeps the success channel at 200 and distinguishes a queued wake
      // in the body. There is deliberately no 202 path.
      return {
        ok: true,
        status: result.status,
        queueId: result.queueId,
        position: result.position,
      };
    }
    return { ok: true, result };
  }
  const body = parseAnswerLiveBody(payload);
  return {
    ok: true,
    result: await service.answer(body.liveId, body.beeId, body.input, body.token),
  };
}

async function dispatchLiveState(
  service: LiveHiveService,
  route: Route,
  payload: Record<string, unknown> | undefined,
): Promise<Record<string, unknown>> {
  if (route.kind === 'lives-save') {
    const body = parseLiveIdBody(payload);
    return { ok: true, status: await service.save(body.liveId) };
  }
  if (route.kind === 'lives-unload') {
    const body = parseLiveIdBody(payload);
    const unloaded = await service.unload(body.liveId);
    if (!unloaded) {
      const status = currentStatus(service, body.liveId);
      if (status === undefined) {
        throw new HttpError(404, 'not-found', 'live hive is not loaded');
      }
      throw new HttpError(409, 'conflict', 'live hive is not unloadable', {
        body: { status },
      });
    }
    return { ok: true, unloaded: true };
  }
  const liveId = route.graphId;
  if (liveId === undefined) {
    throw new HttpError(404, 'not-found', 'not found');
  }
  const inspected = service.read.inspect(liveId);
  return {
    ok: true,
    liveId: inspected.liveId,
    ...(inspected.status === undefined ? {} : { status: inspected.status }),
    outputs: inspected.outputs,
    ...(inspected.catalog === undefined ? {} : { catalog: inspected.catalog }),
  };
}

function currentStatus(service: LiveHiveService, liveId: string) {
  try {
    return service.read.inspect(liveId).status;
  } catch {
    return undefined;
  }
}

async function loadWithConflict<T>(
  service: LiveHiveService,
  liveId: string,
  load: () => Promise<T>,
): Promise<T> {
  const current = currentStatus(service, liveId);
  if (current !== undefined) {
    throw new HttpError(409, 'conflict', 'live hive is already loaded', {
      body: { status: current },
    });
  }
  try {
    return await load();
  } catch (error) {
    if (error instanceof GraphLoadError) {
      const status = currentStatus(service, liveId);
      throw new HttpError(409, 'conflict', 'live hive is already loaded', {
        ...(status === undefined ? {} : { body: { status } }),
      });
    }
    throw error;
  }
}

async function dispatchLiveUtility(
  service: LiveHiveService,
  kind: 'templates' | 'dispatch',
  payload: Record<string, unknown> | undefined,
  method?: string,
): Promise<Record<string, unknown>> {
  if (kind === 'templates') {
    if (method === 'GET') {
      return { ok: true, templates: service.listTemplates() };
    }
    const body = parseTemplateBody(payload);
    const template = service.compose(body.template);
    return { ok: true, templateId: template.templateId };
  }
  const body = parseDispatchBody(payload);
  const result = await service.dispatchService.dispatch(body.input, {
    ...(body.sessionParams === undefined ? {} : { sessionParams: body.sessionParams }),
    ...(body.sessionId === undefined ? {} : { sessionId: body.sessionId }),
    ...(body.timeoutMs === undefined ? {} : { timeoutMs: body.timeoutMs }),
    ...(body.project === undefined ? {} : { project: body.project }),
  });
  return { ok: true, output: result.output, sessionId: result.sessionId };
}

export const LIVE_ROUTE_KINDS = new Set<Route['kind']>([
  'lives-create',
  'lives-list',
  'lives-load',
  'lives-instantiate',
  'lives-wake',
  'lives-answer',
  'lives-save',
  'lives-unload',
  'lives-migrate',
  'lives-inspect',
  'lives-output',
  'templates',
  'dispatch',
]);
