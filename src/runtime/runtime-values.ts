import { serializeValue } from './executor.js';
import type { RuntimeLogEntry } from './log.js';
import type { ConditionConfig, Value } from './types.js';
import { WorkerExecutionError, type WorkerResult } from './worker.js';

/**
 * Worker metadata safe for the runtime log: program name, pid and byte counts
 * only. Output bodies stay in the Value (stdout) or the error (stderr).
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
 * Reads the condition placeholder fields used until M19b replaces the config
 * with a rule. `message` is the universal text field; `boolean` and `choice`
 * are ordinary Value fields, not tags.
 */
export function evaluateCondition(
  config: Exclude<ConditionConfig, { mode: 'worker' }>,
  value: Value,
): 'true' | 'false' {
  switch (config.mode) {
    case 'boolean':
      return evaluateBooleanField(value);
    case 'choice':
      return evaluateChoice(config.choice, value);
    case 'text':
      return evaluateText(config, value);
  }
}

function evaluateBooleanField(value: Value): 'true' | 'false' {
  const flag = value['boolean'];
  if (typeof flag !== 'boolean') {
    throw new Error("condition 'boolean' expects a boolean field 'boolean'");
  }
  return flag ? 'true' : 'false';
}

function evaluateChoice(expected: string, value: Value): 'true' | 'false' {
  const choice = value['choice'];
  if (typeof choice !== 'string') {
    throw new Error("condition 'choice' expects a string field 'choice'");
  }
  return choice === expected ? 'true' : 'false';
}

function evaluateText(
  config: { readonly contains?: string; readonly equals?: string },
  value: Value,
): 'true' | 'false' {
  const text = serializeValue(value);
  if (config.contains !== undefined) {
    return text.includes(config.contains) ? 'true' : 'false';
  }
  if (config.equals !== undefined) {
    return text === config.equals ? 'true' : 'false';
  }
  throw new Error('condition text mode needs contains or equals');
}
