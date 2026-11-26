import { ValuePathError } from './errors.js';
import type { JsonValue, Value } from './types.js';

export type PathMode = 'read' | 'write';

/** Only simple dot paths; no JSONPath, no escaping, no empty segments. */
const SEGMENT = /^[A-Za-z0-9_-]+$/;
const INDEX = /^(?:0|[1-9][0-9]*)$/;
/** Keys that could mutate a prototype when written; never legal in a path. */
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

/** Returns the path segments, throwing a typed error when the path is invalid. */
export function parsePath(path: string, mode: PathMode = 'read'): string[] {
  const segments = path.split('.');
  for (const [index, segment] of segments.entries()) {
    if (!SEGMENT.test(segment)) {
      throw new ValuePathError(
        `invalid dot path '${path}': segment ${String(index)} is empty or has illegal characters`,
      );
    }
    if (FORBIDDEN.has(segment)) {
      throw new ValuePathError(`invalid dot path '${path}': segment '${segment}' is not allowed`);
    }
    if (mode === 'write' && INDEX.test(segment)) {
      throw new ValuePathError(
        `invalid dot path '${path}': array indices are not allowed in writes/drop paths`,
      );
    }
  }
  return segments;
}

/** True when the path is valid for the mode, without throwing. */
export function isValidPath(path: unknown, mode: PathMode = 'read'): path is string {
  if (typeof path !== 'string' || path === '') {
    return false;
  }
  try {
    parsePath(path, mode);
    return true;
  } catch {
    return false;
  }
}

/** True when `path` equals `prefix` or lives under it. */
export function isSubtreePath(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}.`);
}

export interface PathLookup {
  readonly found: boolean;
  readonly value?: JsonValue;
}

/** Resolves a read path; a numeric segment indexes an array. */
export function getPath(root: JsonValue, path: string): PathLookup {
  const segments = parsePath(path, 'read');
  let current: JsonValue = root;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      if (!INDEX.test(segment)) {
        return { found: false };
      }
      const index = Number(segment);
      if (index >= current.length) {
        return { found: false };
      }
      current = current[index] as JsonValue;
      continue;
    }
    if (typeof current !== 'object' || current === null) {
      return { found: false };
    }
    if (!Object.hasOwn(current, segment)) {
      return { found: false };
    }
    current = current[segment] as JsonValue;
  }
  return { found: true, value: current };
}

/**
 * Writes a leaf into a plain-object tree, creating missing objects. An existing
 * non-object intermediate value is replaced by a new object. The caller owns
 * the root and has already checked that it is a JSON object.
 */
export function setPath(root: Value, path: string, value: JsonValue): void {
  const segments = parsePath(path, 'write');
  const leaf = segments.pop();
  if (leaf === undefined) {
    throw new ValuePathError(`invalid dot path '${path}'`);
  }
  let current: Value = root;
  for (const segment of segments) {
    const next = current[segment];
    if (typeof next !== 'object' || next === null || Array.isArray(next)) {
      const created: Value = {};
      current[segment] = created;
      current = created;
      continue;
    }
    current = next;
  }
  current[leaf] = cloneJson(value);
}

/** Deletes a write-mode leaf; returns false when the path is absent. */
export function deletePath(root: Value, path: string): boolean {
  const segments = parsePath(path, 'write');
  const leaf = segments.pop();
  if (leaf === undefined) {
    return false;
  }
  let current: Value = root;
  for (const segment of segments) {
    const next = current[segment];
    if (typeof next !== 'object' || next === null || Array.isArray(next)) {
      return false;
    }
    current = next;
  }
  if (!Object.hasOwn(current, leaf)) {
    return false;
  }
  delete current[leaf];
  return true;
}

/**
 * Writes a read-mode path, creating arrays for numeric segments. Used to patch
 * a static fallback into the activation input; the stored value is untouched.
 */
export function setReadPath(root: Value, path: string, value: JsonValue): void {
  const segments = parsePath(path, 'read');
  const leaf = segments[segments.length - 1] as string;
  const parent = resolveReadParent(root, segments, path);
  if (Array.isArray(parent)) {
    assignArrayLeaf(parent, leaf, value, path);
    return;
  }
  parent[leaf] = cloneJson(value);
}

function resolveReadParent(
  root: Value,
  segments: readonly string[],
  path: string,
): Value | JsonValue[] {
  let current: Value | JsonValue[] = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    current = stepRead(
      current,
      segments[index] as string,
      segments[index + 1] as string,
      path,
    );
  }
  return current;
}

function stepRead(
  current: Value | JsonValue[],
  segment: string,
  nextSegment: string,
  path: string,
): Value | JsonValue[] {
  if (Array.isArray(current)) {
    if (!INDEX.test(segment)) {
      throw new ValuePathError(`invalid dot path '${path}': '${segment}' is not an array index`);
    }
    const index = Number(segment);
    fillArrayHoles(current, index);
    const existing = current[index];
    if (typeof existing === 'object' && existing !== null) {
      return existing as Value | JsonValue[];
    }
    const created: Value | JsonValue[] = INDEX.test(nextSegment) ? [] : {};
    current[index] = created;
    return created;
  }
  const existing = current[segment];
  if (typeof existing === 'object' && existing !== null) {
    return existing as Value | JsonValue[];
  }
  const created: Value | JsonValue[] = INDEX.test(nextSegment) ? [] : {};
  current[segment] = created;
  return created;
}

function assignArrayLeaf(
  array: JsonValue[],
  segment: string,
  value: JsonValue,
  path: string,
): void {
  if (!INDEX.test(segment)) {
    throw new ValuePathError(`invalid dot path '${path}': '${segment}' is not an array index`);
  }
  const index = Number(segment);
  fillArrayHoles(array, index);
  array[index] = cloneJson(value);
}

function fillArrayHoles(array: JsonValue[], index: number): void {
  for (let fill = array.length; fill < index; fill += 1) {
    array[fill] = null;
  }
}

/** Deep clone of JSON data; no functions/undefined can appear in a Value. */
export function cloneJson<T extends JsonValue>(value: T): T {
  return structuredClone(value);
}

/** Deep JSON equality; object key order does not matter. */
export function jsonEquals(left: JsonValue, right: JsonValue): boolean {
  if (left === right) {
    return true;
  }
  if (left === null || right === null || typeof left !== typeof right) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return jsonArraysEqual(left, right);
  }
  if (typeof left !== 'object' || typeof right !== 'object') {
    return false;
  }
  return jsonObjectsEqual(left, right);
}

function jsonArraysEqual(left: JsonValue, right: JsonValue): boolean {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
    return false;
  }
  return left.every((entry, index) => jsonEquals(entry, right[index] as JsonValue));
}

function jsonObjectsEqual(
  left: { [key: string]: JsonValue },
  right: { [key: string]: JsonValue },
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  return leftKeys.every(
    (key) =>
      Object.hasOwn(right, key) &&
      jsonEquals(left[key] as JsonValue, right[key] as JsonValue),
  );
}

/** The JSON type name used by a declarative `type` rule. */
export function jsonTypeOf(
  value: JsonValue,
): 'string' | 'number' | 'boolean' | 'object' | 'array' | 'null' {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  if (typeof value === 'object') {
    return 'object';
  }
  return typeof value as 'string' | 'number' | 'boolean';
}
