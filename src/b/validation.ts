import { parseSchedules } from './schedule-validation.js';
import {
  BEE_KINDS,
  SESSION_MODES,
  type Bee,
  type BeeKind,
  type Beeline,
  type HiveGraph,
  type HiveTemplate,
  type LiveHive,
  type Schedule,
  type SessionMode,
  type SessionParams,
} from './types.js';

const MAX_ID_LENGTH = 512;
const MAX_LABEL_LENGTH = 256;

/** Structural validation for the two B documents; no semantic graph mapping. */
export class BObjectValidationError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`invalid B object:\n${issues.map((issue) => `- ${issue}`).join('\n')}`);
    this.name = 'BObjectValidationError';
  }
}

export function parseLiveHive(input: unknown): LiveHive {
  const issues: string[] = [];
  if (!isRecord(input)) {
    throw new BObjectValidationError(['live: expected an object']);
  }
  requireSchemaVersion(input, issues, 'live');
  const liveId = requireString(input['liveId'], 'liveId', issues);
  const graph = parseHiveGraph(input, 'live', issues);
  const bindings = parseBindings(input['bindings'], graph.bees, issues);
  const schedules = parseSchedules(input['schedules'], graph.bees, 'live.schedules', issues);
  if (issues.length > 0) {
    throw new BObjectValidationError(issues);
  }
  return {
    schemaVersion: 1,
    liveId: liveId as string,
    bees: graph.bees,
    beelines: graph.beelines,
    bindings,
    ...(schedules === undefined ? {} : { schedules }),
  };
}

export function parseHiveTemplate(input: unknown): HiveTemplate {
  const issues: string[] = [];
  if (!isRecord(input)) {
    throw new BObjectValidationError(['template: expected an object']);
  }
  requireSchemaVersion(input, issues, 'template');
  const templateId = requireString(input['templateId'], 'templateId', issues);
  const hive = input['hive'];
  if (!isRecord(hive)) {
    issues.push('template.hive: expected an object');
    throw new BObjectValidationError(issues);
  }
  const graph = parseHiveGraph(hive, 'template.hive', issues);
  const defaults = parseDefaults(input['defaults'], graph.bees, issues);
  const schedules = parseSchedules(
    input['schedules'],
    graph.bees,
    'template.schedules',
    issues,
  );
  if (issues.length > 0) {
    throw new BObjectValidationError(issues);
  }
  return {
    schemaVersion: 1,
    templateId: templateId as string,
    hive: graph,
    defaults,
    ...(schedules === undefined ? {} : { schedules }),
  };
}

export function parseHiveGraph(
  input: unknown,
  path: string,
  inheritedIssues?: string[],
): HiveGraph {
  const issues = inheritedIssues ?? [];
  if (!isRecord(input)) {
    issues.push(`${path}: expected an object`);
    throw new BObjectValidationError(issues);
  }
  const rawBees = input['bees'];
  const rawBeelines = input['beelines'];
  if (!isRecord(rawBees)) {
    issues.push(`${path}.bees: expected an object keyed by beeId`);
  }
  if (!isRecord(rawBeelines)) {
    issues.push(`${path}.beelines: expected an object keyed by beelineId`);
  }
  if (!isRecord(rawBees) || !isRecord(rawBeelines)) {
    throw new BObjectValidationError(issues);
  }
  if (Object.keys(rawBees).length === 0) {
    issues.push(`${path}.bees: expected at least one bee`);
  }

  const bees: Record<string, Bee> = {};
  for (const [beeId, raw] of Object.entries(rawBees)) {
    requireString(beeId, `${path}.bees key`, issues);
    const bee = parseBee(raw, `${path}.bees.${beeId}`, issues);
    if (bee !== undefined) {
      bees[beeId] = bee;
    }
  }

  const beelines: Record<string, Beeline> = {};
  for (const [beelineId, raw] of Object.entries(rawBeelines)) {
    requireString(beelineId, `${path}.beelines key`, issues);
    const beeline = parseBeeline(raw, `${path}.beelines.${beelineId}`, issues);
    if (beeline !== undefined) {
      beelines[beelineId] = beeline;
    }
  }

  validateGraphReferences(bees, beelines, path, issues);

  if (issues.length > 0 && inheritedIssues === undefined) {
    throw new BObjectValidationError(issues);
  }
  return { bees, beelines };
}

