import { assertJsonValue } from '../runtime/json-value.js';
import type { FilterConfig, JsonValue } from '../runtime/index.js';
import { parsePath } from '../runtime/value-paths.js';
import type { Bee } from './types.js';

/**
 * Structural validation of the Bee-level `reads`/`writes`/`fallback`/`filter`
 * fields. Dot-path semantics are checked here so `toCompositionDefinition`
 * cannot fail later on a field shape the B document already accepted.
 */
export function parseBeeIo(
  input: Record<string, unknown>,
  path: string,
  issues: string[],
): Pick<Bee, 'reads' | 'writes' | 'fallback' | 'filter'> | null {
  const reads = optionalPathList(input['reads'], `${path}.reads`, 'read', issues);
  const writes = optionalPathList(input['writes'], `${path}.writes`, 'write', issues);
  const fallback = optionalFallback(input['fallback'], `${path}.fallback`, issues);
  const filter = optionalFilter(input['filter'], `${path}.filter`, issues);
  if (reads === null || writes === null || fallback === null || filter === null) {
    return null;
  }
  return {
    ...(reads === undefined ? {} : { reads }),
    ...(writes === undefined ? {} : { writes }),
    ...(fallback === undefined ? {} : { fallback }),
    ...(filter === undefined ? {} : { filter }),
  };
}

function optionalPathList(
  input: unknown,
  path: string,
  mode: 'read' | 'write',
  issues: string[],
): readonly string[] | undefined | null {
  if (input === undefined) {
    return undefined;
  }
  if (!Array.isArray(input)) {
    issues.push(`${path}: expected an array of dot paths`);
    return null;
  }
  const paths: string[] = [];
  for (const [index, entry] of input.entries()) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      issues.push(`${path}[${String(index)}]: expected a dot path`);
      return null;
    }
    try {
      parsePath(entry, mode);
    } catch (error) {
      issues.push(
        `${path}[${String(index)}]: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
    if (paths.includes(entry)) {
      issues.push(`${path}[${String(index)}]: duplicate path '${entry}'`);
      return null;
    }
    paths.push(entry);
  }
  return paths;
}

function optionalFallback(
  input: unknown,
  path: string,
  issues: string[],
): Readonly<Record<string, JsonValue>> | undefined | null {
  if (input === undefined) {
    return undefined;
  }
  if (!isRecord(input)) {
    issues.push(`${path}: expected an object mapping dot paths to static values`);
    return null;
  }
  const fallback: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(input)) {
    try {
      parsePath(key, 'read');
      assertJsonValue(entry, `${path}.${key}`);
    } catch (error) {
      issues.push(`${path}.${key}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
    fallback[key] = entry as JsonValue;
  }
  return fallback;
}

function optionalFilter(
  input: unknown,
  path: string,
  issues: string[],
): FilterConfig | undefined | null {
  if (input === undefined) {
    return undefined;
  }
  if (!isRecord(input)) {
    issues.push(`${path}: expected an object with allow/deny dot paths`);
    return null;
  }
  assertExactFields(input, ['allow', 'deny'], path, issues);
  const allow = optionalPathList(input['allow'], `${path}.allow`, 'write', issues);
  const deny = optionalPathList(input['deny'], `${path}.deny`, 'write', issues);
  if (allow === null || deny === null) {
    return null;
  }
  return { allow: allow ?? [], deny: deny ?? [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertExactFields(
  input: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  issues: string[],
): void {
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) {
      issues.push(`${path}: unknown field '${key}'`);
    }
  }
}
