import type { Bee, Beeline } from './types.js';

/**
 * Semantic graph checks for a B document: outgoing/beeline agreement, the
 * condition true/false pair, the spread target list and per-kind edge limits.
 * Spread/gather config *shape* is validated separately in `validation.ts`.
 */
export function validateGraphFlow(
  bees: Readonly<Record<string, Bee>>,
  beelines: Readonly<Record<string, Beeline>>,
  path: string,
  issues: string[],
): void {
  for (const [beeId, bee] of Object.entries(bees)) {
    validateOutgoing(beeId, bee, beelines, path, issues);
    validateBeeFlow(beeId, bee, beelines, path, issues);
    if (bee.kind === 'spread') {
      validateSpreadTargets(beeId, bee, bees, path, issues);
    }
  }
  for (const [beelineId, line] of Object.entries(beelines)) {
    validateEndpoints(beelineId, line, bees, path, issues);
    validateBeelineOutcome(beelineId, line, bees[line.fromBee], path, issues);
  }
}

/** `outgoing` and the beeline map are two views of the same edge set. */
function validateOutgoing(
  beeId: string,
  bee: Bee,
  beelines: Readonly<Record<string, Beeline>>,
  path: string,
  issues: string[],
): void {
  for (const beelineId of bee.outgoing) {
    const line = beelines[beelineId];
    if (line === undefined) {
      issues.push(`${path}.bees.${beeId}.outgoing: unknown beeline '${beelineId}'`);
    } else if (line.fromBee !== beeId) {
      issues.push(`${path}.bees.${beeId}.outgoing: beeline '${beelineId}' starts elsewhere`);
    }
  }
  for (const [beelineId, line] of Object.entries(beelines)) {
    if (line.fromBee === beeId && !bee.outgoing.includes(beelineId)) {
      issues.push(`${path}.bees.${beeId}.outgoing: missing beeline '${beelineId}'`);
    }
  }
}

function validateEndpoints(
  beelineId: string,
  line: Beeline,
  bees: Readonly<Record<string, Bee>>,
  path: string,
  issues: string[],
): void {
  if (!Object.hasOwn(bees, line.fromBee)) {
    issues.push(`${path}.beelines.${beelineId}.fromBee: unknown bee '${line.fromBee}'`);
  }
  if (!Object.hasOwn(bees, line.toBee)) {
    issues.push(`${path}.beelines.${beelineId}.toBee: unknown bee '${line.toBee}'`);
  }
}

/** A spread has no beelines; a condition has exactly true/false; others at most one. */
function validateBeeFlow(
  beeId: string,
  bee: Bee,
  beelines: Readonly<Record<string, Beeline>>,
  path: string,
  issues: string[],
): void {
  const outgoing = bee.outgoing.flatMap((beelineId) => {
    const line = beelines[beelineId];
    return line === undefined ? [] : [{ beelineId, line }];
  });
  if (bee.kind === 'spread') {
    if (outgoing.length > 0) {
      issues.push(
        `${path}.bees.${beeId}: a spread uses config.targets and has no outgoing beeline`,
      );
    }
    return;
  }
  if (bee.kind === 'condition') {
    for (const label of ['true', 'false'] as const) {
      const count = outgoing.filter(({ line }) => line.when === label).length;
      if (count !== 1) {
        issues.push(
          `${path}.bees.${beeId}: expected exactly one '${label}' outgoing beeline, found ${String(count)}`,
        );
      }
    }
    if (outgoing.length !== 2) {
      issues.push(
        `${path}.bees.${beeId}: a condition bee has exactly two outgoing beelines`,
      );
    }
    return;
  }
  if (outgoing.length > 1) {
    issues.push(
      `${path}.bees.${beeId}: a ${bee.kind} bee has at most one outgoing beeline`,
    );
  }
}

/** Only a condition may carry an outcome, and only `true` or `false`. */
function validateBeelineOutcome(
  beelineId: string,
  line: Beeline,
  source: Bee | undefined,
  path: string,
  issues: string[],
): void {
  if (source === undefined) {
    return;
  }
  if (source.kind === 'spread') {
    issues.push(
      `${path}.beelines.${beelineId}: a spread target lives in config.targets, not a beeline`,
    );
    return;
  }
  if (source.kind === 'condition') {
    if (line.when !== 'true' && line.when !== 'false') {
      issues.push(
        `${path}.beelines.${beelineId}.when: expected 'true' or 'false' for a condition beeline`,
      );
    }
    return;
  }
  if (line.when !== undefined) {
    issues.push(
      `${path}.beelines.${beelineId}.when: only a condition beeline may carry an outcome`,
    );
  }
}

/** Spread targets are BeeIds and must exist; the config shape is already parsed. */
function validateSpreadTargets(
  beeId: string,
  bee: Bee,
  bees: Readonly<Record<string, Bee>>,
  path: string,
  issues: string[],
): void {
  const targets = bee.config['targets'];
  const targetIds = Array.isArray(targets)
    ? targets
    : isRecord(targets)
      ? Object.keys(targets)
      : [];
  for (const target of targetIds) {
    if (typeof target === 'string' && !Object.hasOwn(bees, target)) {
      issues.push(
        `${path}.bees.${beeId}.config.targets: unknown bee '${target}'`,
      );
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
