import { createContext, Script } from 'node:vm';

import { RuleExecutionError } from './errors.js';
import type { JsonValue, Value } from './types.js';
import { cloneJson, getPath } from './value-paths.js';

/**
 * Wall-clock budget for one code block. It bounds synchronous execution only;
 * a block that schedules asynchronous work is outside this contract.
 */
export const CODE_RULE_TIMEOUT_MS = 100;

const FILENAME = 'wax-code-rule';
const FUNCTION_PREFIX = '(function (value, helpers) {\n';
const FUNCTION_SUFFIX = '\n})';

/**
 * Configuration is trusted local code. `node:vm` here is best-effort isolation,
 * not a security boundary: a hostile script can starve the event loop or reach
 * host objects through the values it is given (ARCHITECTURE.md §4.12).
 */

/** Compile-only check used at definition parse time; the body never runs. */
export function assertCodeSyntax(code: string, path: string, issues: string[]): void {
  if (typeof code !== 'string' || code.trim() === '') {
    issues.push(`${path}: expected a non-empty code string`);
    return;
  }
  try {
    new Script(`${FUNCTION_PREFIX}${code}${FUNCTION_SUFFIX}`, { filename: FILENAME });
  } catch (error) {
    issues.push(`${path}: code has a syntax error (${errorMessage(error)})`);
  }
}

/**
 * Runs one code block in a fresh `node:vm` context with only `value` (a clone)
 * and a frozen `helpers.getPath`. `process`, `require` and `console` are not
 * injected. A throw, timeout or `undefined` result becomes a typed error.
 */
export function runCodeRule(code: string, value: Value, label: string): JsonValue {
  const helpers = Object.freeze({
    getPath(root: JsonValue, path: string): JsonValue | undefined {
      const found = getPath(root, path);
      return found.found ? (found.value as JsonValue) : undefined;
    },
  });
  // `value` and `helpers` are real function parameters; the two underscored
  // context globals only carry them into the IIFE. Node adds a `console` to a
  // fresh context, so the three host globals are explicitly shadowed out.
  const context = createContext({
    __waxValue: cloneJson(value),
    __waxHelpers: helpers,
    process: undefined,
    require: undefined,
    console: undefined,
  });
  const source = `${FUNCTION_PREFIX}${code}${FUNCTION_SUFFIX}(__waxValue, __waxHelpers)`;
  let result: unknown;
  try {
    const script = new Script(source, { filename: FILENAME });
    result = script.runInContext(context, { timeout: CODE_RULE_TIMEOUT_MS });
  } catch (error) {
    throw new RuleExecutionError(`${label} code block failed: ${errorMessage(error)}`, {
      cause: error,
    });
  }
  if (result === undefined) {
    throw new RuleExecutionError(`${label} code block returned undefined`);
  }
  return result as JsonValue;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}
