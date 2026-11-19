import type {
  NodeDefinition,
  NodeId,
  TriggerDefinition,
  TriggerSchedule,
} from './types.js';
import {
  ISO_INSTANT_PATTERN,
  ID_PATTERN,
  isNonEmptyString,
  isPositiveInteger,
  isRecord,
  pushUnknownFields,
} from './definition-primitives.js';

export function parseTriggerSchedule(
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

export function parseTriggers(
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
