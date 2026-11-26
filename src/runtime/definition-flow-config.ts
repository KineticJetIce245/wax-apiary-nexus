import type {
  AssembleGatherConfig,
  BatchGatherConfig,
  GatherConfig,
  GatherTypeConfig,
  GroupKey,
  JsonValue,
  SpreadConfig,
} from './types.js';
import { isValidPath } from './value-paths.js';
import { DEFAULT_TYPE_QUEUE_MAX } from './definition-constants.js';
import {
  isNonEmptyString,
  isPositiveInteger,
  isRecord,
  pushUnknownFields,
} from './definition-primitives.js';
import { parseRule } from './definition-rules.js';

/** Parses the M19 spread config: clone (list/map) or cleave (path map). */
export function parseSpreadConfig(
  config: Record<string, unknown>,
  path: string,
  issues: string[],
): SpreadConfig | null {
  pushUnknownFields(config, ['strategy', 'targets'], path, issues);
  const strategy = config['strategy'];
  if (strategy !== 'clone' && strategy !== 'cleave') {
    issues.push(`${path}.strategy: expected 'clone' or 'cleave'`);
    return null;
  }
  return strategy === 'clone'
    ? parseCloneTargets(config['targets'], `${path}.targets`, issues)
    : parseCleaveTargets(config['targets'], `${path}.targets`, issues);
}

function parseCloneTargets(
  raw: unknown,
  path: string,
  issues: string[],
): SpreadConfig | null {
  if (Array.isArray(raw)) {
    const targets = parseTargetList(raw, path, issues);
    return targets === null ? null : { strategy: 'clone', targets };
  }
  if (isRecord(raw)) {
    const targets = parseTargetMap(raw, path, issues);
    return targets === null ? null : { strategy: 'clone', targets };
  }
  issues.push(`${path}: expected a BeeId array or a BeeId map`);
  return null;
}

function parseTargetList(
  raw: readonly unknown[],
  path: string,
  issues: string[],
): string[] | null {
  if (raw.length === 0) {
    issues.push(`${path}: expected at least one target BeeId`);
    return null;
  }
  const targets: string[] = [];
  let valid = true;
  for (const [index, value] of raw.entries()) {
    if (!isNonEmptyString(value)) {
      issues.push(`${path}[${String(index)}]: expected a BeeId`);
      valid = false;
    } else if (targets.includes(value)) {
      issues.push(`${path}[${String(index)}]: duplicate target '${value}'`);
      valid = false;
    } else {
      targets.push(value);
    }
  }
  return valid ? targets : null;
}

function parseTargetMap(
  raw: Record<string, unknown>,
  path: string,
  issues: string[],
): Record<string, JsonValue> | null {
  const keys = Object.keys(raw);
  if (keys.length === 0) {
    issues.push(`${path}: expected at least one target BeeId`);
    return null;
  }
  const targets: Record<string, JsonValue> = {};
  let valid = true;
  for (const key of keys) {
    if (key.trim() === '') {
      issues.push(`${path}: target BeeId must be non-empty`);
      valid = false;
      continue;
    }
    targets[key] = raw[key] as JsonValue;
  }
  return valid ? targets : null;
}

function parseCleaveTargets(
  raw: unknown,
  path: string,
  issues: string[],
): SpreadConfig | null {
  if (!isRecord(raw)) {
    issues.push(`${path}: cleave targets must be a BeeId -> dot-path array map`);
    return null;
  }
  const keys = Object.keys(raw);
  if (keys.length === 0) {
    issues.push(`${path}: expected at least one target BeeId`);
    return null;
  }
  const targets: Record<string, readonly string[]> = {};
  let valid = true;
  for (const key of keys) {
    const paths = raw[key];
    if (!Array.isArray(paths) || paths.length === 0) {
      issues.push(`${path}.${key}: expected a non-empty dot-path array`);
      valid = false;
      continue;
    }
    const parsed: string[] = [];
    for (const [index, entry] of paths.entries()) {
      if (!isValidPath(entry, 'read')) {
        issues.push(`${path}.${key}[${String(index)}]: expected a dot path`);
        valid = false;
      } else {
        parsed.push(entry);
      }
    }
    targets[key] = parsed;
  }
  return valid ? { strategy: 'cleave', targets } : null;
}

