import {
  existsSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { atomicWriteJson } from './atomic-write.js';
import { expandHomePath } from './conversation-store.js';
import { assertJsonValue } from '../runtime/json-value.js';
import type {
  BranchTag,
  HoverSpec,
  PersistedField,
  PersistedGatherState,
  PersistedNodeState,
  Pheromone,
  Value,
} from '../runtime/index.js';
import { parseSchedulerState, type SchedulerState } from '../daemon/scheduler.js';
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
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
function parseBranchTag(input: unknown, path: string): BranchTag {
  if (!isRecord(input)) {
    throw new Error(`${path}: expected a branch tag object`);
  }
  const spreadId = input['spreadId'];
  const branchId = input['branchId'];
  if (typeof spreadId !== 'string' || spreadId === '') {
    throw new Error(`${path}.spreadId: expected a non-empty string`);
  }
  if (typeof branchId !== 'string' || branchId === '') {
    throw new Error(`${path}.branchId: expected a non-empty string`);
  }
  return { spreadId, branchId };
}
/**
 * A lineage is outer-to-inner. An empty array is rejected: an untagged
 * Pheromone omits `lineage` entirely, so there is only one representation for
 * "no enclosing spread".
 */
function parseLineage(input: unknown, path: string): BranchTag[] | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error(`${path}: expected a non-empty array of branch tags`);
  }
  return input.map((entry, index) => parseBranchTag(entry as unknown, `${path}[${String(index)}]`));
}
function sameLineage(left: readonly BranchTag[], right: readonly BranchTag[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a?.spreadId !== b?.spreadId || a?.branchId !== b?.branchId) {
      return false;
    }
  }
  return true;
}
/**
 * Validates the shape of a persisted Value. Shared with the answer inbox: an
 * answer record is untrusted local input, so it must not smuggle a Value shape
 * that the field loader would reject.
 */
export function assertValueShape(value: unknown, path: string): asserts value is Value {
  if (!isRecord(value)) {
    throw new Error(`${path}: expected a value object`);
  }
  switch (value['kind']) {
    case 'text':
      if (typeof value['text'] !== 'string') {
        throw new Error(`${path}.text: expected a string`);
      }
      return;
    case 'choice':
      if (typeof value['choice'] !== 'string') {
        throw new Error(`${path}.choice: expected a string`);
      }
      return;
    case 'boolean':
      if (typeof value['value'] !== 'boolean') {
        throw new Error(`${path}.value: expected a boolean`);
      }
      return;
    case 'message':
    case 'attachments':
      if (!Array.isArray(value['attachments'])) {
        throw new Error(`${path}.attachments: expected an array`);
      }
      return;
    case 'structured':
      // Stage 5C: a structured Value is persisted as plain JSON, so the loaded
      // field must still carry a JSON-safe payload. A malformed shape is
      // rejected instead of silently becoming `{kind:'structured'}`.
      assertJsonValue(value['value'], `${path}.value`);
      return;
    default:
      throw new Error(`${path}.kind: unknown value kind '${String(value['kind'])}'`);
  }
}
function parsePheromone(input: unknown, path: string): Pheromone {
  if (!isRecord(input)) {
    throw new Error(`${path}: expected a Pheromone object`);
  }
  const { id, at } = input;
  if (typeof id !== 'string' || id === '') {
    throw new Error(`${path}.id: expected a non-empty string`);
  }
  if (typeof at !== 'string' || at === '') {
    throw new Error(`${path}.at: expected a timestamp`);
  }
  assertValueShape(input['value'], `${path}.value`);

  const rawSpreadId = input['spreadId'];
  const rawBranchId = input['branchId'];
  if (rawSpreadId !== undefined && (typeof rawSpreadId !== 'string' || rawSpreadId === '')) {
    throw new Error(`${path}.spreadId: expected a non-empty string`);
  }
  if (rawBranchId !== undefined && (typeof rawBranchId !== 'string' || rawBranchId === '')) {
    throw new Error(`${path}.branchId: expected a non-empty string`);
  }
  const flatSpreadId = rawSpreadId as string | undefined;
  const flatBranchId = rawBranchId as string | undefined;

  let lineage = parseLineage(input['lineage'], `${path}.lineage`);
  if (lineage === undefined) {
    // Stage 5D reads a pre-5D flat tag as a one-level lineage. The flat tag
    // remains the compatibility handle and still points at the last tag.
    if (flatSpreadId !== undefined && flatBranchId !== undefined) {
      lineage = [{ spreadId: flatSpreadId, branchId: flatBranchId }];
    } else if (flatSpreadId !== undefined || flatBranchId !== undefined) {
      throw new Error(
        `${path}: expected both spreadId and branchId, or a lineage, for a tagged Pheromone`,
      );
    }
  } else {
    const current = lineage.at(-1);
    if (current === undefined) {
      throw new Error(`${path}.lineage: expected at least one tag`);
    }
    if (flatSpreadId !== undefined && flatSpreadId !== current.spreadId) {
      throw new Error(
        `${path}.spreadId: expected '${current.spreadId}' to match the last lineage tag`,
      );
    }
    if (flatBranchId !== undefined && flatBranchId !== current.branchId) {
      throw new Error(
        `${path}.branchId: expected '${current.branchId}' to match the last lineage tag`,
      );
    }
  }
  const current = lineage?.at(-1);

  return {
    id,
    value: input['value'],
    at,
    ...(current === undefined
      ? {}
      : { spreadId: current.spreadId, branchId: current.branchId }),
    ...(lineage === undefined ? {} : { lineage }),
  };
}

