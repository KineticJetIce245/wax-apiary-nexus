import type {
  CompositionDefaults,
  EdgeDefinition,
  EdgeWhen,
  NodeDefinition,
  NodeId,
} from './types.js';
import {
  DEFAULT_MIN_INTERVAL_MS,
  DEFAULT_QUEUE_MAX,
  DEFAULT_QUEUE_TTL_MS,
} from './definition-constants.js';
import { parseSpreadConfig, parseGatherConfig } from './definition-flow-config.js';
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
      kind !== 'spread' &&
      kind !== 'gather'
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
    } else if (kind === 'spread') {
      const parsed = parseSpreadConfig(config, configPath, issues);
      if (parsed !== null) {
        nodes.set(id, { id, kind, config: parsed, minIntervalMs });
      }
    } else if (kind === 'gather') {
      const parsed = parseGatherConfig(config, configPath, issues);
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
      node.config.branches.forEach((branch, index) => {
        if (!nodes.has(branch.to)) {
          issues.push(
            `nodes.${node.id}.config.branches[${index}].to: unknown node '${branch.to}'`,
          );
        }
      });
      if (outgoing.length > 0) {
        issues.push(`nodes.${node.id}: a spread node uses branches and has no normal outgoing edge`);
      }
      continue;
    }

    if (node.kind === 'gather') {
      for (const edge of outgoing) {
        if (edge.when !== undefined) {
          issues.push(`edges.${edge.id}: 'when' is only allowed on condition and counter edges`);
        }
      }
      if (outgoing.length > 1) {
        issues.push(`nodes.${node.id}: a gather node has at most one outgoing edge`);
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
