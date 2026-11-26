import type { FilterConfig, JsonValue, NodeKind } from './types.js';
import { assertJsonValue } from './json-value.js';
import { isRecord, pushUnknownFields } from './definition-primitives.js';
import { parsePath } from './value-paths.js';

/** Effective Bee I/O after applying the built-in kind defaults. */
export interface BeeIo {
  readonly reads: readonly string[];
  readonly writes: readonly string[];
  readonly fallback?: Readonly<Record<string, JsonValue>>;
  readonly filter?: FilterConfig;
}

/** ARCHITECTURE.md §4.12 built-in table; an instance may override both lists. */
const IO_DEFAULTS: Readonly<
  Record<NodeKind, { readonly reads: readonly string[]; readonly writes: readonly string[] }>
> = {
  forager: { reads: ['message'], writes: ['message'] },
  worker: { reads: [], writes: ['message'] },
  condition: { reads: [], writes: [] },
  counter: { reads: [], writes: [] },
  user: { reads: [], writes: [] },
  spread: { reads: [], writes: [] },
  gather: { reads: [], writes: [] },
};

/** Parses top-level `reads`/`writes`/`fallback`/`filter`, filling kind defaults. */
export function parseBeeIo(
  raw: Record<string, unknown>,
  kind: NodeKind,
  path: string,
  issues: string[],
): BeeIo | null {
  const defaults = IO_DEFAULTS[kind];
  const reads = parseOptionalList(
    raw['reads'],
    `${path}.reads`,
    'read',
    defaults.reads,
    issues,
  );
  const writes = parseOptionalList(
    raw['writes'],
    `${path}.writes`,
    'write',
    defaults.writes,
    issues,
  );
  const fallback = parseOptionalFallback(raw['fallback'], `${path}.fallback`, issues);
  const filter = parseOptionalFilter(raw['filter'], `${path}.filter`, issues);
  if (reads === null || writes === null || fallback === null || filter === null) {
    return null;
  }
  const io: {
    reads: readonly string[];
    writes: readonly string[];
    fallback?: Readonly<Record<string, JsonValue>>;
    filter?: FilterConfig;
  } = { reads, writes };
  if (fallback !== undefined) {
    io.fallback = fallback;
  }
  if (filter !== undefined) {
    io.filter = filter;
  }
  return io;
}

function parseOptionalList(
  value: unknown,
  path: string,
  mode: 'read' | 'write',
  fallback: readonly string[],
  issues: string[],
): string[] | null {
  if (value === undefined) {
    return [...fallback];
  }
  return parsePathList(value, path, mode, issues);
}

function parseOptionalFallback(
  value: unknown,
  path: string,
  issues: string[],
): Readonly<Record<string, JsonValue>> | undefined | null {
  return value === undefined ? undefined : parseFallback(value, path, issues);
}

function parseOptionalFilter(
  value: unknown,
  path: string,
  issues: string[],
): FilterConfig | undefined | null {
  return value === undefined ? undefined : parseFilter(value, path, issues);
}

/** Prompt placeholders may be declared by a read path or by a fallback key. */
export function placeholderSources(io: BeeIo): readonly string[] {
  return [...io.reads, ...Object.keys(io.fallback ?? {})];
}

function parsePathList(
  value: unknown,
  path: string,
  mode: 'read' | 'write',
  issues: string[],
): string[] | null {
  if (!Array.isArray(value)) {
    issues.push(`${path}: expected an array of dot paths`);
    return null;
  }
  const paths: string[] = [];
  for (const [index, entry] of value.entries()) {
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

function parseFallback(
  value: unknown,
  path: string,
  issues: string[],
): Readonly<Record<string, JsonValue>> | null {
  if (!isRecord(value)) {
    issues.push(`${path}: expected an object mapping dot paths to static values`);
    return null;
  }
  const fallback: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    try {
      // A fallback may supply an indexed read path, so index segments are legal.
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

function parseFilter(
  value: unknown,
  path: string,
  issues: string[],
): FilterConfig | null {
  if (!isRecord(value)) {
    issues.push(`${path}: expected an object with allow/deny dot paths`);
    return null;
  }
  pushUnknownFields(value, ['allow', 'deny'], path, issues);
  const allow = value['allow'] === undefined
    ? []
    : parsePathList(value['allow'], `${path}.allow`, 'write', issues);
  const deny = value['deny'] === undefined
    ? []
    : parsePathList(value['deny'], `${path}.deny`, 'write', issues);
  if (allow === null || deny === null) {
    return null;
  }
  return { allow, deny };
}
