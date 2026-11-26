/**
 * Strict parser for one node's persisted gather state in `field.json` v2.
 *
 * The field snapshot is durable state, so an unknown or malformed gather record
 * fails closed instead of being dropped: there is no migration and no silent
 * repair. The shape is cross-checked against the live gather config on restore
 * (`runtime/gather-restore.ts`); this module checks the JSON shape only.
 */

import { HoneyIncompatibleError } from '../runtime/errors.js';
import { assertJsonValue } from '../runtime/json-value.js';
import type { GatherStateSnapshot, JsonValue } from '../runtime/index.js';

const ASSEMBLE_KEYS = ['strategy', 'groups', 'tombstones'] as const;
const BATCH_KEYS = ['strategy', 'groups', 'tombstones', 'batch'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function incompatible(message: string): never {
  throw new HoneyIncompatibleError(message);
}

function assertExactKeys(
  input: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) {
      incompatible(`${path}: unknown field '${key}'`);
    }
  }
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    incompatible(`${path}: expected a non-empty string`);
  }
  return value;
}

function parseJson(input: unknown, path: string): JsonValue {
  try {
    assertJsonValue(input, path);
  } catch (error) {
    incompatible(error instanceof Error ? error.message : String(error));
  }
  return input as JsonValue;
}

/** Parses one persisted gather state object; the strategy selects the shape. */
export function parsePersistedGatherState(
  input: unknown,
  path: string,
): GatherStateSnapshot {
  if (!isRecord(input)) {
    incompatible(`${path}: expected a gather state object`);
  }
  const strategy = input['strategy'];
  if (strategy === 'assemble') {
    return parseAssemble(input, path);
  }
  if (strategy === 'batch') {
    return parseBatch(input, path);
  }
  incompatible(`${path}.strategy: expected 'assemble' or 'batch'`);
}

function parseAssemble(
  input: Record<string, unknown>,
  path: string,
): GatherStateSnapshot {
  assertExactKeys(input, ASSEMBLE_KEYS, path);
  // Both lists are written by every M19e snapshot; a missing one is a truncated
  // record that could silently reopen closed groups, so it fails closed.
  const groups = parseGroups(input['groups'], `${path}.groups`);
  const tombstones = parseTombstones(input['tombstones'], `${path}.tombstones`);
  return { strategy: 'assemble', groups, tombstones };
}

function parseBatch(input: Record<string, unknown>, path: string): GatherStateSnapshot {
  assertExactKeys(input, BATCH_KEYS, path);
  const groups = input['groups'] === undefined ? [] : parseGroups(input['groups'], `${path}.groups`);
  const tombstones =
    input['tombstones'] === undefined
      ? []
      : parseTombstones(input['tombstones'], `${path}.tombstones`);
  if (groups.length > 0 || tombstones.length > 0) {
    incompatible(`${path}: a batch gather cannot carry groups or tombstones`);
  }
  if (!isRecord(input['batch'])) {
    incompatible(`${path}.batch: expected a type -> entry-array object`);
  }
  return {
    strategy: 'batch',
    groups: [],
    tombstones: [],
    batch: parseQueues(input['batch'], `${path}.batch`),
  };
}

function parseGroups(
  input: unknown,
  path: string,
): GatherStateSnapshot['groups'] {
  if (!Array.isArray(input)) {
    incompatible(`${path}: expected an array of groups`);
  }
  return input.map((group, index) => {
    const groupPath = `${path}[${String(index)}]`;
    if (!isRecord(group)) {
      incompatible(`${groupPath}: expected a group object`);
    }
    assertExactKeys(group, ['key', 'entries'], groupPath);
    const result: { key?: string; entries: Record<string, readonly JsonValue[]> } = {
      entries: parseQueues(group['entries'], `${groupPath}.entries`),
    };
    if (group['key'] !== undefined) {
      result.key = nonEmptyString(group['key'], `${groupPath}.key`);
    }
    return result;
  });
}

function parseTombstones(
  input: unknown,
  path: string,
): GatherStateSnapshot['tombstones'] {
  if (!Array.isArray(input)) {
    incompatible(`${path}: expected an array of tombstones`);
  }
  return input.map((tombstone, index) => {
    const tombstonePath = `${path}[${String(index)}]`;
    if (!isRecord(tombstone)) {
      incompatible(`${tombstonePath}: expected a tombstone object`);
    }
    assertExactKeys(tombstone, ['key', 'closedAt'], tombstonePath);
    const key = nonEmptyString(tombstone['key'], `${tombstonePath}.key`);
    const closedAt = nonEmptyString(tombstone['closedAt'], `${tombstonePath}.closedAt`);
    if (!Number.isFinite(Date.parse(closedAt))) {
      incompatible(`${tombstonePath}.closedAt: expected an ISO timestamp`);
    }
    return { key, closedAt };
  });
}

function parseQueues(
  input: unknown,
  path: string,
): Record<string, readonly JsonValue[]> {
  if (!isRecord(input)) {
    incompatible(`${path}: expected a type -> entry-array object`);
  }
  const queues: Record<string, readonly JsonValue[]> = {};
  for (const [name, queue] of Object.entries(input)) {
    if (name.trim() === '') {
      incompatible(`${path}: type name must be non-empty`);
    }
    if (!Array.isArray(queue)) {
      incompatible(`${path}.${name}: expected an entry array`);
    }
    queues[name] = queue.map((entry, index) =>
      parseJson(entry, `${path}.${name}[${String(index)}]`),
    );
  }
  return queues;
}