function parseHover(input: unknown, path: string): HoverSpec {
  if (!isRecord(input)) {
    throw new Error(`${path}: expected a HoverSpec object`);
  }
  const strings = ['token', 'compositionId', 'nodeId', 'pheromoneId'] as const;
  for (const field of strings) {
    if (typeof input[field] !== 'string' || input[field] === '') {
      throw new Error(`${path}.${field}: expected a non-empty string`);
    }
  }
  const kind = input['kind'];
  if (kind !== 'user' && kind !== 'forager' && kind !== 'guard' && kind !== 'timer') {
    throw new Error(`${path}.kind: unknown hover kind '${String(kind)}'`);
  }
  return {
    token: input['token'] as string,
    kind,
    compositionId: input['compositionId'] as string,
    nodeId: input['nodeId'] as string,
    pheromoneId: input['pheromoneId'] as string,
    ...(typeof input['expiresAt'] === 'string' ? { expiresAt: input['expiresAt'] } : {}),
    ...(isRecord(input['meta']) ? { meta: structuredClone(input['meta']) } : {}),
  };
}

function parseGathers(
  input: unknown,
  path: string,
): Record<string, PersistedGatherState> {
  if (!isRecord(input)) {
    throw new Error(`${path}: expected an object keyed by spreadId`);
  }

  const entries: [string, PersistedGatherState][] = [];
  for (const [spreadId, raw] of Object.entries(input)) {
    if (spreadId === '') {
      throw new Error(`${path}: join spreadId must be non-empty`);
    }
    const gatherPath = `${path}.${spreadId}`;
    if (!isRecord(raw)) {
      throw new Error(`${gatherPath}: expected an object`);
    }
    const rawArrived = raw['arrived'];
    if (!Array.isArray(rawArrived)) {
      throw new Error(`${gatherPath}: expected an arrived Pheromone array`);
    }

    const rawCompletedAt = raw['completedAt'];
    const rawTimedOutAt = raw['timedOutAt'];
    const parentLineage = parseLineage(raw['lineage'], `${gatherPath}.lineage`);
    if (rawCompletedAt !== undefined && rawTimedOutAt !== undefined) {
      throw new Error(`${gatherPath}: a join cannot be both completed and timed out`);
    }
    if (rawCompletedAt !== undefined) {
      // Stage 5A completed tombstone: it remembers the spreadId but holds no
      // Pheromones, so a late branch can still be dropped on restore.
      if (
        typeof rawCompletedAt !== 'string' ||
        !Number.isFinite(Date.parse(rawCompletedAt))
      ) {
        throw new Error(`${gatherPath}.completedAt: expected an ISO timestamp`);
      }
      if (rawArrived.length !== 0) {
        throw new Error(`${gatherPath}.arrived: a completed join holds no Pheromones`);
      }
      entries.push([
        spreadId,
        {
          arrived: [],
          ...(parentLineage === undefined ? {} : { lineage: parentLineage }),
          completedAt: rawCompletedAt,
        },
      ]);
      continue;
    }
    if (rawTimedOutAt !== undefined) {
      // Stage 5B timed-out tombstone: the spread failed, so a late branch is
      // dropped instead of reopening the join.
      if (
        typeof rawTimedOutAt !== 'string' ||
        !Number.isFinite(Date.parse(rawTimedOutAt))
      ) {
        throw new Error(`${gatherPath}.timedOutAt: expected an ISO timestamp`);
      }
      if (rawArrived.length !== 0) {
        throw new Error(`${gatherPath}.arrived: a timed-out join holds no Pheromones`);
      }
      entries.push([
        spreadId,
        {
          arrived: [],
          ...(parentLineage === undefined ? {} : { lineage: parentLineage }),
          timedOutAt: rawTimedOutAt,
        },
      ]);
      continue;
    }

    if (rawArrived.length === 0) {
      throw new Error(`${gatherPath}.arrived: expected at least one Pheromone`);
    }
    const rawDeadlineAt = raw['deadlineAt'];
    if (typeof rawDeadlineAt !== 'number' || !Number.isSafeInteger(rawDeadlineAt)) {
      throw new Error(`${gatherPath}.deadlineAt: expected an absolute epoch-ms deadline`);
    }

    const seen = new Set<string>();
    let derivedParent: BranchTag[] | undefined;
    const arrived = rawArrived.map((entry, index) => {
      const pheromone = parsePheromone(entry as unknown, `${gatherPath}.arrived[${String(index)}]`);
      if (pheromone.spreadId !== spreadId) {
        throw new Error(
          `${gatherPath}.arrived[${String(index)}].spreadId: expected '${spreadId}'`,
        );
      }
      if (pheromone.branchId === undefined || pheromone.branchId === '') {
        throw new Error(`${gatherPath}.arrived[${String(index)}].branchId: expected a branch id`);
      }
      if (seen.has(pheromone.branchId)) {
        throw new Error(
          `${gatherPath}.arrived[${String(index)}].branchId: duplicate branch '${pheromone.branchId}'`,
        );
      }
      seen.add(pheromone.branchId);
      const parent = (pheromone.lineage ?? []).slice(0, -1);
      if (derivedParent === undefined) {
        derivedParent = parent;
      } else if (!sameLineage(derivedParent, parent)) {
        throw new Error(
          `${gatherPath}.arrived[${String(index)}]: branch lineages disagree on the parent`,
        );
      }
      return pheromone;
    });

    const effectiveParent = derivedParent ?? [];
    if (parentLineage !== undefined && !sameLineage(parentLineage, effectiveParent)) {
      throw new Error(`${gatherPath}.lineage: does not match its branch Pheromones`);
    }
    entries.push([
      spreadId,
      {
        arrived,
        ...(effectiveParent.length === 0
          ? {}
          : { lineage: effectiveParent.map((tag) => ({ ...tag })) }),
        deadlineAt: rawDeadlineAt,
      },
    ]);
  }
  return Object.fromEntries(entries);
}