function validateGraphReferences(
  bees: Readonly<Record<string, Bee>>,
  beelines: Readonly<Record<string, Beeline>>,
  path: string,
  issues: string[],
): void {
  for (const [makeId, make] of Object.entries(bees)) {
    for (const beelineId of make.outgoing) {
      const line = beelines[beelineId];
      if (line === undefined) {
        issues.push(`${path}.bees.${makeId}.outgoing: unknown beeline '${beelineId}'`);
      } else if (line.fromBee !== makeId) {
        issues.push(`${path}.bees.${makeId}.outgoing: beeline '${beelineId}' starts elsewhere`);
      }
    }
    for (const [beelineId, line] of Object.entries(beelines)) {
      if (line.fromBee === makeId && !make.outgoing.includes(beelineId)) {
        issues.push(`${path}.bees.${makeId}.outgoing: missing beeline '${beelineId}'`);
      }
    }
  }
  for (const [beelineId, line] of Object.entries(beelines)) {
    if (!Object.hasOwn(bees, line.fromBee)) {
      issues.push(`${path}.beelines.${beelineId}.fromBee: unknown bee '${line.fromBee}'`);
    }
    if (!Object.hasOwn(bees, line.toBee)) {
      issues.push(`${path}.beelines.${beelineId}.toBee: unknown bee '${line.toBee}'`);
    }
  }
}

export function parseSessionParams(input: unknown, path: string): SessionParams {
  const issues: string[] = [];
  if (!isRecord(input)) {
    throw new BObjectValidationError([`${path}: expected an object`]);
  }
  assertExactFields(input, ['harness', 'model', 'reasoning'], path, issues);
  const harness = optionalString(input['harness'], `${path}.harness`, issues);
  const model = optionalString(input['model'], `${path}.model`, issues);
  const reasoning = optionalString(input['reasoning'], `${path}.reasoning`, issues);
  if (issues.length > 0) {
    throw new BObjectValidationError(issues);
  }
  return {
    ...(harness === undefined ? {} : { harness }),
    ...(model === undefined ? {} : { model }),
    ...(reasoning === undefined ? {} : { reasoning }),
  };
}

function parseBee(input: unknown, path: string, issues: string[]): Bee | undefined {
  if (!isRecord(input)) {
    issues.push(`${path}: expected an object`);
    return undefined;
  }
  assertExactFields(input, ['kind', 'config', 'outgoing', 'roleLabel', 'sessionMode'], path, issues);
  const kind = input['kind'];
  if (typeof kind !== 'string' || !BEE_KINDS.includes(kind as BeeKind)) {
    issues.push(`${path}.kind: expected one of ${BEE_KINDS.join(', ')}`);
  }
  const config = parseConfig(input['config'], `${path}.config`, issues);
  const outgoing = parseOutgoing(input['outgoing'], `${path}.outgoing`, issues);
  const roleLabel = optionalString(input['roleLabel'], `${path}.roleLabel`, issues, MAX_LABEL_LENGTH);
  const rawMode = input['sessionMode'];
  if (
    rawMode !== undefined &&
    (typeof rawMode !== 'string' || !SESSION_MODES.includes(rawMode as SessionMode))
  ) {
    issues.push(`${path}.sessionMode: expected one of ${SESSION_MODES.join(', ')}`);
  }
  if (typeof kind !== 'string' || config === undefined || outgoing === undefined) {
    return undefined;
  }
  return {
    kind: kind as BeeKind,
    config,
    outgoing,
    ...(roleLabel === undefined ? {} : { roleLabel }),
    ...(rawMode === undefined ? {} : { sessionMode: rawMode as SessionMode }),
  };
}

