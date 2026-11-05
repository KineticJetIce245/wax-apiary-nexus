import { createHash } from 'node:crypto';

import type {
  CompositionDefaults,
  CompositionDefinition,
  ConditionConfig,
  CounterConfig,
  EdgeDefinition,
  EdgeWhen,
  ForagerConfig,
  ForkBranch,
  ForkConfig,
  MergeCombine,
  MergeConfig,
  NodeDefinition,
  NodeId,
  TriggerDefinition,
  TriggerSchedule,
  UserConfig,
  WorkerConfig,
} from './types.js';
import { DEFAULT_WORKER_TIMEOUT_MS } from './worker.js';

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * An `at` schedule must name one instant. A date without `Z` or an offset is
 * rejected instead of being interpreted in the host's local timezone.
 */
const ISO_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

const DEFAULT_MIN_INTERVAL_MS = 1000;
const DEFAULT_QUEUE_MAX = 1024;
const DEFAULT_QUEUE_TTL_MS = 604_800_000;

/**
 * Stage 5B: how long a Merge waits for its required branches, measured from the
 * first branch arrival for one forkId. The upper bound keeps the persisted
 * deadline (epoch ms plus this value) a safe 32-bit timer delay.
 */
export const DEFAULT_MERGE_TIMEOUT_MS = 600_000;
export const MAX_MERGE_TIMEOUT_MS = 2_147_483_647;

const WHEN_VALUES: readonly EdgeWhen[] = ['true', 'false', 'continue', 'done'];

export class CompositionValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`invalid composition:\n${issues.map((issue) => `- ${issue}`).join('\n')}`);
    this.name = 'CompositionValidationError';
    this.issues = issues;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function pushUnknownFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  issues: string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      issues.push(`${path}: unknown field '${key}'`);
    }
  }
}

function pushUnknownPlaceholders(prompt: string, path: string, issues: string[]): void {
  for (const match of prompt.matchAll(/\{\{([^}]*)\}\}/g)) {
    const name = match[1] ?? '';
    if (name.trim() !== 'input') {
      issues.push(`${path}: unsupported template placeholder '{{${name}}}' (only {{input}})`);
    }
  }

  const leftover = prompt.replace(/\{\{[^}]*\}\}/g, '');
  if (leftover.includes('{{') || leftover.includes('}}')) {
    issues.push(`${path}: unterminated template placeholder`);
  }
}

