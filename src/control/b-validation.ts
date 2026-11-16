import {
  BObjectValidationError,
  parseHiveTemplate,
  parseLiveHive,
  parseSessionParams,
} from '../b/validation.js';
import type { HiveTemplate, LiveHive, SessionParams } from '../b/types.js';
import type { Project } from '../project/kernel.js';
import { HttpError } from './server-types.js';
import { assertExactFields, requirePayload } from './validation.js';

const MAX_ID_LENGTH = 512;
const MAX_PATH_LENGTH = 4_096;

export interface NewLiveBody {
  readonly live: LiveHive;
  readonly project?: Project;
}

export interface LoadLiveBody {
  readonly liveId: string;
  readonly path?: string;
  readonly live?: LiveHive;
  readonly project?: Project;
}

export interface InstantiateLiveBody {
  readonly templateId: string;
  readonly liveId: string;
  readonly overrides: Readonly<Record<string, SessionParams>>;
  readonly project?: Project;
}

export interface WakeLiveBody {
  readonly liveId: string;
  readonly beeId: string;
  readonly input: string;
}

export interface AnswerLiveBody extends WakeLiveBody {
  readonly token?: string;
}

export interface SaveLiveBody {
  readonly liveId: string;
}

export interface MigrateLiveBody {
  readonly liveId: string;
  readonly hive: LiveHive;
  readonly project?: Project;
}

export interface TemplateBody {
  readonly template: HiveTemplate;
}

export interface DispatchBody {
  readonly input: string;
  readonly sessionParams?: SessionParams;
  readonly sessionId?: string;
  readonly timeoutMs?: number;
  readonly project?: Project;
}

export function parseNewLiveBody(payload: Record<string, unknown> | undefined): NewLiveBody {
  const body = requirePayload(payload);
  if (isRecord(body['live'])) {
    assertExactFields(body, ['live', 'project'], 'live request');
    return {
      live: parseLive(body['live']),
      ...(body['project'] === undefined
        ? {}
        : { project: parseProject(body['project']) }),
    };
  }
  return { live: parseLive(body) };
}

export function parseLoadLiveBody(payload: Record<string, unknown> | undefined): LoadLiveBody {
  const body = requirePayload(payload);
  assertExactFields(body, ['liveId', 'path', 'live', 'project'], 'live load request');
  const liveId = requireString(body['liveId'], 'liveId', MAX_ID_LENGTH);
  const path = body['path'] === undefined
    ? undefined
    : requireString(body['path'], 'path', MAX_PATH_LENGTH);
  const live = body['live'] === undefined ? undefined : parseLive(body['live']);
  if (path !== undefined && live !== undefined) {
    throw new HttpError(400, 'bad-request', 'live load accepts path or live, not both');
  }
  const project = body['project'] === undefined
    ? undefined
    : parseProject(body['project']);
  return {
    liveId,
    ...(path === undefined ? {} : { path }),
    ...(live === undefined ? {} : { live }),
    ...(project === undefined ? {} : { project }),
  };
}

export function parseInstantiateBody(
  payload: Record<string, unknown> | undefined,
): InstantiateLiveBody {
  const body = requirePayload(payload);
  assertExactFields(
    body,
    ['templateId', 'liveId', 'overrides', 'project'],
    'live instantiate request',
  );
  const templateId = requireString(body['templateId'], 'templateId', MAX_ID_LENGTH);
  const liveId = requireString(body['liveId'], 'liveId', MAX_ID_LENGTH);
  const overrides = parseOverrides(body['overrides']);
  const project = body['project'] === undefined
    ? undefined
    : parseProject(body['project']);
  return {
    templateId,
    liveId,
    overrides,
    ...(project === undefined ? {} : { project }),
  };
}

export function parseWakeLiveBody(payload: Record<string, unknown> | undefined): WakeLiveBody {
  const body = requirePayload(payload);
  assertExactFields(body, ['liveId', 'beeId', 'input'], 'live wake request');
  return {
    liveId: requireString(body['liveId'], 'liveId', MAX_ID_LENGTH),
    beeId: requireString(body['beeId'], 'beeId', MAX_ID_LENGTH),
    input: requireString(body['input'], 'input', MAX_PATH_LENGTH, true),
  };
}

