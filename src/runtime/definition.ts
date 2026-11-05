import { createHash } from 'node:crypto';

import type {
  CompositionDefaults,
  CompositionDefinition,
  ConditionConfig,
  CounterConfig,
  EdgeDefinition,
  EdgeWhen,
  ForagerConfig,
  NodeDefinition,
  NodeId,
  UserConfig,
} from './types.js';

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const DEFAULT_MIN_INTERVAL_MS = 1000;
const DEFAULT_QUEUE_MAX = 1024;
const DEFAULT_QUEUE_TTL_MS = 604_800_000;

const WHEN_VALUES: readonly EdgeWhen[] = ['true', 'false', 'continue', 'done'];

const UNSUPPORTED_NODE_KINDS = ['worker', 'fork', 'merge'] as const;

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

  issues.push(`${path}.mode: expected 'text', 'boolean' or 'choice'`);
  return null;
}

function parseUserConfig(
  config: Record<string, unknown>,
  path: string,
  issues: string[],
): UserConfig | null {
  pushUnknownFields(config, ['modality', 'prompt', 'choices'], path, issues);

  const modality = config['modality'];
  if (modality !== 'text' && modality !== 'choice' && modality !== 'yes-no') {
    issues.push(`${path}.modality: expected 'text', 'choice' or 'yes-no'`);
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
    if ((UNSUPPORTED_NODE_KINDS as readonly string[]).includes(kind)) {
      issues.push(`${path}: node kind '${kind}' is not supported in the single-Pheromone slice`);
      continue;
    }
    if (kind !== 'forager' && kind !== 'condition' && kind !== 'counter' && kind !== 'user') {
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

    if (node.kind === 'forager' || node.kind === 'user') {
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

  if (input['triggers'] !== undefined) {
    if (!Array.isArray(input['triggers'])) {
      issues.push('triggers: expected an array');
    } else if (input['triggers'].length > 0) {
      issues.push('triggers: scheduled triggers are not supported in the single-Pheromone slice');
    }
  }

  const defaults = parseDefaults(input['defaults'], issues);
  const nodes = parseNodes(input['nodes'], defaults, issues);
  const edges = parseEdges(input['edges'], nodes, issues);
  validateEdgeShape(nodes, edges, issues);

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
