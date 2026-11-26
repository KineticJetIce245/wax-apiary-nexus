import { BeeIoError, ValueDropOverlapError, ValuePathError } from './errors.js';
import type { FilterConfig, JsonValue, Value } from './types.js';
import {
  cloneJson,
  deletePath,
  getPath,
  isSubtreePath,
  setReadPath,
} from './value-paths.js';

/** True for a plain JSON object (not null, not an array). */
export function isPlainValueObject(value: JsonValue | undefined): value is Value {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Deep merge used by Bee write-back: objects merge recursively, arrays and
 * scalars replace, and `null` replaces. The base object is mutated in place so
 * the Pheromone keeps the same value reference along a normal beeline.
 */
export function mergeInto(target: Value, patch: Value): Value {
  for (const [key, patchValue] of Object.entries(patch)) {
    if (key === '__proto__') {
      throw new ValuePathError("cannot merge the forbidden key '__proto__'");
    }
    const baseValue = target[key];
    if (isPlainValueObject(patchValue) && isPlainValueObject(baseValue)) {
      mergeInto(baseValue, patchValue);
    } else {
      target[key] = cloneJson(patchValue);
    }
  }
  return target;
}

/** Non-mutating form of {@link mergeInto}; useful for pure tests and callers. */
export function deepMerge(base: Value, patch: Value): Value {
  return mergeInto(cloneJson(base), patch);
}

/**
 * Applies `allow` then `deny` to a raw reply. `allow` keeps only paths equal to
 * or under an entry; `deny` then removes paths equal to or under an entry.
 * Arrays are whole values (only their own path is matched). Returns a filtered
 * copy and the removed paths; bodies are never logged.
 */
export function applyFilter(
  reply: Value,
  filter: FilterConfig | undefined,
): { readonly value: Value; readonly removed: string[] } {
  const filtered = cloneJson(reply);
  if (filter === undefined) {
    return { value: filtered, removed: [] };
  }
  const removed: string[] = [];
  filterObject(filtered, '', filter, removed);
  return { value: filtered, removed };
}

function filterObject(
  node: Value,
  path: string,
  filter: FilterConfig,
  removed: string[],
): void {
  for (const key of Object.keys(node)) {
    const childPath = path === '' ? key : `${path}.${key}`;
    if (isDenied(childPath, filter.deny)) {
      removeField(node, key, childPath, removed);
      continue;
    }
    if (filter.allow.length === 0) {
      const child = node[key];
      if (isPlainValueObject(child)) {
        filterObject(child, childPath, filter, removed);
      }
      continue;
    }
    const kept = filterChild(node, key, childPath, filter, removed);
    if (!kept) {
      removeField(node, key, childPath, removed);
    }
  }
}

/**
 * Keeps a child whose path is equal to or under an allow entry. A plain object
 * that is only an ancestor of an allow entry is descended into; if nothing
 * survives inside it, the empty container is removed as well.
 */
function filterChild(
  node: Value,
  key: string,
  childPath: string,
  filter: FilterConfig,
  removed: string[],
): boolean {
  const underAllow = filter.allow.some((entry) => isSubtreePath(childPath, entry));
  const aboveAllow = filter.allow.some((entry) => isSubtreePath(entry, childPath));
  if (!underAllow && !aboveAllow) {
    return false;
  }
  const child = node[key];
  if (!isPlainValueObject(child)) {
    // An ancestor that cannot be descended into contains no allowed field.
    return underAllow;
  }
  filterObject(child, childPath, filter, removed);
  return underAllow || Object.keys(child).length > 0;
}

function removeField(
  node: Value,
  key: string,
  path: string,
  removed: string[],
): void {
  removed.push(path);
  delete node[key];
}

function isDenied(path: string, deny: readonly string[]): boolean {
  return deny.some((entry) => isSubtreePath(path, entry));
}

/** Every declared write path must be present in the filtered reply. */
export function assertWrites(reply: Value, writes: readonly string[], beeId: string): void {
  const missing = writes.filter((path) => !getPath(reply, path).found);
  if (missing.length > 0) {
    throw new BeeIoError(
      'missing-write',
      `bee '${beeId}' reply is missing declared writes: ${missing.join(', ')}`,
    );
  }
}

/**
 * Resolves a Bee's declared reads. A missing read takes a static fallback when
 * one is configured; otherwise activation fails with a typed error. Fallback
 * keys not in `reads` are also available to prompt placeholders. The returned
 * value is a patched copy only when a fallback was actually applied, so a
 * normal beeline still hands the stored value through by reference.
 */
export function resolveReads(
  value: Value,
  reads: readonly string[],
  fallback: Readonly<Record<string, JsonValue>> | undefined,
  beeId: string,
): Value {
  const fallbackEntries = Object.entries(fallback ?? {});
  const missingFallback = fallbackEntries.filter(([path]) => !getPath(value, path).found);
  let input = value;
  if (missingFallback.length > 0) {
    input = cloneJson(value);
    for (const [path, fallbackValue] of missingFallback) {
      setReadPath(input, path, fallbackValue);
    }
  }
  const missingReads = reads.filter((path) => !getPath(input, path).found);
  if (missingReads.length > 0) {
    throw new BeeIoError(
      'missing-read',
      `bee '${beeId}' value is missing declared reads: ${missingReads.join(', ')}`,
    );
  }
  return input;
}

/**
 * Applies a result's independent `drop` list after the merge. A missing path is
 * a logged no-op (the caller supplies the log hook), never an error. An array
 * index in a drop path is a configuration error and throws.
 */
export function applyDrop(
  value: Value,
  drop: readonly string[],
  onMissing?: (path: string) => void,
): { readonly dropped: string[]; readonly missing: string[] } {
  const dropped: string[] = [];
  const missing: string[] = [];
  for (const path of drop) {
    if (deletePath(value, path)) {
      dropped.push(path);
    } else {
      missing.push(path);
      onMissing?.(path);
    }
  }
  return { dropped, missing };
}

/** A result may not carry a value at the same path it also asks to drop. */
export function assertNoDropOverlap(reply: Value, drop: readonly string[]): void {
  for (const path of drop) {
    if (getPath(reply, path).found) {
      throw new ValueDropOverlapError(path);
    }
  }
}

/**
 * Ordinary write-back: check the value/drop overlap, deep-merge the reply into
 * a new value, then apply the independent drop list. The returned value is the
 * one placed on the moved Pheromone; the reply object is never adopted by
 * reference.
 */
export function applyWriteBack(
  target: Value,
  reply: Value,
  drop?: readonly string[],
  onMissing?: (path: string) => void,
): {
  readonly value: Value;
  readonly dropped: string[];
  readonly missing: string[];
} {
  if (drop !== undefined) {
    assertNoDropOverlap(reply, drop);
  }
  const value = deepMerge(target, reply);
  if (drop === undefined) {
    return { value, dropped: [], missing: [] };
  }
  return { value, ...applyDrop(value, drop, onMissing) };
}
