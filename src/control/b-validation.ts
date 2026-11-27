import {
  BObjectValidationError,
  parseHiveTemplate,
  parseLiveHive,
  parseSessionParams,
} from '../b/validation.js';
import type { HiveTemplate, LiveHive, SessionParams } from '../b/types.js';
import type { Project } from '../project/kernel.js';
import { assertValue, type Value } from '../runtime/index.js';
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

export interface TriggerLiveBody {
  readonly liveId: string;
  readonly beeId: string;
  readonly input: string | Value;
}

export interface AnswerLiveBody extends TriggerLiveBody {
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
  readonly input: string | Value;
  readonly sessionParams?: SessionParams;
  readonly sessionId?: string;
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

export function parseTriggerLiveBody(payload: Record<string, unknown> | undefined): TriggerLiveBody {
  const body = requirePayload(payload);
  assertExactFields(body, ['liveId', 'beeId', 'input'], 'live trigger request');
  return {
    liveId: requireString(body['liveId'], 'liveId', MAX_ID_LENGTH),
    beeId: requireString(body['beeId'], 'beeId', MAX_ID_LENGTH),
    input: parseInput(body['input'], true),
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
    input: parseInput(body['input'], true),
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
    ['input', 'sessionParams', 'sessionId', 'project'],
    'dispatch request',
  );
  const input = parseInput(body['input'], false);
  const sessionParams = body['sessionParams'] === undefined
    ? undefined
    : parseParams(body['sessionParams']);
  const sessionId = body['sessionId'] === undefined
    ? undefined
    : requireString(body['sessionId'], 'sessionId', MAX_ID_LENGTH);
  const project = body['project'] === undefined
    ? undefined
    : parseProject(body['project']);
  return {
    input,
    ...(sessionParams === undefined ? {} : { sessionParams }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(project === undefined ? {} : { project }),
  };
}

/**
 * Control input is a string packaged as `{ message }`, or a JSON object used as
 * the Value as-is. The object is not stringified: nested fields stay fields.
 */
function parseInput(value: unknown, allowEmptyString: boolean): string | Value {
  if (typeof value === 'string') {
    return requireString(value, 'input', MAX_PATH_LENGTH, allowEmptyString);
  }
  try {
    assertValue(value, 'input');
  } catch (error) {
    throw new HttpError(
      400,
      'bad-request',
      error instanceof Error ? error.message : 'input must be a string or JSON object',
    );
  }
  return value;
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
