import {
  existsSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { atomicWriteJson } from './atomic-write.js';
import { expandHomePath } from './conversation-store.js';
import { assertJsonValue } from '../runtime/json-value.js';
import { HoneyIncompatibleError } from '../runtime/errors.js';
import type {
  HoverSpec,
  PersistedField,
  PersistedNodeState,
  Pheromone,
  QueueEntry,
  Value,
} from '../runtime/index.js';
import { parseSchedulerState, type SchedulerState } from '../daemon/scheduler.js';

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HOVER_KINDS = ['user', 'forager', 'guard', 'timer'] as const;
const NODE_KEYS = [
  'receptor',
  'pending',
  'active',
  'hover',
  'hoverPheromone',
  'lastActivatedAt',
  'state',
] as const;

export interface HoneyPaths {
  /** `~/.wax/apiaries/<apiary>/compositions/<composition>` */
  readonly directory: string;
  /** Durable field snapshot: `<directory>/honey/field.json` */
  readonly field: string;
  /** Scheduler occurrence bookkeeping: `<directory>/honey/scheduler.json` */
  readonly scheduler: string;
}

/**
 * Contract paths for one composition. Ids become directory names, so anything
 * that could escape the state root is rejected instead of sanitized.
 */
export function honeyPaths(stateRoot: string, apiaryId: string, compositionId: string): HoneyPaths {
  const apiary = safeSegment(apiaryId, 'apiary id');
  const composition = safeSegment(compositionId, 'composition id');
  const directory = join(
    expandHomePath(stateRoot),
    'apiaries',
    apiary,
    'compositions',
    composition,
  );
  return {
    directory,
    field: join(directory, 'honey', 'field.json'),
    scheduler: join(directory, 'honey', 'scheduler.json'),
  };
}

function safeSegment(value: string, label: string): string {
  if (!SAFE_SEGMENT.test(value)) {
    throw new Error(`invalid ${label}: '${value}'`);
  }
  return value;
}

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
  if (typeof value !== 'string' || value === '') {
    incompatible(`${path}: expected a non-empty string`);
  }
  return value;
}

/** A Value is a plain JSON object; `kind` is ordinary data, not a tag. */
function parseValue(input: unknown, path: string): Value {
  if (!isRecord(input)) {
    incompatible(`${path}: expected a JSON object`);
  }
  try {
    assertJsonValue(input, path);
  } catch (error) {
    incompatible(error instanceof Error ? error.message : String(error));
  }
  return input as Value;
}

function parsePheromone(input: unknown, path: string): Pheromone {
  if (!isRecord(input)) {
    incompatible(`${path}: expected a Pheromone object`);
  }
  assertExactKeys(input, ['value'], path);
  if (!Object.hasOwn(input, 'value')) {
    incompatible(`${path}.value: missing`);
  }
  return { value: parseValue(input['value'], `${path}.value`) };
}

function parseQueueEntry(input: unknown, path: string): QueueEntry {
  if (!isRecord(input)) {
    incompatible(`${path}: expected a queue entry object`);
  }
  assertExactKeys(input, ['value', 'enqueuedAt'], path);
  if (!Object.hasOwn(input, 'value')) {
    incompatible(`${path}.value: missing`);
  }
  const enqueuedAt = nonEmptyString(input['enqueuedAt'], `${path}.enqueuedAt`);
  if (!Number.isFinite(Date.parse(enqueuedAt))) {
    incompatible(`${path}.enqueuedAt: expected an ISO timestamp`);
  }
  return { value: parseValue(input['value'], `${path}.value`), enqueuedAt };
}

function parseHover(input: unknown, path: string): HoverSpec {
  if (!isRecord(input)) {
    incompatible(`${path}: expected a HoverSpec object`);
  }
  assertExactKeys(input, ['token', 'kind', 'compositionId', 'nodeId', 'expiresAt', 'meta'], path);
  const token = nonEmptyString(input['token'], `${path}.token`);
  const compositionId = nonEmptyString(input['compositionId'], `${path}.compositionId`);
  const nodeId = nonEmptyString(input['nodeId'], `${path}.nodeId`);
  const kind = input['kind'];
  if (typeof kind !== 'string' || !(HOVER_KINDS as readonly string[]).includes(kind)) {
    incompatible(`${path}.kind: unknown hover kind '${String(kind)}'`);
  }
  const rawMeta = input['meta'];
  if (rawMeta !== undefined && !isRecord(rawMeta)) {
    incompatible(`${path}.meta: expected an object`);
  }
  return {
    token,
    kind: kind as HoverSpec['kind'],
    compositionId,
    nodeId,
    ...(typeof input['expiresAt'] === 'string' ? { expiresAt: input['expiresAt'] } : {}),
    ...(isRecord(rawMeta) ? { meta: structuredClone(rawMeta) } : {}),
  };
}