function parseBeeline(input: unknown, path: string, issues: string[]): Beeline | undefined {
  if (!isRecord(input)) {
    issues.push(`${path}: expected an object`);
    return undefined;
  }
  assertExactFields(input, ['fromBee', 'toBee', 'branch'], path, issues);
  const fromBee = requireString(input['fromBee'], `${path}.fromBee`, issues);
  const toBee = requireString(input['toBee'], `${path}.toBee`, issues);
  const branch = optionalString(input['branch'], `${path}.branch`, issues, MAX_LABEL_LENGTH);
  if (fromBee === undefined || toBee === undefined) {
    return undefined;
  }
  return {
    fromBee,
    toBee,
    ...(branch === undefined ? {} : { branch }),
  };
}

function parseBindings(
  input: unknown,
  bees: Readonly<Record<string, Bee>>,
  issues: string[],
): Readonly<Record<string, string>> {
  if (!isRecord(input)) {
    issues.push('live.bindings: expected an object keyed by beeId');
    return {};
  }
  const bindings: Record<string, string> = {};
  for (const [beeId, sessionId] of Object.entries(input)) {
    if (!Object.hasOwn(bees, beeId)) {
      issues.push(`live.bindings.${beeId}: unknown bee`);
    }
    const parsed = requireString(sessionId, `live.bindings.${beeId}`, issues);
    if (parsed !== undefined) {
      bindings[beeId] = parsed;
    }
  }
  return bindings;
}

function parseDefaults(
  input: unknown,
  bees: Readonly<Record<string, Bee>>,
  issues: string[],
): Readonly<Record<string, SessionParams>> {
  if (!isRecord(input)) {
    issues.push('template.defaults: expected an object keyed by beeId');
    return {};
  }
  const defaults: Record<string, SessionParams> = {};
  for (const [beeId, raw] of Object.entries(input)) {
    if (!Object.hasOwn(bees, beeId)) {
      issues.push(`template.defaults.${beeId}: unknown bee`);
    }
    try {
      defaults[beeId] = parseSessionParams(raw, `template.defaults.${beeId}`);
    } catch (error) {
      if (error instanceof BObjectValidationError) {
        issues.push(...error.issues);
      } else {
        throw error;
      }
    }
  }
  return defaults;
}

function parseConfig(
  input: unknown,
  path: string,
  issues: string[],
): Readonly<Record<string, unknown>> | undefined {
  if (!isRecord(input)) {
    issues.push(`${path}: expected an object`);
    return undefined;
  }
  // Config is forwarded to parseComposition by the codec, which owns the
  // kind-specific schema. Keep a shallow copy so callers cannot mutate it later.
  return { ...input };
}

function parseOutgoing(
  input: unknown,
  path: string,
  issues: string[],
): readonly string[] | undefined {
  if (!Array.isArray(input)) {
    issues.push(`${path}: expected an array`);
    return undefined;
  }
  const outgoing: string[] = [];
  for (const [index, value] of input.entries()) {
    const parsed = requireString(value, `${path}[${String(index)}]`, issues);
    if (parsed === undefined) {
      continue;
    }
    if (outgoing.includes(parsed)) {
      issues.push(`${path}: duplicate beeline '${parsed}'`);
      continue;
    }
    outgoing.push(parsed);
  }
  return outgoing;
}

function requireSchemaVersion(
  input: Record<string, unknown>,
  issues: string[],
  path: string,
): void {
  if (input['schemaVersion'] !== 1) {
    issues.push(`${path}.schemaVersion: expected 1`);
  }
}

function requireString(
  input: unknown,
  path: string,
  issues: string[],
  maxLength = MAX_ID_LENGTH,
): string | undefined {
  if (
    typeof input !== 'string' ||
    input.length === 0 ||
    input.length > maxLength ||
    /[\u0000-\u001f\u007f]/.test(input)
  ) {
    issues.push(`${path}: expected a non-empty string of at most ${String(maxLength)} characters`);
    return undefined;
  }
  return input;
}

function optionalString(
  input: unknown,
  path: string,
  issues: string[],
  maxLength = MAX_ID_LENGTH,
): string | undefined {
  if (input === undefined) {
    return undefined;
  }
  return requireString(input, path, issues, maxLength);
}

function assertExactFields(
  input: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  issues: string[],
): void {
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) {
      issues.push(`${path}: unknown field '${key}'`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
