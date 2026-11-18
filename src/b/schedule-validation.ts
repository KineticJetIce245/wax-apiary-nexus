import type { Bee, Schedule } from './types.js';

const ISO_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** Validate the optional B `schedules` array; missing means no scheduler. */
export function parseSchedules(
  input: unknown,
  bees: Readonly<Record<string, Bee>>,
  path: string,
  issues: string[],
): Schedule[] | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (!Array.isArray(input)) {
    issues.push(`${path}: expected an array`);
    return [];
  }
  const schedules: Schedule[] = [];
  const seen = new Set<string>();
  input.forEach((raw, index) => {
    const parsed = parseScheduleItem(raw, `${path}[${String(index)}]`, bees, seen, issues);
    if (parsed !== undefined) {
      schedules.push(parsed);
    }
  });
  return schedules;
}

function parseScheduleItem(
  raw: unknown,
  path: string,
  bees: Readonly<Record<string, Bee>>,
  seen: Set<string>,
  issues: string[],
): Schedule | undefined {
  if (!isRecord(raw)) {
    issues.push(`${path}: expected an object`);
    return undefined;
  }
  assertExactFields(raw, ['scheduleId', 'targetBee', 'at', 'everyMs'], path, issues);
  const scheduleId = requireString(raw['scheduleId'], `${path}.scheduleId`, issues);
  if (scheduleId !== undefined) {
    if (seen.has(scheduleId)) {
      issues.push(`${path}.scheduleId: duplicate id '${scheduleId}'`);
    } else {
      seen.add(scheduleId);
    }
  }
  const targetBee = requireTarget(raw['targetBee'], `${path}.targetBee`, bees, issues);
  const hasAt = raw['at'] !== undefined;
  const hasEvery = raw['everyMs'] !== undefined;
  if (hasAt === hasEvery) {
    issues.push(`${path}: expected exactly one of at/everyMs`);
    return undefined;
  }
  if (hasAt) {
    const at = requireInstant(raw['at'], `${path}.at`, issues);
    return scheduleId === undefined || targetBee === undefined || at === undefined
      ? undefined
      : { scheduleId, targetBee, at };
  }
  const everyMs = requirePositiveInteger(raw['everyMs'], `${path}.everyMs`, issues);
  return scheduleId === undefined || targetBee === undefined || everyMs === undefined
    ? undefined
    : { scheduleId, targetBee, everyMs };
}

function requireTarget(
  value: unknown,
  path: string,
  bees: Readonly<Record<string, Bee>>,
  issues: string[],
): string | undefined {
  const target = requireString(value, path, issues);
  if (target === undefined) {
    return undefined;
  }
  const bee = bees[target];
  if (bee === undefined) {
    issues.push(`${path}: unknown bee '${target}'`);
    return undefined;
  }
  if (bee.kind !== 'forager' && bee.kind !== 'worker' && bee.kind !== 'user') {
    issues.push(`${path}: bee '${target}' cannot be woken`);
    return undefined;
  }
  return target;
}

function requireInstant(
  value: unknown,
  path: string,
  issues: string[],
): string | undefined {
  const at = requireString(value, path, issues);
  if (at === undefined) {
    return undefined;
  }
  if (!ISO_INSTANT_PATTERN.test(at)) {
    issues.push(`${path}: expected an ISO-8601 instant`);
    return undefined;
  }
  if (!Number.isFinite(Date.parse(at))) {
    issues.push(`${path}: expected a valid ISO-8601 instant`);
    return undefined;
  }
  return at;
}

function requirePositiveInteger(
  value: unknown,
  path: string,
  issues: string[],
): number | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    issues.push(`${path}: expected a positive integer`);
    return undefined;
  }
  return value;
}

function requireString(
  value: unknown,
  path: string,
  issues: string[],
): string | undefined {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 512 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    issues.push(`${path}: expected a non-empty string of at most 512 characters`);
    return undefined;
  }
  return value;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