/** Parses the M19 gather config: assemble (default) or batch sentinel flush. */
export function parseGatherConfig(
  config: Record<string, unknown>,
  path: string,
  issues: string[],
): GatherConfig | null {
  pushUnknownFields(
    config,
    ['strategy', 'types', 'groupBy', 'batch', 'typeQueueMax'],
    path,
    issues,
  );
  const strategy = config['strategy'] ?? 'assemble';
  if (strategy !== 'assemble' && strategy !== 'batch') {
    issues.push(`${path}.strategy: expected 'assemble' or 'batch'`);
    return null;
  }
  const typeQueueMax = parseTypeQueueMax(config['typeQueueMax'], `${path}.typeQueueMax`, issues);
  const types = parseTypes(config['types'], `${path}.types`, strategy, issues);
  if (typeQueueMax === null || types === null) {
    return null;
  }
  if (strategy === 'batch') {
    return parseBatch(config, path, types, typeQueueMax, issues);
  }
  if (config['batch'] !== undefined) {
    issues.push(`${path}.batch: only valid with strategy 'batch'`);
    return null;
  }
  const groupBy = parseGroupKey(config['groupBy'], `${path}.groupBy`, issues);
  if (groupBy === null) {
    return null;
  }
  const assembled: AssembleGatherConfig = {
    strategy: 'assemble',
    types,
    typeQueueMax,
    ...(groupBy === undefined ? {} : { groupBy }),
  };
  return assembled;
}

function parseTypeQueueMax(
  raw: unknown,
  path: string,
  issues: string[],
): number | null {
  if (raw === undefined) {
    return DEFAULT_TYPE_QUEUE_MAX;
  }
  if (!isPositiveInteger(raw)) {
    issues.push(`${path}: expected a positive integer`);
    return null;
  }
  return raw;
}

function parseTypes(
  raw: unknown,
  path: string,
  strategy: 'assemble' | 'batch',
  issues: string[],
): Record<string, GatherTypeConfig> | null {
  if (!isRecord(raw)) {
    issues.push(`${path}: expected a map name -> type config`);
    return null;
  }
  const names = Object.keys(raw);
  if (names.length === 0) {
    issues.push(`${path}: expected at least one type`);
    return null;
  }
  const types: Record<string, GatherTypeConfig> = {};
  let valid = true;
  for (const name of names) {
    if (name.trim() === '') {
      issues.push(`${path}: type name must be non-empty`);
      valid = false;
      continue;
    }
    const type = parseType(raw[name], `${path}.${name}`, strategy, issues);
    if (type === null) {
      valid = false;
    } else {
      types[name] = type;
    }
  }
  return valid ? types : null;
}

function parseType(
  raw: unknown,
  path: string,
  strategy: 'assemble' | 'batch',
  issues: string[],
): GatherTypeConfig | null {
  if (!isRecord(raw)) {
    issues.push(`${path}: expected an object`);
    return null;
  }
  pushUnknownFields(raw, ['match', 'count', 'reads'], path, issues);
  const match = parseRule(raw['match'], `${path}.match`, issues);
  const reads = parseReads(raw['reads'], `${path}.reads`, issues);
  if (match === null || reads === null) {
    return null;
  }
  if (strategy === 'batch') {
    if (raw['count'] !== undefined) {
      issues.push(`${path}.count: not allowed with strategy 'batch'`);
      return null;
    }
    return { match, count: 1, reads };
  }
  if (!isPositiveInteger(raw['count'])) {
    issues.push(`${path}.count: expected a positive integer`);
    return null;
  }
  return { match, count: raw['count'], reads };
}

function parseReads(raw: unknown, path: string, issues: string[]): string[] | null {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    issues.push(`${path}: expected a dot-path array`);
    return null;
  }
  const reads: string[] = [];
  let valid = true;
  for (const [index, entry] of raw.entries()) {
    if (!isValidPath(entry, 'read')) {
      issues.push(`${path}[${String(index)}]: expected a dot path`);
      valid = false;
    } else {
      reads.push(entry);
    }
  }
  return valid ? reads : null;
}

function parseBatch(
  config: Record<string, unknown>,
  path: string,
  types: Record<string, GatherTypeConfig>,
  typeQueueMax: number,
  issues: string[],
): BatchGatherConfig | null {
  if (config['groupBy'] !== undefined) {
    issues.push(`${path}.groupBy: not allowed with strategy 'batch'`);
    return null;
  }
  const batch = config['batch'];
  if (!isRecord(batch)) {
    issues.push(`${path}.batch: expected { signal: <rule> }`);
    return null;
  }
  pushUnknownFields(batch, ['signal'], `${path}.batch`, issues);
  const signal = parseRule(batch['signal'], `${path}.batch.signal`, issues);
  if (signal === null) {
    return null;
  }
  return { strategy: 'batch', batch: { signal }, types, typeQueueMax };
}

function parseGroupKey(
  raw: unknown,
  path: string,
  issues: string[],
): GroupKey | undefined | null {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw === 'string') {
    if (!isValidPath(raw, 'read')) {
      issues.push(`${path}: expected a dot path or a code block`);
      return null;
    }
    return raw;
  }
  if (isRecord(raw)) {
    const code = raw['code'];
    if (typeof code !== 'string' || code.trim() === '' || Object.keys(raw).length !== 1) {
      issues.push(`${path}: expected { code: <non-empty string> }`);
      return null;
    }
    return { code };
  }
  issues.push(`${path}: expected a dot path or a code block`);
  return null;
}