function parseForagerConfig(
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

function parseWorkerConfig(
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

function hasParentSegment(value: string): boolean {
  const segments = process.platform === 'win32' ? value.split(/[\\/]+/) : value.split('/');
  return segments.includes('..');
}

function parseConditionConfig(
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

function parseUserConfig(
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

function parseCounterConfig(
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

function parseForkConfig(
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

function parseMergeConfig(
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

function parseDefaults(value: unknown, issues: string[]): CompositionDefaults {
  const defaults: CompositionDefaults = {
    minIntervalMs: DEFAULT_MIN_INTERVAL_MS,
    queueMax: DEFAULT_QUEUE_MAX,
    queueTtlMs: DEFAULT_QUEUE_TTL_MS,
  };

  if (value === undefined) {
    return defaults;
  }
  if (!isRecord(value)) {
    issues.push('defaults: expected an object');
    return defaults;
  }

  pushUnknownFields(value, ['minIntervalMs', 'queueMax', 'queueTtlMs'], 'defaults', issues);

  if (value['minIntervalMs'] !== undefined) {
    if (isPositiveInteger(value['minIntervalMs']) && value['minIntervalMs'] >= 1000) {
      defaults.minIntervalMs = value['minIntervalMs'];
    } else {
      issues.push('defaults.minIntervalMs: expected an integer >= 1000');
    }
  }
  if (value['queueMax'] !== undefined) {
    if (isPositiveInteger(value['queueMax'])) {
      defaults.queueMax = value['queueMax'];
    } else {
      issues.push('defaults.queueMax: expected a positive integer');
    }
  }
  if (value['queueTtlMs'] !== undefined) {
    if (isPositiveInteger(value['queueTtlMs'])) {
      defaults.queueTtlMs = value['queueTtlMs'];
    } else {
      issues.push('defaults.queueTtlMs: expected a positive integer');
    }
  }

  return defaults;
}

function parseNodes(
  value: unknown,
  defaults: CompositionDefaults,
  issues: string[],
): Map<NodeId, NodeDefinition> {
  const nodes = new Map<NodeId, NodeDefinition>();

  if (!isRecord(value)) {
    issues.push('nodes: expected an object keyed by node id');
    return nodes;
  }

  const entries = Object.entries(value);
  if (entries.length === 0) {
    issues.push('nodes: expected at least one node');
    return nodes;
  }

  for (const [id, raw] of entries) {
    const path = `nodes.${id}`;
    if (!ID_PATTERN.test(id)) {
      issues.push(`${path}: id must match ${ID_PATTERN.source}`);
    }
    if (!isRecord(raw)) {
      issues.push(`${path}: expected an object`);
      continue;
    }

    pushUnknownFields(raw, ['kind', 'config', 'minIntervalMs'], path, issues);

    const kind = raw['kind'];
    if (typeof kind !== 'string') {
      issues.push(`${path}.kind: expected a string`);
      continue;
    }
    if (
      kind !== 'forager' &&
      kind !== 'worker' &&
      kind !== 'condition' &&
      kind !== 'counter' &&
      kind !== 'user' &&
      kind !== 'fork' &&
      kind !== 'merge'
    ) {
      issues.push(`${path}.kind: unknown node kind '${kind}'`);
      continue;
    }

    const minIntervalMs = raw['minIntervalMs'] ?? defaults.minIntervalMs;
    if (!isPositiveInteger(minIntervalMs) || minIntervalMs < 1000) {
      issues.push(`${path}.minIntervalMs: expected an integer >= 1000`);
      continue;
    }

    const config = raw['config'];
    if (!isRecord(config)) {
      issues.push(`${path}.config: expected an object`);
      continue;
    }

    const configPath = `${path}.config`;
    if (kind === 'forager') {
      const parsed = parseForagerConfig(config, configPath, issues);
      if (parsed !== null) {
        nodes.set(id, { id, kind, config: parsed, minIntervalMs });
      }
    } else if (kind === 'worker') {
      const parsed = parseWorkerConfig(config, configPath, issues);
      if (parsed !== null) {
        nodes.set(id, { id, kind, config: parsed, minIntervalMs });
      }
    } else if (kind === 'condition') {
      const parsed = parseConditionConfig(config, configPath, issues);
      if (parsed !== null) {
        nodes.set(id, { id, kind, config: parsed, minIntervalMs });
      }
    } else if (kind === 'counter') {
      const parsed = parseCounterConfig(config, configPath, issues);
      if (parsed !== null) {
        nodes.set(id, { id, kind, config: parsed, minIntervalMs });
      }
    } else if (kind === 'fork') {
      const parsed = parseForkConfig(config, configPath, issues);
      if (parsed !== null) {
        nodes.set(id, { id, kind, config: parsed, minIntervalMs });
      }
    } else if (kind === 'merge') {
      const parsed = parseMergeConfig(config, configPath, issues);
      if (parsed !== null) {
        nodes.set(id, { id, kind, config: parsed, minIntervalMs });
      }
    } else {
      const parsed = parseUserConfig(config, configPath, issues);
      if (parsed !== null) {
        nodes.set(id, { id, kind, config: parsed, minIntervalMs });
      }
    }
  }

  return nodes;
}

function parseEdges(
  value: unknown,
  nodes: ReadonlyMap<NodeId, NodeDefinition>,
  issues: string[],
): EdgeDefinition[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    issues.push('edges: expected an array');
    return [];
  }

  const edges: EdgeDefinition[] = [];
  const seen = new Set<string>();

  value.forEach((raw, index) => {
    const path = `edges[${index}]`;
    if (!isRecord(raw)) {
      issues.push(`${path}: expected an object`);
      return;
    }

    pushUnknownFields(raw, ['id', 'from', 'to', 'when'], path, issues);

    let valid = true;
    const id = raw['id'];
    if (!isNonEmptyString(id) || !ID_PATTERN.test(id)) {
      issues.push(`${path}.id: expected an id matching ${ID_PATTERN.source}`);
      valid = false;
    } else if (seen.has(id)) {
      issues.push(`${path}.id: duplicate edge id '${id}'`);
      valid = false;
    } else {
      seen.add(id);
    }

    const from = raw['from'];
    if (!isNonEmptyString(from)) {
      issues.push(`${path}.from: expected a node id`);
      valid = false;
    } else if (!nodes.has(from)) {
      issues.push(`${path}.from: unknown node '${from}'`);
      valid = false;
    }

    const to = raw['to'];
    if (!isNonEmptyString(to)) {
      issues.push(`${path}.to: expected a node id`);
      valid = false;
    } else if (!nodes.has(to)) {
      issues.push(`${path}.to: unknown node '${to}'`);
      valid = false;
    }

    const when = raw['when'];
    if (when !== undefined && !WHEN_VALUES.includes(when as EdgeWhen)) {
      issues.push(`${path}.when: expected 'true', 'false', 'continue' or 'done'`);
      valid = false;
    }

    if (!valid) {
      return;
    }

    edges.push(
      when === undefined
        ? { id: id as string, from: from as string, to: to as string }
        : { id: id as string, from: from as string, to: to as string, when: when as EdgeWhen },
    );
  });

  return edges;
}

function validateEdgeShape(
  nodes: ReadonlyMap<NodeId, NodeDefinition>,
  edges: readonly EdgeDefinition[],
  issues: string[],
): void {
  for (const node of nodes.values()) {
    const outgoing = edges.filter((edge) => edge.from === node.id);

    if (node.kind === 'fork') {
      node.config.branches.forEach((branch, index) => {
        if (!nodes.has(branch.to)) {
          issues.push(
            `nodes.${node.id}.config.branches[${index}].to: unknown node '${branch.to}'`,
          );
        }
      });
      if (outgoing.length > 0) {
        issues.push(`nodes.${node.id}: a fork node uses branches and has no normal outgoing edge`);
      }
      continue;
    }

    if (node.kind === 'merge') {
      for (const edge of outgoing) {
        if (edge.when !== undefined) {
          issues.push(`edges.${edge.id}: 'when' is only allowed on condition and counter edges`);
        }
      }
      if (outgoing.length > 1) {
        issues.push(`nodes.${node.id}: a merge node has at most one outgoing edge`);
      }
      continue;
    }

    if (node.kind === 'forager' || node.kind === 'worker' || node.kind === 'user') {
      for (const edge of outgoing) {
        if (edge.when !== undefined) {
          issues.push(`edges.${edge.id}: 'when' is only allowed on condition and counter edges`);
        }
      }
      if (outgoing.length > 1) {
        issues.push(`nodes.${node.id}: a ${node.kind} node has at most one outgoing edge`);
      }
      continue;
    }

    const required: readonly EdgeWhen[] =
      node.kind === 'condition' ? ['true', 'false'] : ['continue', 'done'];

    for (const when of required) {
      const matches = outgoing.filter((edge) => edge.when === when);
      if (matches.length !== 1) {
        issues.push(
          `nodes.${node.id}: expected exactly one '${when}' outgoing edge, found ${matches.length}`,
        );
      }
    }

    if (outgoing.length !== required.length) {
      const labels = outgoing.map((edge) => edge.when ?? '(default)').join(', ');
      issues.push(
        `nodes.${node.id}: expected only the ${required.join("/")} edges, found ${outgoing.length} (${labels})`,
      );
    }
  }
}

function parseTriggerSchedule(
  value: unknown,
  path: string,
  issues: string[],
): TriggerSchedule | null {
  if (!isRecord(value)) {
    issues.push(`${path}: expected an object`);
    return null;
  }

  const kind = value['kind'];
  if (kind === 'at') {
    pushUnknownFields(value, ['kind', 'at'], path, issues);
    const at = value['at'];
    if (!isNonEmptyString(at)) {
      issues.push(`${path}.at: expected an ISO-8601 timestamp with 'Z' or an explicit offset`);
      return null;
    }
    if (!ISO_INSTANT_PATTERN.test(at)) {
      issues.push(
        `${path}.at: expected an ISO-8601 timestamp with 'Z' or an explicit offset (timezone-less times are rejected)`,
      );
      return null;
    }
    if (!Number.isFinite(Date.parse(at))) {
      issues.push(`${path}.at: expected a valid ISO-8601 timestamp`);
      return null;
    }
    return { kind: 'at', at };
  }

  if (kind === 'every') {
    pushUnknownFields(value, ['kind', 'everyMs'], path, issues);
    const everyMs = value['everyMs'];
    if (!isPositiveInteger(everyMs) || everyMs < 1000) {
      issues.push(`${path}.everyMs: expected an integer >= 1000`);
      return null;
    }
    return { kind: 'every', everyMs };
  }

  issues.push(`${path}.kind: expected 'at' or 'every'`);
  return null;
}

function parseTriggers(
  value: unknown,
  nodes: ReadonlyMap<NodeId, NodeDefinition>,
  issues: string[],
): TriggerDefinition[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    issues.push('triggers: expected an array');
    return [];
  }

  const triggers: TriggerDefinition[] = [];
  const seen = new Set<string>();

  value.forEach((raw, index) => {
    const path = `triggers[${index}]`;
    if (!isRecord(raw)) {
      issues.push(`${path}: expected an object`);
      return;
    }
    pushUnknownFields(raw, ['id', 'target', 'schedule'], path, issues);

    let valid = true;
    const id = raw['id'];
    if (!isNonEmptyString(id) || !ID_PATTERN.test(id)) {
      issues.push(`${path}.id: expected an id matching ${ID_PATTERN.source}`);
      valid = false;
    } else if (seen.has(id)) {
      issues.push(`${path}.id: duplicate trigger id '${id}'`);
      valid = false;
    } else {
      seen.add(id);
    }

    const target = raw['target'];
    if (!isNonEmptyString(target)) {
      issues.push(`${path}.target: expected a node id`);
      valid = false;
    } else {
      const node = nodes.get(target);
      if (node === undefined) {
        issues.push(`${path}.target: unknown node '${target}'`);
        valid = false;
      } else if (node.kind !== 'forager' && node.kind !== 'worker' && node.kind !== 'user') {
        issues.push(
          `${path}.target: scheduled trigger target '${target}' must be a forager, worker or user node, got '${node.kind}'`,
        );
        valid = false;
      }
    }

    const schedule = parseTriggerSchedule(raw['schedule'], `${path}.schedule`, issues);
    if (schedule === null) {
      valid = false;
    }

    if (valid) {
      triggers.push({
        id: id as string,
        target: target as string,
        schedule: schedule as TriggerSchedule,
      });
    }
  });

  return triggers;
}

export function parseComposition(input: unknown): CompositionDefinition {
  const issues: string[] = [];

  if (!isRecord(input)) {
    throw new CompositionValidationError(['composition: expected an object']);
  }

  pushUnknownFields(
    input,
    ['schemaVersion', 'id', 'nodes', 'edges', 'defaults', 'triggers'],
    'composition',
    issues,
  );

  if (input['schemaVersion'] !== 1) {
    issues.push('schemaVersion: expected 1');
  }

  const id = input['id'];
  if (!isNonEmptyString(id)) {
    issues.push('id: expected a non-empty string');
  }

  const defaults = parseDefaults(input['defaults'], issues);
  const nodes = parseNodes(input['nodes'], defaults, issues);
  const edges = parseEdges(input['edges'], nodes, issues);
  validateEdgeShape(nodes, edges, issues);
  const triggers = parseTriggers(input['triggers'], nodes, issues);

  if (issues.length > 0) {
    throw new CompositionValidationError(issues);
  }

  const composition: CompositionDefinition = {
    schemaVersion: 1,
    id: id as string,
    graphRevision: computeGraphRevision(id as string, nodes, edges, defaults),
    nodes,
    edges,
    defaults,
    triggers,
  };

  return composition;
}

function computeGraphRevision(
  id: string,
  nodes: ReadonlyMap<NodeId, NodeDefinition>,
  edges: readonly EdgeDefinition[],
  defaults: CompositionDefaults,
): string {
  const canonical = JSON.stringify({
    id,
    nodes: [...nodes.values()].map((node) => ({
      id: node.id,
      kind: node.kind,
      config: node.config,
      minIntervalMs: node.minIntervalMs,
    })),
    edges,
    defaults,
  });

  return createHash('sha256').update(canonical).digest('hex').slice(0, 12);
}