export function parseAnswerLiveBody(
  payload: Record<string, unknown> | undefined,
): AnswerLiveBody {
  const body = requirePayload(payload);
  assertExactFields(body, ['liveId', 'beeId', 'input', 'token'], 'live answer request');
  const token = body['token'] === undefined
    ? undefined
    : requireString(body['token'], 'token', 4_096);
  return {
    liveId: requireString(body['liveId'], 'liveId', MAX_ID_LENGTH),
    beeId: requireString(body['beeId'], 'beeId', MAX_ID_LENGTH),
    input: requireString(body['input'], 'input', MAX_PATH_LENGTH, true),
    ...(token === undefined ? {} : { token }),
  };
}

export function parseLiveIdBody(payload: Record<string, unknown> | undefined): SaveLiveBody {
  const body = requirePayload(payload);
  assertExactFields(body, ['liveId'], 'live request');
  return { liveId: requireString(body['liveId'], 'liveId', MAX_ID_LENGTH) };
}

export function parseMigrateLiveBody(
  payload: Record<string, unknown> | undefined,
): MigrateLiveBody {
  const body = requirePayload(payload);
  assertExactFields(body, ['liveId', 'hive', 'project'], 'live migrate request');
  const liveId = requireString(body['liveId'], 'liveId', MAX_ID_LENGTH);
  const hive = parseLive(body['hive']);
  const project = body['project'] === undefined
    ? undefined
    : parseProject(body['project']);
  return { liveId, hive, ...(project === undefined ? {} : { project }) };
}

export function parseTemplateBody(payload: Record<string, unknown> | undefined): TemplateBody {
  const body = requirePayload(payload);
  if (isRecord(body['template'])) {
    assertExactFields(body, ['template'], 'template request');
    return { template: parseTemplate(body['template']) };
  }
  return { template: parseTemplate(body) };
}

export function parseDispatchBody(payload: Record<string, unknown> | undefined): DispatchBody {
  const body = requirePayload(payload);
  assertExactFields(
    body,
    ['input', 'sessionParams', 'sessionId', 'timeoutMs', 'project'],
    'dispatch request',
  );
  const input = requireString(body['input'], 'input', MAX_PATH_LENGTH);
  const sessionParams = body['sessionParams'] === undefined
    ? undefined
    : parseParams(body['sessionParams']);
  const sessionId = body['sessionId'] === undefined
    ? undefined
    : requireString(body['sessionId'], 'sessionId', MAX_ID_LENGTH);
  const timeoutMs = body['timeoutMs'] === undefined
    ? undefined
    : requirePositiveInteger(body['timeoutMs'], 'timeoutMs');
  const project = body['project'] === undefined
    ? undefined
    : parseProject(body['project']);
  return {
    input,
    ...(sessionParams === undefined ? {} : { sessionParams }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(project === undefined ? {} : { project }),
  };
}

function parseLive(value: unknown): LiveHive {
  try {
    return parseLiveHive(value);
  } catch (error) {
    if (error instanceof BObjectValidationError) {
      throw new HttpError(400, 'bad-request', 'invalid live hive');
    }
    throw error;
  }
}

function parseTemplate(value: unknown): HiveTemplate {
  try {
    return parseHiveTemplate(value);
  } catch (error) {
    if (error instanceof BObjectValidationError) {
      throw new HttpError(400, 'bad-request', 'invalid hive template');
    }
    throw error;
  }
}

function parseParams(value: unknown): SessionParams {
  try {
    return parseSessionParams(value, 'sessionParams');
  } catch (error) {
    if (error instanceof BObjectValidationError) {
      throw new HttpError(400, 'bad-request', 'invalid sessionParams');
    }
    throw error;
  }
}

function parseOverrides(value: unknown): Readonly<Record<string, SessionParams>> {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw new HttpError(400, 'bad-request', 'overrides must be an object');
  }
  const overrides: Record<string, SessionParams> = {};
  for (const [beeId, raw] of Object.entries(value)) {
    overrides[beeId] = parseParams(raw);
  }
  return overrides;
}

function parseProject(value: unknown): Project {
  if (!isRecord(value)) {
    throw new HttpError(400, 'bad-request', 'project must be an object');
  }
  assertExactFields(value, ['id', 'directory'], 'project');
  return {
    id: requireString(value['id'], 'project.id', 256),
    directory: requireString(value['directory'], 'project.directory', MAX_PATH_LENGTH),
  };
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new HttpError(400, 'bad-request', `${field} must be a positive integer`);
  }
  return value;
}

function requireString(
  value: unknown,
  field: string,
  maxLength: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && value.length === 0) ||
    value.length > maxLength ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new HttpError(
      400,
      'bad-request',
      `${field} must be a non-empty string of at most ${String(maxLength)} characters`,
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