function parseReceptor(input: unknown, path: string): Pheromone[] | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (!Array.isArray(input)) {
    throw new Error(`${path}: expected an array`);
  }
  return input.map((entry, index) =>
    parsePheromone(entry, `${path}[${String(index)}]`),
  );
}

function parseNodeState(input: unknown, path: string): PersistedNodeState {
  if (!isRecord(input)) {
    throw new Error(`${path}: expected a node state object`);
  }

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
    state.hoverPheromone = parsePheromone(input['hoverPheromone'], `${path}.hoverPheromone`);
  }
  if (typeof input['lastActivatedAt'] === 'string') {
    state.lastActivatedAt = input['lastActivatedAt'];
  }
  if (isRecord(input['state'])) {
    state.state = structuredClone(input['state']);
  }
  if (input['gathers'] !== undefined) {
    state.gathers = parseGathers(input['gathers'], `${path}.gathers`);
  }
  return state;
}

function parsePersistedField(input: unknown): PersistedField {
  if (!isRecord(input)) {
    throw new Error('honey field: expected an object');
  }
  if (input['schemaVersion'] !== 1) {
    throw new Error(`honey field: unsupported schemaVersion ${String(input['schemaVersion'])}`);
  }
  const { compositionId, graphRevision } = input;
  if (typeof compositionId !== 'string' || compositionId === '') {
    throw new Error('honey field: compositionId must be a non-empty string');
  }
  if (typeof graphRevision !== 'string' || graphRevision === '') {
    throw new Error('honey field: graphRevision must be a non-empty string');
  }
  const nodesInput = input['nodes'];
  if (!isRecord(nodesInput)) {
    throw new Error('honey field: nodes must be an object');
  }

  const nodes: Record<string, PersistedNodeState> = {};
  for (const [id, raw] of Object.entries(nodesInput)) {
    nodes[id] = parseNodeState(raw, `honey field node '${id}'`);
  }

  return {
    schemaVersion: 1,
    compositionId,
    graphRevision,
    rest: input['rest'] === true,
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
