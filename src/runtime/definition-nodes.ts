import type {
  CompositionDefaults,
  EdgeDefinition,
  EdgeWhen,
  FilterConfig,
  JsonValue,
  NodeDefinition,
  NodeId,
  NodeKind,
} from './types.js';
import {
  DEFAULT_MIN_INTERVAL_MS,
  DEFAULT_QUEUE_MAX,
  DEFAULT_QUEUE_TTL_MS,
} from './definition-constants.js';
import { parseSpreadConfig, parseGatherConfig } from './definition-flow-config.js';
import { parseBeeIo, placeholderSources, type BeeIo } from './definition-io.js';
import {
  ID_PATTERN,
  WHEN_VALUES,
  isNonEmptyString,
  isPositiveInteger,
  isRecord,
  pushUnknownFields,
} from './definition-primitives.js';
import {
  parseConditionConfig,
  parseCounterConfig,
  parseForagerConfig,
  parseUserConfig,
  parseWorkerConfig,
} from './definition-task-config.js';

export function parseDefaults(value: unknown, issues: string[]): CompositionDefaults {
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

export function parseNodes(
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
    const node = parseNode(id, raw, defaults, issues);
    if (node !== null) {
      nodes.set(id, node);
    }
  }

  return nodes;
}

interface NodeBaseParts {
  readonly id: NodeId;
  readonly minIntervalMs: number;
  readonly reads: readonly string[];
  readonly writes: readonly string[];
  fallback?: Readonly<Record<string, JsonValue>>;
  filter?: FilterConfig;
}

interface NodeHeader {
  readonly kind: NodeKind;
  readonly minIntervalMs: number;
  readonly config: Record<string, unknown>;
}

function parseNode(
  id: NodeId,
  raw: unknown,
  defaults: CompositionDefaults,
  issues: string[],
): NodeDefinition | null {
  const path = `nodes.${id}`;
  if (!ID_PATTERN.test(id)) {
    issues.push(`${path}: id must match ${ID_PATTERN.source}`);
  }
  if (!isRecord(raw)) {
    issues.push(`${path}: expected an object`);
    return null;
  }
  pushUnknownFields(
    raw,
    ['kind', 'config', 'minIntervalMs', 'reads', 'writes', 'fallback', 'filter'],
    path,
    issues,
  );
  const header = parseNodeHeader(raw, path, defaults, issues);
  if (header === null) {
    return null;
  }
  const io = parseBeeIo(raw, header.kind, path, issues);
  if (io === null) {
    return null;
  }
  const base = nodeBaseParts(id, header.minIntervalMs, io);
  const configPath = `${path}.config`;
  if (isTaskKind(header.kind)) {
    return parseTaskNode(
      header.kind,
      header.config,
      configPath,
      base,
      issues,
      placeholderSources(io),
    );
  }
  return parseControlNode(header.kind, header.config, configPath, base, issues);
}

function parseNodeHeader(
  raw: Record<string, unknown>,
  path: string,
  defaults: CompositionDefaults,
  issues: string[],
): NodeHeader | null {
  const kind = raw['kind'];
  if (typeof kind !== 'string' || !isNodeKind(kind)) {
    issues.push(`${path}.kind: unknown node kind '${String(kind)}'`);
    return null;
  }
  const minIntervalMs = raw['minIntervalMs'] ?? defaults.minIntervalMs;
  if (!isPositiveInteger(minIntervalMs) || minIntervalMs < 1000) {
    issues.push(`${path}.minIntervalMs: expected an integer >= 1000`);
    return null;
  }
  const config = raw['config'];
  if (!isRecord(config)) {
    issues.push(`${path}.config: expected an object`);
    return null;
  }
  return { kind, minIntervalMs, config };
}

function nodeBaseParts(
  id: NodeId,
  minIntervalMs: number,
  io: BeeIo,
): NodeBaseParts {
  const base: NodeBaseParts = { id, minIntervalMs, reads: io.reads, writes: io.writes };
  if (io.fallback !== undefined) {
    base.fallback = io.fallback;
  }
  if (io.filter !== undefined) {
    base.filter = io.filter;
  }
  return base;
}

function isTaskKind(
  kind: NodeKind,
): kind is 'forager' | 'worker' | 'condition' | 'counter' {
  return kind === 'forager' || kind === 'worker' || kind === 'condition' || kind === 'counter';
}

function isNodeKind(kind: string): kind is NodeKind {
  return (
    kind === 'forager' ||
    kind === 'worker' ||
    kind === 'condition' ||
    kind === 'counter' ||
    kind === 'user' ||
    kind === 'spread' ||
    kind === 'gather'
  );
}