function parseReceptor(input: unknown, path: string): QueueEntry[] | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (!Array.isArray(input)) {
    incompatible(`${path}: expected an array`);
  }
  return input.map((entry, index) => parseQueueEntry(entry, `${path}[${String(index)}]`));
}

function parseNodeState(input: unknown, path: string): PersistedNodeState {
  if (!isRecord(input)) {
    incompatible(`${path}: expected a node state object`);
  }
  assertExactKeys(input, NODE_KEYS, path);
  const receptor = parseReceptor(input['receptor'], `${path}.receptor`);
  const state: PersistedNodeState = receptor === undefined ? {} : { receptor };
  if (input['pending'] !== undefined) {
    state.pending = parsePheromone(input['pending'], `${path}.pending`);
  }
  if (input['active'] !== undefined) {
    state.active = parsePheromone(input['active'], `${path}.active`);
  }
  if (input['hover'] !== undefined) {
    state.hover = parseHover(input['hover'], `${path}.hover`);
  }
  if (input['hoverPheromone'] !== undefined) {
    state.hoverPheromone = parsePheromone(
      input['hoverPheromone'],
      `${path}.hoverPheromone`,
    );
  }
  if (input['lastActivatedAt'] !== undefined) {
    state.lastActivatedAt = nonEmptyString(input['lastActivatedAt'], `${path}.lastActivatedAt`);
  }
  if (input['state'] !== undefined) {
    if (!isRecord(input['state'])) {
      incompatible(`${path}.state: expected an object`);
    }
    state.state = structuredClone(input['state']);
  }
  return state;
}

function parsePersistedField(input: unknown): PersistedField {
  if (!isRecord(input)) {
    incompatible('honey field: expected an object');
  }
  const schemaVersion = input['schemaVersion'];
  if (schemaVersion !== 2) {
    incompatible(
      `honey field: unsupported schemaVersion ${String(schemaVersion)} (expected 2); ` +
        'the previous field model is incompatible and is not migrated',
    );
  }
  assertExactKeys(
    input,
    ['schemaVersion', 'compositionId', 'graphRevision', 'rest', 'nodes'],
    'honey field',
  );
  const compositionId = nonEmptyString(input['compositionId'], 'honey field.compositionId');
  const graphRevision = nonEmptyString(input['graphRevision'], 'honey field.graphRevision');
  if (typeof input['rest'] !== 'boolean') {
    incompatible('honey field.rest: expected a boolean');
  }
  const nodesInput = input['nodes'];
  if (!isRecord(nodesInput)) {
    incompatible('honey field: nodes must be an object');
  }
  const nodes: Record<string, PersistedNodeState> = {};
  for (const [id, raw] of Object.entries(nodesInput)) {
    nodes[id] = parseNodeState(raw, `honey field node '${id}'`);
  }
  return {
    schemaVersion: 2,
    compositionId,
    graphRevision,
    rest: input['rest'],
    nodes,
  };
}

/**
 * Durable Honey for one composition: an atomically replaced `field.json`.
 */
export class HoneyStore {
  readonly paths: HoneyPaths;

  constructor(paths: HoneyPaths) {
    this.paths = paths;
  }

  static forComposition(
    stateRoot: string,
    apiaryId: string,
    compositionId: string,
  ): HoneyStore {
    return new HoneyStore(honeyPaths(stateRoot, apiaryId, compositionId));
  }

  save(field: PersistedField): void {
    atomicWriteJson(this.paths.field, field);
  }

  /** Whether a durable field snapshot exists for this composition. */
  exists(): boolean {
    return existsSync(this.paths.field);
  }

  saveScheduler(state: SchedulerState): void {
    atomicWriteJson(this.paths.scheduler, state);
  }

  loadScheduler(): SchedulerState | undefined {
    if (!existsSync(this.paths.scheduler)) {
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.paths.scheduler, 'utf8'));
    } catch (error) {
      throw new Error(
        `scheduler state is not valid JSON: ${this.paths.scheduler} (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    try {
      return parseSchedulerState(parsed);
    } catch (error) {
      throw new Error(
        `scheduler state is invalid: ${this.paths.scheduler} (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }

  load(): PersistedField | undefined {
    if (!existsSync(this.paths.field)) {
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.paths.field, 'utf8'));
    } catch (error) {
      throw new Error(
        `honey field is not valid JSON: ${this.paths.field} (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    return parsePersistedField(parsed);
  }
}
