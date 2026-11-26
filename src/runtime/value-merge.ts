import { ValueDropOverlapError, ValuePathError } from './errors.js';
import type { JsonValue, Value } from './types.js';
import {
  cloneJson,
  deletePath,
  getPath,
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
