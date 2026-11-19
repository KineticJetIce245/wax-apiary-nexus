import type { EdgeWhen } from './types.js';

export const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * An `at` schedule must name one instant. A date without `Z` or an offset is
 * rejected instead of being interpreted in the host's local timezone.
 */
export const ISO_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export const WHEN_VALUES: readonly EdgeWhen[] = ['true', 'false', 'continue', 'done'];

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

export function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

export function pushUnknownFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  issues: string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      issues.push(`${path}: unknown field '${key}'`);
    }
  }
}

export function pushUnknownPlaceholders(prompt: string, path: string, issues: string[]): void {
  for (const match of prompt.matchAll(/\{\{([^}]*)\}\}/g)) {
    const name = match[1] ?? '';
    if (name.trim() !== 'input') {
      issues.push(`${path}: unsupported template placeholder '{{${name}}}' (only {{input}})`);
    }
  }

  const leftover = prompt.replace(/\{\{[^}]*\}\}/g, '');
  if (leftover.includes('{{') || leftover.includes('}}')) {
    issues.push(`${path}: unterminated template placeholder`);
  }
}

export function hasParentSegment(value: string): boolean {
  const segments = process.platform === 'win32' ? value.split(/[\\/]+/) : value.split('/');
  return segments.includes('..');
}
