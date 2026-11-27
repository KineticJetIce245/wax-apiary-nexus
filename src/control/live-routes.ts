import {
  parseAnswerLiveBody,
  parseDispatchBody,
  parseInstantiateBody,
  parseLiveIdBody,
  parseLoadLiveBody,
  parseMigrateLiveBody,
  parseNewLiveBody,
  parseTemplateBody,
  parseTriggerLiveBody,
} from './b-validation.js';
import type { LiveHiveService } from '../b/live-hive-service.js';
import { toPublicStatus } from '../b/public-status.js';
import { LiveHiveHostLoadError } from '../daemon/graph-host.js';
import { HoneyIncompatibleError } from '../runtime/index.js';
import type { ControlServerContext } from './server-context.js';
import type { Route } from './server-types.js';
import { HttpError, RouteReply } from './server-types.js';

/** B operation routes; separate from the current control route table. */
export async function dispatchLiveRoute(
  context: ControlServerContext,
  route: Route,
  payload: Record<string, unknown> | undefined,
  method?: string,
): Promise<Record<string, unknown> | RouteReply> {
  const service = context.requireLiveHiveService();
  if (LIVE_STATE_KINDS.has(route.kind)) {
    return dispatchLiveState(service, route, payload);
  }
  switch (route.kind) {
    case 'lives-create':
    case 'lives-load':
    case 'lives-instantiate':
    case 'lives-migrate':
      return dispatchLifecycle(service, route.kind, payload);
    case 'lives-list':
      return listLives(service);
    case 'lives-trigger':
    case 'lives-answer':
      return dispatchLiveDelivery(service, route.kind, payload);
    case 'lives-output':
      return dispatchLiveOutput(service, route);
    case 'templates':
    case 'dispatch':
      return dispatchLiveUtility(service, route.kind, payload, method);
  }
  throw new HttpError(500, 'internal', 'internal error');
}

const LIVE_STATE_KINDS = new Set<Route['kind']>([
  'lives-save',
  'lives-unload',
  'lives-inspect',
]);

function listLives(service: LiveHiveService): Record<string, unknown> {
  return {
    ok: true,
    lives: service.read.list().map((entry) => ({
      liveId: entry.liveId,
      state: entry.state,
      ...(entry.status === undefined
        ? {}
        : { status: toPublicStatus(entry.status) }),
      ...(entry.catalog === undefined ? {} : { catalog: entry.catalog }),
    })),
  };
}

function dispatchLiveOutput(
  service: LiveHiveService,
  route: Route,
): Record<string, unknown> {
  const liveId = route.graphId;
  if (liveId === undefined) {
    throw new HttpError(404, 'not-found', 'not found');
  }
  return {
    ok: true,
    ...service.read.output(liveId),
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
    return { ok: true, liveId: result.liveId, status: toPublicStatus(result.status) };
  }
  if (kind === 'lives-load') {
    const body = parseLoadLiveBody(payload);
    const result = await loadWithConflict(service, body.liveId, () =>
      service.load(body.liveId, body.live ?? body.path, body.project),
    );
    return { ok: true, liveId: result.liveId, status: toPublicStatus(result.status) };
  }
  if (kind === 'lives-instantiate') {
    const body = parseInstantiateBody(payload);
    const result = await loadWithConflict(service, body.liveId, () =>
      service.instantiate(body.templateId, body.liveId, body.overrides, body.project),
    );
    return { ok: true, liveId: result.liveId, status: toPublicStatus(result.status) };
  }
  const body = parseMigrateLiveBody(payload);
  const result = await service.migrate(body.liveId, body.hive, body.project);
  return { ok: true, liveId: result.liveId, status: toPublicStatus(result.status) };
}

/**
 * Trigger and answer are deliveries, not runs: both hand the work to the field
 * and answer 202 `{ok:true}` with no id. Execution state is read from the
 * LiveHive itself (`inspect`, output).
 */
async function dispatchLiveDelivery(
  service: LiveHiveService,
  kind: 'lives-trigger' | 'lives-answer',
  payload: Record<string, unknown> | undefined,
): Promise<RouteReply> {
  if (kind === 'lives-trigger') {
    const body = parseTriggerLiveBody(payload);
    await service.trigger(body.liveId, body.beeId, body.input);
  } else {
    const body = parseAnswerLiveBody(payload);
    await service.answer(body.liveId, body.beeId, body.input, body.token);
  }
  return new RouteReply({ ok: true }, 202);
}

async function dispatchLiveState(
  service: LiveHiveService,
  route: Route,
  payload: Record<string, unknown> | undefined,
): Promise<Record<string, unknown>> {
  if (route.kind === 'lives-save') {
    const body = parseLiveIdBody(payload);
    return { ok: true, status: toPublicStatus(await service.save(body.liveId)) };
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
        body: { status: toPublicStatus(status) },
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
    ...(inspected.status === undefined
      ? {}
      : { status: toPublicStatus(inspected.status) }),
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
      body: { status: toPublicStatus(current) },
    });
  }
  try {
    return await load();
  } catch (error) {
    if (error instanceof LiveHiveHostLoadError) {
      // A stale Honey snapshot is an incompatibility, not "already loaded".
      // Rethrow it so toHttpError can answer 409 honey-incompatible.
      if (hasCause(error, HoneyIncompatibleError)) {
        throw error;
      }
      const status = currentStatus(service, liveId);
      throw new HttpError(409, 'conflict', 'live hive is already loaded', {
        ...(status === undefined
          ? {}
          : { body: { status: toPublicStatus(status) } }),
      });
    }
    throw error;
  }
}

function hasCause(error: unknown, type: typeof HoneyIncompatibleError): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (current instanceof type) {
      return true;
    }
    if (!(current instanceof Error)) {
      return false;
    }
    current = current.cause;
  }
  return false;
}

async function dispatchLiveUtility(
  service: LiveHiveService,
  kind: 'templates' | 'dispatch',
  payload: Record<string, unknown> | undefined,
  method?: string,
): Promise<Record<string, unknown> | RouteReply> {
  if (kind === 'templates') {
    if (method === 'GET') {
      return { ok: true, templates: service.listTemplates() };
    }
    const body = parseTemplateBody(payload);
    const template = service.compose(body.template);
    return { ok: true, templateId: template.templateId };
  }
  const body = parseDispatchBody(payload);
  await service.dispatchService.dispatch(body.input, {
    ...(body.sessionParams === undefined ? {} : { sessionParams: body.sessionParams }),
    ...(body.sessionId === undefined ? {} : { sessionId: body.sessionId }),
    ...(body.project === undefined ? {} : { project: body.project }),
  });
  return new RouteReply({ ok: true }, 202);
}

export const LIVE_ROUTE_KINDS = new Set<Route['kind']>([
  'lives-create',
  'lives-list',
  'lives-load',
  'lives-instantiate',
  'lives-trigger',
  'lives-answer',
  'lives-save',
  'lives-unload',
  'lives-migrate',
  'lives-inspect',
  'lives-output',
  'templates',
  'dispatch',
]);