function parseTaskNode(
  kind: 'forager' | 'worker' | 'condition' | 'counter',
  config: Record<string, unknown>,
  configPath: string,
  base: NodeBaseParts,
  issues: string[],
  placeholders: readonly string[],
): NodeDefinition | null {
  if (kind === 'forager') {
    const parsed = parseForagerConfig(config, configPath, issues, placeholders);
    return parsed === null ? null : { ...base, kind, config: parsed };
  }
  if (kind === 'worker') {
    const parsed = parseWorkerConfig(config, configPath, issues);
    return parsed === null ? null : { ...base, kind, config: parsed };
  }
  if (kind === 'condition') {
    const parsed = parseConditionConfig(config, configPath, issues);
    return parsed === null ? null : { ...base, kind, config: parsed };
  }
  const parsed = parseCounterConfig(config, configPath, issues);
  return parsed === null ? null : { ...base, kind, config: parsed };
}

function parseControlNode(
  kind: 'user' | 'spread' | 'gather',
  config: Record<string, unknown>,
  configPath: string,
  base: NodeBaseParts,
  issues: string[],
): NodeDefinition | null {
  if (kind === 'user') {
    const parsed = parseUserConfig(config, configPath, issues);
    return parsed === null ? null : { ...base, kind, config: parsed };
  }
  if (kind === 'spread') {
    const parsed = parseSpreadConfig(config, configPath, issues);
    return parsed === null ? null : { ...base, kind, config: parsed };
  }
  const parsed = parseGatherConfig(config, configPath, issues);
  return parsed === null ? null : { ...base, kind, config: parsed };
}

export function parseEdges(
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

export function validateEdgeShape(
  nodes: ReadonlyMap<NodeId, NodeDefinition>,
  edges: readonly EdgeDefinition[],
  issues: string[],
): void {
  for (const node of nodes.values()) {
    const outgoing = edges.filter((edge) => edge.from === node.id);
    if (node.kind === 'spread') {
      validateSpreadTargets(node, nodes, outgoing, issues);
      continue;
    }
    if (node.kind === 'gather') {
      validateGatherEdges(node, outgoing, issues);
      continue;
    }
    if (node.kind === 'condition' || node.kind === 'counter') {
      validateBranchedEdges(node, outgoing, issues);
      continue;
    }
    validateTaskEdges(node, outgoing, issues);
  }
}

function validateSpreadTargets(
  node: Extract<NodeDefinition, { kind: 'spread' }>,
  nodes: ReadonlyMap<NodeId, NodeDefinition>,
  outgoing: readonly EdgeDefinition[],
  issues: string[],
): void {
  const targets = Array.isArray(node.config.targets)
    ? node.config.targets
    : Object.keys(node.config.targets);
  for (const target of targets) {
    if (!nodes.has(target)) {
      issues.push(`nodes.${node.id}.config.targets: unknown node '${target}'`);
    }
  }
  if (outgoing.length > 0) {
    issues.push(`nodes.${node.id}: a spread node uses config.targets and has no normal outgoing edge`);
  }
}

function validateGatherEdges(
  node: Extract<NodeDefinition, { kind: 'gather' }>,
  outgoing: readonly EdgeDefinition[],
  issues: string[],
): void {
  for (const edge of outgoing) {
    if (edge.when !== undefined) {
      issues.push(`edges.${edge.id}: 'when' is only allowed on condition and counter edges`);
    }
  }
  if (outgoing.length > 1) {
    issues.push(`nodes.${node.id}: a gather node has at most one outgoing edge`);
  }
}

function validateTaskEdges(
  node: Extract<NodeDefinition, { kind: 'forager' | 'worker' | 'user' }>,
  outgoing: readonly EdgeDefinition[],
  issues: string[],
): void {
  for (const edge of outgoing) {
    if (edge.when !== undefined) {
      issues.push(`edges.${edge.id}: 'when' is only allowed on condition and counter edges`);
    }
  }
  if (outgoing.length > 1) {
    issues.push(`nodes.${node.id}: a ${node.kind} node has at most one outgoing edge`);
  }
}

function validateBranchedEdges(
  node: Extract<NodeDefinition, { kind: 'condition' | 'counter' }>,
  outgoing: readonly EdgeDefinition[],
  issues: string[],
): void {
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
      `nodes.${node.id}: expected only the ${required.join('/')} edges, found ${outgoing.length} (${labels})`,
    );
  }
}
