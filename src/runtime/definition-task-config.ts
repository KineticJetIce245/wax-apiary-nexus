import type {
  ConditionConfig,
  CounterConfig,
  ForagerConfig,
  UserConfig,
  WorkerConfig,
} from './types.js';
import { DEFAULT_WORKER_TIMEOUT_MS } from './worker.js';
import {
  hasParentSegment,
  isNonEmptyString,
  isPositiveInteger,
  pushUnknownFields,
  pushUnknownPlaceholders,
} from './definition-primitives.js';

export function parseForagerConfig(
  config: Record<string, unknown>,
  path: string,
  issues: string[],
): ForagerConfig | null {
  pushUnknownFields(config, ['connection', 'prompt'], path, issues);

  let valid = true;
  if (!isNonEmptyString(config['connection'])) {
    issues.push(`${path}.connection: expected a non-empty string`);
    valid = false;
  }
  if (!isNonEmptyString(config['prompt'])) {
    issues.push(`${path}.prompt: expected a non-empty string`);
    valid = false;
  } else {
    pushUnknownPlaceholders(config['prompt'], `${path}.prompt`, issues);
  }

  if (!valid) {
    return null;
  }
  return {
    connection: config['connection'] as string,
    prompt: config['prompt'] as string,
  };
}

export function parseWorkerConfig(
  config: Record<string, unknown>,
  path: string,
  issues: string[],
  extraFields: readonly string[] = [],
): WorkerConfig | null {
  // A Condition uses the same fields plus `mode`; a Worker node does not.
  pushUnknownFields(
    config,
    [...extraFields, 'command', 'args', 'cwd', 'timeoutMs'],
    path,
    issues,
  );

  let valid = true;
  const command = config['command'];
  if (!isNonEmptyString(command)) {
    issues.push(`${path}.command: expected a non-empty string`);
    valid = false;
  } else if (command.includes('\0')) {
    issues.push(`${path}.command: must not contain a NUL character`);
    valid = false;
  }

  const rawArgs = config['args'];
  const args: string[] = [];
  if (rawArgs !== undefined) {
    if (!Array.isArray(rawArgs)) {
      issues.push(`${path}.args: expected an array of strings`);
      valid = false;
    } else {
      rawArgs.forEach((arg, index) => {
        if (typeof arg !== 'string') {
          issues.push(`${path}.args[${index}]: expected a string`);
          valid = false;
        } else if (arg.includes('\0')) {
          issues.push(`${path}.args[${index}]: must not contain a NUL character`);
          valid = false;
        } else {
          args.push(arg);
        }
      });
    }
  }

  const rawCwd = config['cwd'];
  let cwd = '.';
  if (rawCwd !== undefined) {
    if (!isNonEmptyString(rawCwd)) {
      issues.push(`${path}.cwd: expected a non-empty string`);
      valid = false;
    } else if (rawCwd.includes('\0')) {
      issues.push(`${path}.cwd: must not contain a NUL character`);
      valid = false;
    } else if (hasParentSegment(rawCwd)) {
      issues.push(`${path}.cwd: must not contain '..'`);
      valid = false;
    } else {
      cwd = rawCwd;
    }
  }

  const rawTimeout = config['timeoutMs'];
  let timeoutMs = DEFAULT_WORKER_TIMEOUT_MS;
  if (rawTimeout !== undefined) {
    if (!isPositiveInteger(rawTimeout)) {
      issues.push(`${path}.timeoutMs: expected a positive integer`);
      valid = false;
    } else {
      timeoutMs = rawTimeout;
    }
  }

  if (!valid) {
    return null;
  }
  return {
    command: command as string,
    args,
    cwd,
    timeoutMs,
  };
}

export function parseConditionConfig(
  config: Record<string, unknown>,
  path: string,
  issues: string[],
): ConditionConfig | null {
  const mode = config['mode'];
  if (mode === 'text') {
    pushUnknownFields(config, ['mode', 'contains', 'equals'], path, issues);
    const hasContains = config['contains'] !== undefined;
    const hasEquals = config['equals'] !== undefined;
    if (hasContains === hasEquals) {
      issues.push(`${path}: text mode needs exactly one of 'contains' or 'equals'`);
      return null;
    }
    const field = hasContains ? 'contains' : 'equals';
    if (!isNonEmptyString(config[field])) {
      issues.push(`${path}.${field}: expected a non-empty string`);
      return null;
    }
    return hasContains
      ? { mode: 'text', contains: config['contains'] as string }
      : { mode: 'text', equals: config['equals'] as string };
  }

  if (mode === 'boolean') {
    pushUnknownFields(config, ['mode'], path, issues);
    return { mode: 'boolean' };
  }

  if (mode === 'choice') {
    pushUnknownFields(config, ['mode', 'choice'], path, issues);
    if (!isNonEmptyString(config['choice'])) {
      issues.push(`${path}.choice: expected a non-empty string`);
      return null;
    }
    return { mode: 'choice', choice: config['choice'] as string };
  }

  if (mode === 'worker') {
    const worker = parseWorkerConfig(config, path, issues, ['mode']);
    if (worker === null) {
      return null;
    }
    return { mode: 'worker', ...worker };
  }

  issues.push(`${path}.mode: expected 'text', 'boolean', 'choice' or 'worker'`);
  return null;
}

export function parseUserConfig(
  config: Record<string, unknown>,
  path: string,
  issues: string[],
): UserConfig | null {
  pushUnknownFields(config, ['modality', 'prompt', 'choices'], path, issues);

  const modality = config['modality'];
  if (
    modality !== 'text' &&
    modality !== 'choice' &&
    modality !== 'yes-no' &&
    modality !== 'message' &&
    modality !== 'image' &&
    modality !== 'file'
  ) {
    issues.push(
      `${path}.modality: expected 'text', 'choice', 'yes-no', 'message', 'image' or 'file'`,
    );
    return null;
  }
  if (!isNonEmptyString(config['prompt'])) {
    issues.push(`${path}.prompt: expected a non-empty string`);
    return null;
  }

  const rawChoices = config['choices'];
  if (modality === 'choice') {
    if (!Array.isArray(rawChoices) || rawChoices.length === 0) {
      issues.push(`${path}.choices: choice mode needs a non-empty array of labels`);
      return null;
    }
    const choices: string[] = [];
    for (const choice of rawChoices) {
      if (!isNonEmptyString(choice)) {
        issues.push(`${path}.choices: every label must be a non-empty string`);
        return null;
      }
      if (choices.includes(choice)) {
        issues.push(`${path}.choices: duplicate label '${choice}'`);
        return null;
      }
      choices.push(choice);
    }
    return { modality, prompt: config['prompt'] as string, choices };
  }

  if (rawChoices !== undefined) {
    issues.push(`${path}.choices: only allowed in choice mode`);
    return null;
  }
  return { modality, prompt: config['prompt'] as string };
}

export function parseCounterConfig(
  config: Record<string, unknown>,
  path: string,
  issues: string[],
): CounterConfig | null {
  pushUnknownFields(config, ['max', 'step'], path, issues);

  let valid = true;
  if (!isPositiveInteger(config['max'])) {
    issues.push(`${path}.max: expected a positive integer`);
    valid = false;
  }

  const step = config['step'] ?? 1;
  if (!isPositiveInteger(step)) {
    issues.push(`${path}.step: expected a positive integer`);
    valid = false;
  }

  if (!valid) {
    return null;
  }
  return { max: config['max'] as number, step: step as number };
}
