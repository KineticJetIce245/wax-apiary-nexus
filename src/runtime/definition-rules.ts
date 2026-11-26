import type { JsonType, JsonValue, Rule } from './types.js';
import { isValidPath } from './value-paths.js';
import { isRecord, pushUnknownFields } from './definition-primitives.js';

const JSON_TYPES: readonly JsonType[] = [
  'string',
  'number',
  'boolean',
  'object',
  'array',
  'null',
];

/**
 * Parses a declarative or code-block rule. M19b executes rules; this slice
 * only validates the shape so a saved graph cannot smuggle an unknown operator.
 */
export function parseRule(raw: unknown, path: string, issues: string[]): Rule | null {
  if (!isRecord(raw)) {
    issues.push(`${path}: expected a rule object`);
    return null;
  }
  if (Object.hasOwn(raw, 'code')) {
    if (Object.keys(raw).length !== 1 || typeof raw['code'] !== 'string' || raw['code'].trim() === '') {
      issues.push(`${path}: expected { code: <non-empty string> }`);
      return null;
    }
    return { code: raw['code'] };
  }
  return parseDeclarativeRule(raw, path, issues);
}

function parseDeclarativeRule(
  raw: Record<string, unknown>,
  path: string,
  issues: string[],
): Rule | null {
  const allowed = ['path', 'equals', 'oneOf', 'exists', 'type'];
  pushUnknownFields(raw, allowed, path, issues);
  const rawPath = raw['path'];
  if (!isValidPath(rawPath, 'read')) {
    issues.push(`${path}.path: expected a dot path`);
    return null;
  }
  const operators = ['equals', 'oneOf', 'exists', 'type'].filter((key) => Object.hasOwn(raw, key));
  if (operators.length !== 1) {
    issues.push(`${path}: expected exactly one of equals, oneOf, exists, type`);
    return null;
  }
  switch (operators[0]) {
    case 'equals':
      return { path: rawPath, equals: raw['equals'] as JsonValue };
    case 'oneOf':
      return parseOneOf(rawPath, raw['oneOf'], path, issues);
    case 'exists':
      return parseExists(rawPath, raw['exists'], path, issues);
    case 'type':
      return parseTypeRule(rawPath, raw['type'], path, issues);
    default:
      return null;
  }
}

function parseOneOf(
  path: string,
  raw: unknown,
  rulePath: string,
  issues: string[],
): Rule | null {
  if (!Array.isArray(raw) || raw.length === 0) {
    issues.push(`${rulePath}.oneOf: expected a non-empty array`);
    return null;
  }
  return { path, oneOf: raw as JsonValue[] };
}

function parseExists(
  path: string,
  raw: unknown,
  rulePath: string,
  issues: string[],
): Rule | null {
  if (raw !== true) {
    issues.push(`${rulePath}.exists: expected true`);
    return null;
  }
  return { path, exists: true };
}

function parseTypeRule(
  path: string,
  raw: unknown,
  rulePath: string,
  issues: string[],
): Rule | null {
  if (typeof raw !== 'string' || !JSON_TYPES.includes(raw as JsonType)) {
    issues.push(`${rulePath}.type: expected one of ${JSON_TYPES.join(', ')}`);
    return null;
  }
  return { path, type: raw as JsonType };
}
