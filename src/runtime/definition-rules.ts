import { assertCodeSyntax, runCodeRule } from './code-rule.js';
import { RuleExecutionError } from './errors.js';
import { assertJsonValue } from './json-value.js';
import type { GroupKey, JsonType, JsonValue, Rule, Value } from './types.js';
import { getPath, isValidPath, jsonEquals, jsonTypeOf } from './value-paths.js';
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
 * Parses a declarative or code-block rule. Code blocks are syntax-checked here
 * so a saved graph cannot carry a rule that only fails at activation.
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
    const before = issues.length;
    assertCodeSyntax(raw['code'], `${path}.code`, issues);
    return issues.length === before ? { code: raw['code'] } : null;
  }
  return parseDeclarativeRule(raw, path, issues);
}

/**
 * Evaluates a rule against a Value. A code block must return a boolean; any
 * throw, timeout or wrong result type is a typed error and the caller drops the
 * input per the temporary error design (ARCHITECTURE.md §9).
 */
export function matchesRule(rule: Rule, value: Value, label: string): boolean {
  if ('code' in rule) {
    const result = runCodeRule(rule.code, value, label);
    if (typeof result !== 'boolean') {
      throw new RuleExecutionError(`${label} code block must return a boolean`);
    }
    return result;
  }
  const found = getPath(value, rule.path);
  if (!found.found) {
    return false;
  }
  if ('exists' in rule) {
    return true;
  }
  if ('equals' in rule) {
    return jsonEquals(found.value as JsonValue, rule.equals);
  }
  if ('oneOf' in rule) {
    return rule.oneOf.some((expected) => jsonEquals(found.value as JsonValue, expected));
  }
  return jsonTypeOf(found.value as JsonValue) === rule.type;
}

/**
 * Extracts a group key (dot path or code block) as a non-empty string. A
 * missing or empty key is a typed rule error; M19d turns that into a drop.
 */
export function evaluateGroupKey(key: GroupKey, value: Value, label: string): string {
  if (typeof key === 'string') {
    const found = getPath(value, key);
    if (!found.found) {
      throw new RuleExecutionError(`${label} group key '${key}' is missing`);
    }
    if (typeof found.value !== 'string' || found.value.trim() === '') {
      throw new RuleExecutionError(`${label} group key '${key}' must be a non-empty string`);
    }
    return found.value;
  }
  const result = runCodeRule(key.code, value, `${label} group key`);
  if (typeof result !== 'string' || result.trim() === '') {
    throw new RuleExecutionError(`${label} code group key must return a non-empty string`);
  }
  return result;
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
      return parseEquals(rawPath, raw['equals'], path, issues);
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

function parseEquals(
  path: string,
  raw: unknown,
  rulePath: string,
  issues: string[],
): Rule | null {
  if (!isJson(raw, `${rulePath}.equals`, issues)) {
    return null;
  }
  return { path, equals: raw as JsonValue };
}

function parseOneOf(
  path: string,
  raw: unknown,
  rulePath: string,
  issues: string[],
): Rule | null {
  if (!Array.isArray(raw) || raw.length === 0) {
    issues.push(`${rulePath}.oneOf: expected a non-empty array of JSON values`);
    return null;
  }
  for (const [index, entry] of raw.entries()) {
    if (!isJson(entry, `${rulePath}.oneOf[${String(index)}]`, issues)) {
      return null;
    }
  }
  return { path, oneOf: raw as JsonValue[] };
}

function isJson(value: unknown, path: string, issues: string[]): boolean {
  try {
    assertJsonValue(value, path);
    return true;
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
    return false;
  }
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
