import type { JsonValue } from './types.js';

/**
 * Asserts that a value is JSON-safe.
 *
 * The `structured` Value may only carry data that survives a
 * `JSON.parse(JSON.stringify(...))` round trip: null, booleans, finite numbers,
 * strings, arrays and plain objects. Undefined, functions, BigInts, symbols,
 * cycles, non-finite numbers and non-plain objects are rejected because
 * `JSON.stringify` would drop, coerce or throw on them.
 */
export function assertJsonValue(
  value: unknown,
  path = 'value',
): asserts value is JsonValue {
  walk(value, path, new Set<object>());
}

function walk(value: unknown, path: string, stack: Set<object>): void {
  if (value === null) {
    return;
  }

  switch (typeof value) {
    case 'boolean':
    case 'string':
      return;
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError(`${path}: non-finite numbers are not JSON-safe`);
      }
      return;
    case 'undefined':
      throw new TypeError(`${path}: undefined is not JSON-safe`);
    case 'object':
      break;
    default:
      throw new TypeError(`${path}: ${typeof value} is not JSON-safe`);
  }

  // Path-based cycle detection: a shared child is fine, an ancestor is not.
  if (stack.has(value)) {
    throw new TypeError(`${path}: a cycle is not JSON-safe`);
  }
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        walk(value[index], `${path}[${String(index)}]`, stack);
      }
      return;
    }

    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${path}: only plain objects are JSON-safe`);
    }
    for (const [key, entry] of Object.entries(value)) {
      walk(entry, `${path}.${key}`, stack);
    }
    for (const symbol of Object.getOwnPropertySymbols(value)) {
      if (Object.prototype.propertyIsEnumerable.call(value, symbol)) {
        throw new TypeError(`${path}: symbol-keyed properties are not JSON-safe`);
      }
    }
  } finally {
    stack.delete(value);
  }
}
