import { FieldRestoreError } from './errors.js';
import {
  copyLineage,
  currentLineage,
  normalizePheromone,
  sameLineage,
} from './runtime-values.js';
import type {
  BranchTag,
  GatherState,
  GatherNode,
  PersistedGatherState,
  Pheromone,
} from './types.js';

function restoreGatherLineage(input: unknown, path: string): BranchTag[] | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (!Array.isArray(input) || input.length === 0) {
    throw new FieldRestoreError(`${path} lineage: expected a non-empty array`);
  }
  return input.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new FieldRestoreError(`${path} lineage[${String(index)}]: expected a branch tag`);
    }
    const spreadId = (entry as { spreadId?: unknown }).spreadId;
    const branchId = (entry as { branchId?: unknown }).branchId;
    if (typeof spreadId !== 'string' || spreadId === '') {
      throw new FieldRestoreError(
        `${path} lineage[${String(index)}].spreadId: expected a non-empty string`,
      );
    }
    if (typeof branchId !== 'string' || branchId === '') {
      throw new FieldRestoreError(
        `${path} lineage[${String(index)}].branchId: expected a non-empty string`,
      );
    }
    return { spreadId, branchId };
  });
}

/** Rebuilds persisted Gather gathers and validates their lineage/tombstone shape. */
export function restoreGathers(
  node: GatherNode,
  saved: Record<string, PersistedGatherState>,
): Map<string, GatherState> {
  const gathers = new Map<string, GatherState>();
  for (const [spreadId, entry] of Object.entries(saved)) {
    const gatherPath = `persisted join '${spreadId}' on node '${node.id}'`;
    if (spreadId === '') {
      throw new FieldRestoreError(`persisted join on node '${node.id}' has an empty spreadId`);
    }
    if (!Array.isArray(entry.arrived)) {
      throw new FieldRestoreError(`${gatherPath} has no branch Pheromones`);
    }
    if (entry.completedAt !== undefined && entry.timedOutAt !== undefined) {
      throw new FieldRestoreError(`${gatherPath} is both completed and timed out`);
    }
    const parentLineage = restoreGatherLineage(entry.lineage, gatherPath);
    const closed = restoreClosedGather(node, spreadId, entry, parentLineage);
    gathers.set(spreadId, closed ?? restoreArrivedGather(node, spreadId, entry, parentLineage));
  }
  return gathers;
}

/** Validates a completed/timed-out tombstone; `undefined` when still open. */
function restoreClosedGather(
  node: GatherNode,
  spreadId: string,
  entry: PersistedGatherState,
  parentLineage: BranchTag[] | undefined,
): GatherState | undefined {
  const closedAt = entry.completedAt ?? entry.timedOutAt;
  if (closedAt === undefined) {
    return undefined;
  }
  const gatherPath = `persisted join '${spreadId}' on node '${node.id}'`;
  if (typeof closedAt !== 'string' || !Number.isFinite(Date.parse(closedAt))) {
    throw new FieldRestoreError(`${gatherPath} has an invalid closed timestamp`);
  }
  if (entry.arrived.length > 0) {
    throw new FieldRestoreError(
      `persisted closed join '${spreadId}' on node '${node.id}' still holds branch Pheromones`,
    );
  }
  return {
    spreadId,
    ...(parentLineage === undefined ? {} : { lineage: parentLineage }),
    arrived: new Map<string, Pheromone>(),
    ...(entry.completedAt === undefined
      ? { timedOutAt: closedAt }
      : { completedAt: closedAt }),
  };
}

/** Validates an open join's deadline and restores its arrived branches. */
function restoreArrivedGather(
  node: GatherNode,
  spreadId: string,
  entry: PersistedGatherState,
  parentLineage: BranchTag[] | undefined,
): GatherState {
  const gatherPath = `persisted join '${spreadId}' on node '${node.id}'`;
  if (entry.arrived.length === 0) {
    throw new FieldRestoreError(`${gatherPath} has no branch Pheromones`);
  }
  if (entry.deadlineAt === undefined || !Number.isSafeInteger(entry.deadlineAt)) {
    throw new FieldRestoreError(`${gatherPath} has no valid deadlineAt`);
  }
  const { arrived, effectiveParent } = restoreArrivedBranches(
    node,
    spreadId,
    entry.arrived,
    parentLineage,
  );
  if (parentLineage !== undefined && !sameLineage(parentLineage, effectiveParent)) {
    throw new FieldRestoreError(`${gatherPath} lineage does not match its branch Pheromones`);
  }
  return {
    spreadId,
    ...(effectiveParent.length === 0 ? {} : { lineage: copyLineage(effectiveParent) }),
    arrived,
    deadlineAt: entry.deadlineAt,
  };
}

/** Restores arrived branch Pheromones and the shared parent lineage. */
function restoreArrivedBranches(
  node: GatherNode,
  spreadId: string,
  saved: readonly Pheromone[],
  parentLineage: BranchTag[] | undefined,
): { arrived: Map<string, Pheromone>; effectiveParent: BranchTag[] } {
  const arrived = new Map<string, Pheromone>();
  let derivedParent: BranchTag[] | undefined;
  for (const pheromone of saved) {
    const normalized = normalizePheromone(pheromone);
    const branchId = requireRestoredBranch(node, spreadId, normalized, arrived);
    const parent = copyLineage(currentLineage(normalized).slice(0, -1));
    if (derivedParent === undefined) {
      derivedParent = parent;
    } else if (!sameLineage(derivedParent, parent)) {
      throw new FieldRestoreError(
        `persisted join '${spreadId}' on node '${node.id}' mixes parent lineages`,
      );
    }
    arrived.set(branchId, normalized);
  }
  const effectiveParent = derivedParent ?? [];
  if (parentLineage !== undefined && !sameLineage(parentLineage, effectiveParent)) {
    throw new FieldRestoreError(
      `persisted join '${spreadId}' on node '${node.id}' lineage mismatch`,
    );
  }
  return { arrived, effectiveParent };
}

/** Validates one persisted branch tag and returns it when it is not repeated. */
function requireRestoredBranch(
  node: GatherNode,
  spreadId: string,
  pheromone: Pheromone,
  arrived: Map<string, Pheromone>,
): string {
  if (pheromone.spreadId !== spreadId) {
    throw new FieldRestoreError(
      `persisted join '${spreadId}' on node '${node.id}' holds a Pheromone for '${String(pheromone.spreadId)}'`,
    );
  }
  const branchId = pheromone.branchId;
  if (branchId === undefined) {
    throw new FieldRestoreError(
      `persisted join '${spreadId}' on node '${node.id}' holds an untagged Pheromone`,
    );
  }
  if (
    !node.config.required.includes(branchId) &&
    !node.config.optional.includes(branchId)
  ) {
    throw new FieldRestoreError(
      `persisted join '${spreadId}' on node '${node.id}' holds unknown branch '${branchId}'`,
    );
  }
  if (arrived.has(branchId)) {
    throw new FieldRestoreError(
      `persisted join '${spreadId}' on node '${node.id}' repeats branch '${branchId}'`,
    );
  }
  return branchId;
}
