import type { ForkBranch, ForkConfig, MergeCombine, MergeConfig } from './types.js';
import {
  DEFAULT_MERGE_TIMEOUT_MS,
  MAX_MERGE_TIMEOUT_MS,
} from './definition-constants.js';
import {
  isNonEmptyString,
  isPositiveInteger,
  isRecord,
  pushUnknownFields,
} from './definition-primitives.js';

export function parseForkConfig(
  config: Record<string, unknown>,
  path: string,
  issues: string[],
): ForkConfig | null {
  pushUnknownFields(config, ['branches'], path, issues);

  const rawBranches = config['branches'];
  if (!Array.isArray(rawBranches) || rawBranches.length === 0) {
    issues.push(`${path}.branches: expected a non-empty array`);
    return null;
  }

  const branches: ForkBranch[] = [];
  const seen = new Set<string>();
  let valid = true;

  rawBranches.forEach((raw, index) => {
    const branchPath = `${path}.branches[${index}]`;
    if (!isRecord(raw)) {
      issues.push(`${branchPath}: expected an object`);
      valid = false;
      return;
    }
    pushUnknownFields(raw, ['id', 'to'], branchPath, issues);

    let branchValid = true;
    const id = raw['id'];
    if (!isNonEmptyString(id)) {
      issues.push(`${branchPath}.id: expected a non-empty branch id`);
      branchValid = false;
    } else if (seen.has(id)) {
      issues.push(`${branchPath}.id: duplicate branch id '${id}'`);
      branchValid = false;
    } else {
      seen.add(id);
    }

    const to = raw['to'];
    if (!isNonEmptyString(to)) {
      issues.push(`${branchPath}.to: expected a node id`);
      branchValid = false;
    }

    if (branchValid) {
      branches.push({ id: id as string, to: to as string });
    } else {
      valid = false;
    }
  });

  return valid ? { branches } : null;
}

export function parseMergeConfig(
  config: Record<string, unknown>,
  path: string,
  issues: string[],
): MergeConfig | null {
  pushUnknownFields(config, ['required', 'optional', 'combine', 'timeoutMs'], path, issues);

  let valid = true;
  const rawRequired = config['required'];
  const required: string[] = [];
  if (!Array.isArray(rawRequired) || rawRequired.length === 0) {
    issues.push(`${path}.required: expected a non-empty array of branch ids`);
    valid = false;
  } else {
    for (const [index, branchId] of rawRequired.entries()) {
      if (!isNonEmptyString(branchId)) {
        issues.push(`${path}.required[${index}]: expected a non-empty branch id`);
        valid = false;
      } else if (required.includes(branchId)) {
        issues.push(`${path}.required[${index}]: duplicate required branch '${branchId}'`);
        valid = false;
      } else {
        required.push(branchId);
      }
    }
  }

  // Stage 5A: optional branches are best effort and default to none.
  const optional: string[] = [];
  const rawOptional = config['optional'];
  if (rawOptional !== undefined) {
    if (!Array.isArray(rawOptional)) {
      issues.push(`${path}.optional: expected an array of branch ids`);
      valid = false;
    } else {
      for (const [index, branchId] of rawOptional.entries()) {
        if (!isNonEmptyString(branchId)) {
          issues.push(`${path}.optional[${index}]: expected a non-empty branch id`);
          valid = false;
        } else if (optional.includes(branchId)) {
          issues.push(`${path}.optional[${index}]: duplicate optional branch '${branchId}'`);
          valid = false;
        } else if (required.includes(branchId)) {
          issues.push(
            `${path}.optional[${index}]: branch '${branchId}' is already required`,
          );
          valid = false;
        } else {
          optional.push(branchId);
        }
      }
    }
  }

  // Stage 5C: `object` and `array` emit a structured Value; `text` is unchanged.
  let combine: MergeCombine = 'text';
  const rawCombine = config['combine'];
  if (rawCombine !== undefined) {
    if (rawCombine !== 'text' && rawCombine !== 'object' && rawCombine !== 'array') {
      issues.push(`${path}.combine: expected 'text', 'object' or 'array'`);
      valid = false;
    } else {
      combine = rawCombine;
    }
  }

  // Stage 5B: the deadline starts on the first branch arrival for a forkId, so
  // the config value is a duration and the persisted join stores an absolute
  // instant. The 2^31-1 cap keeps the deadline inside a safe 32-bit timer range.
  let timeoutMs = DEFAULT_MERGE_TIMEOUT_MS;
  const rawTimeoutMs = config['timeoutMs'];
  if (rawTimeoutMs !== undefined) {
    if (
      !isPositiveInteger(rawTimeoutMs) ||
      !Number.isSafeInteger(rawTimeoutMs) ||
      rawTimeoutMs > MAX_MERGE_TIMEOUT_MS
    ) {
      issues.push(
        `${path}.timeoutMs: expected a positive integer <= ${String(MAX_MERGE_TIMEOUT_MS)}`,
      );
      valid = false;
    } else {
      timeoutMs = rawTimeoutMs;
    }
  }

  return valid ? { required, optional, combine, timeoutMs } : null;
}
