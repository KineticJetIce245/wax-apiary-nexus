import type { EngineContext } from './engine-context.js';
import { SpreadEmitError } from './errors.js';
import { appendEntry, createEntry } from './queue.js';
import { ReceptorFullError } from './receptor-overflow.js';
import { logDropped } from './runtime-log.js';
import { cloneJson, getPath, setReadPath } from './value-paths.js';
import type { JsonValue, Pheromone, SpreadNode, Value } from './types.js';

/** One value destined for one target BeeId. */
interface SpreadPart {
  readonly targetId: string;
  readonly value: Value;
}

/**
 * Spread: one input value becomes N new Pheromones, one per target BeeId.
 *
 * Everything is checked before anything is emitted, so an unknown target, a
 * missing cleave path or a part/target mismatch is one typed error and zero
 * emissions. After emission the spread keeps no tracking, cancellation or
 * rollback state: a full target drops only its own copy (§9.2) and the other
 * targets still receive theirs.
 */
export function runSpread(
  ctx: EngineContext,
  node: SpreadNode,
  pheromone: Pheromone,
): string {
  const parts = buildParts(ctx, node, pheromone);
  let emitted = 0;
  let dropped = 0;
  for (const part of parts) {
    if (emitPart(ctx, node, part)) {
      emitted += 1;
    } else {
      dropped += 1;
    }
  }
  return `emitted=${String(emitted)} dropped=${String(dropped)}`;
}

/** Builds every part and validates the whole fan-out before the first append. */
function buildParts(
  ctx: EngineContext,
  node: SpreadNode,
  pheromone: Pheromone,
): readonly SpreadPart[] {
  const config = node.config;
  const targetIds = Array.isArray(config.targets)
    ? [...config.targets]
    : Object.keys(config.targets);
  assertTargets(ctx, node, targetIds);
  const parts =
    config.strategy === 'clone'
      ? targetIds.map((targetId) => ({ targetId, value: cloneJson(pheromone.value) }))
      : Object.entries(config.targets).map(([targetId, paths]) => ({
          targetId,
          value: projectPart(pheromone.value, paths, node.id, targetId),
        }));
  assertAligned(parts, targetIds, node.id);
  return parts;
}

function assertTargets(
  ctx: EngineContext,
  node: SpreadNode,
  targetIds: readonly string[],
): void {
  if (targetIds.length === 0) {
    throw new SpreadEmitError(`spread '${node.id}' has no target BeeIds`);
  }
  const seen = new Set<string>();
  for (const targetId of targetIds) {
    if (seen.has(targetId)) {
      throw new SpreadEmitError(`spread '${node.id}' repeats target '${targetId}'`);
    }
    seen.add(targetId);
    if (!ctx.definition.nodes.has(targetId)) {
      throw new SpreadEmitError(`spread '${node.id}' targets unknown bee '${targetId}'`);
    }
  }
}

/** A cleave part contains exactly the listed paths, nested by dot path. */
function projectPart(
  value: Value,
  paths: readonly string[],
  beeId: string,
  targetId: string,
): Value {
  const part: Value = {};
  for (const path of paths) {
    const found = getPath(value, path);
    if (!found.found) {
      throw new SpreadEmitError(
        `spread '${beeId}' target '${targetId}' is missing path '${path}'`,
      );
    }
    setReadPath(part, path, found.value as JsonValue);
  }
  return part;
}

/** One part per target, in target order; a mismatch is a typed error. */
function assertAligned(
  parts: readonly SpreadPart[],
  targetIds: readonly string[],
  beeId: string,
): void {
  if (parts.length !== targetIds.length) {
    throw new SpreadEmitError(
      `spread '${beeId}' built ${String(parts.length)} parts for ` +
        `${String(targetIds.length)} targets`,
    );
  }
  const expected = new Set(targetIds);
  const seen = new Set<string>();
  for (const part of parts) {
    if (!expected.has(part.targetId) || seen.has(part.targetId)) {
      throw new SpreadEmitError(
        `spread '${beeId}' parts do not align with its targets at '${part.targetId}'`,
      );
    }
    seen.add(part.targetId);
  }
}

/**
 * Appends one new Pheromone to its target receptor. A full target is dropped
 * and logged; the remaining parts are still emitted (partial fan-out).
 */
function emitPart(ctx: EngineContext, node: SpreadNode, part: SpreadPart): boolean {
  const entry = createEntry(part.value, ctx.iso());
  try {
    appendEntry(ctx.queue, part.targetId, entry, 'pheromone.emitted');
    return true;
  } catch (error) {
    if (!(error instanceof ReceptorFullError)) {
      throw error;
    }
    logDropped(ctx.log, node.id, node.kind, `target-full:${part.targetId}`, {
      enqueuedAt: entry.enqueuedAt,
      queueDepth: error.pending,
      limit: error.limit,
    });
    return false;
  }
}
