import { serializeValue } from './executor.js';
import type { RuntimeLogEntry } from './log.js';
import type {
  BranchTag,
  ConditionConfig,
  JsonValue,
  MergeCombine,
  Pheromone,
  Value,
} from './types.js';
import { WorkerExecutionError, type WorkerResult } from './worker.js';

/**
 * The full lineage of a Pheromone, outer-to-inner. A field restored from an
 * older Honey may carry only the flat forkId/branchId tags; those are one
 * top-level tag and are promoted here.
 */
export function currentLineage(pheromone: Pheromone): readonly BranchTag[] {
  if (pheromone.lineage !== undefined && pheromone.lineage.length > 0) {
    return pheromone.lineage;
  }
  if (pheromone.forkId !== undefined && pheromone.branchId !== undefined) {
    return [{ forkId: pheromone.forkId, branchId: pheromone.branchId }];
  }
  return [];
}

export function currentTag(lineage: readonly BranchTag[]): BranchTag | undefined {
  return lineage.at(-1);
}

/**
 * Moves one Pheromone along a normal beeline: the same object keeps its `id`
 * and only its value and branch tags are replaced. `at` is stamped at enqueue
 * time by the field, so it is deliberately not touched here.
 */
export function movePheromone(
  pheromone: Pheromone,
  value: Value,
  lineage?: readonly BranchTag[],
): Pheromone {
  pheromone.value = structuredClone(value);
  const current = lineage === undefined ? undefined : currentTag(lineage);
  if (current === undefined) {
    delete pheromone.forkId;
    delete pheromone.branchId;
  } else {
    pheromone.forkId = current.forkId;
    pheromone.branchId = current.branchId;
  }
  if (lineage === undefined || lineage.length === 0) {
    delete pheromone.lineage;
  } else {
    pheromone.lineage = copyLineage(lineage);
  }
  return pheromone;
}

export function sameLineage(left: readonly BranchTag[], right: readonly BranchTag[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a?.forkId !== b?.forkId || a?.branchId !== b?.branchId) {
      return false;
    }
  }
  return true;
}

export function copyLineage(lineage: readonly BranchTag[]): BranchTag[] {
  return lineage.map((tag) => ({ forkId: tag.forkId, branchId: tag.branchId }));
}

/**
 * Keeps the flat compatibility tags pointing at the last lineage tag and
 * promotes a legacy flat tag into a one-element lineage. The input is cloned.
 */
export function normalizePheromone(pheromone: Pheromone): Pheromone {
  const lineage = currentLineage(pheromone);
  const normalized = structuredClone(pheromone);
  delete normalized.lineage;
  if (lineage.length === 0) {
    return normalized;
  }
  const tag = currentTag(lineage);
  if (tag === undefined) {
    return normalized;
  }
  normalized.lineage = copyLineage(lineage);
  normalized.forkId = tag.forkId;
  normalized.branchId = tag.branchId;
  return normalized;
}

/**
 * Worker metadata safe for the composition log: the program name, pid and byte
 * counts only. The output bodies stay in the Value (stdout) or the error
 * (stderr), never in the log.
 */
export function workerLogFields(
  worker: WorkerResult | WorkerExecutionError,
): Partial<RuntimeLogEntry> {
  return {
    program: worker.program,
    ...(worker.pid === undefined ? {} : { pid: worker.pid }),
    stdoutBytes: worker.stdoutBytes,
    stderrBytes: worker.stderrBytes,
    ...(worker.exitCode === undefined ? {} : { exitCode: worker.exitCode }),
  };
}

/**
 * Builds the single Merge output Value. `arrived` is already in required order
 * followed by the optional branches that arrived, in optional config order.
 *
 * `text` keeps the Stage 3A newline join. `object` keys by branchId and `array`
 * keeps only the branch Values, both wrapped in a `structured` Value so no
 * information is flattened. The Merge output still carries no fork/branch tags.
 */
export function combineMergeValues(
  combine: MergeCombine,
  arrived: readonly Pheromone[],
): Value {
  if (combine === 'text') {
    const text = arrived.map((pheromone) => serializeValue(pheromone.value)).join('\n');
    return { kind: 'text', text };
  }

  if (combine === 'object') {
    const entries: [string, JsonValue][] = [];
    for (const pheromone of arrived) {
      const branchId = pheromone.branchId;
      if (branchId === undefined) {
        throw new Error('merge branch is missing its branch id');
      }
      entries.push([branchId, valueAsJson(pheromone.value)]);
    }
    return { kind: 'structured', value: Object.fromEntries(entries) };
  }

  return {
    kind: 'structured',
    value: arrived.map((pheromone) => valueAsJson(pheromone.value)),
  };
}

/**
 * A Value is a plain JSON object at runtime; the compiler cannot infer that
 * from the union, so this cast documents the JSON-safe relationship used by
 * `structured` Merge output.
 */
function valueAsJson(value: Value): JsonValue {
  return value as unknown as JsonValue;
}

export function evaluateCondition(
  config: Exclude<ConditionConfig, { mode: 'worker' }>,
  value: Value,
): 'true' | 'false' {
  if (config.mode === 'boolean') {
    return evaluateBoolean(value);
  }

  if (config.mode === 'choice') {
    if (value.kind !== 'choice') {
      throw new Error(`condition 'choice' expects a choice value, got '${value.kind}'`);
    }
    return value.choice === config.choice ? 'true' : 'false';
  }

  const text = serializeValue(value);
  if (config.contains !== undefined) {
    return text.includes(config.contains) ? 'true' : 'false';
  }
  if (config.equals !== undefined) {
    return text === config.equals ? 'true' : 'false';
  }
  throw new Error('condition text mode needs contains or equals');
}

function evaluateBoolean(value: Value): 'true' | 'false' {
  if (value.kind !== 'boolean') {
    throw new Error(`condition 'boolean' expects a boolean value, got '${value.kind}'`);
  }
  return value.value ? 'true' : 'false';
}
