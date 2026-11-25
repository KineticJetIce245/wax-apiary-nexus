import { FieldRestoreError } from './errors.js';
import {
  copyLineage,
  currentLineage,
  normalizePheromone,
  sameLineage,
} from './runtime-values.js';
import type {
  BranchTag,
  JoinState,
  MergeNode,
  PersistedJoinState,
  Pheromone,
} from './types.js';

function restoreJoinLineage(input: unknown, path: string): BranchTag[] | undefined {
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
    const forkId = (entry as { forkId?: unknown }).forkId;
    const branchId = (entry as { branchId?: unknown }).branchId;
    if (typeof forkId !== 'string' || forkId === '') {
      throw new FieldRestoreError(
        `${path} lineage[${String(index)}].forkId: expected a non-empty string`,
      );
    }
    if (typeof branchId !== 'string' || branchId === '') {
      throw new FieldRestoreError(
        `${path} lineage[${String(index)}].branchId: expected a non-empty string`,
      );
    }
    return { forkId, branchId };
  });
}

/** Rebuilds persisted Merge joins and validates their lineage/tombstone shape. */
export function restoreJoins(
  node: MergeNode,
  saved: Record<string, PersistedJoinState>,
): Map<string, JoinState> {
  const joins = new Map<string, JoinState>();
  for (const [forkId, entry] of Object.entries(saved)) {
    const joinPath = `persisted join '${forkId}' on node '${node.id}'`;
    if (forkId === '') {
      throw new FieldRestoreError(`persisted join on node '${node.id}' has an empty forkId`);
    }
    if (!Array.isArray(entry.arrived)) {
      throw new FieldRestoreError(`${joinPath} has no branch Pheromones`);
    }
    if (entry.completedAt !== undefined && entry.timedOutAt !== undefined) {
      throw new FieldRestoreError(`${joinPath} is both completed and timed out`);
    }
    const parentLineage = restoreJoinLineage(entry.lineage, joinPath);
    const closed = restoreClosedJoin(node, forkId, entry, parentLineage);
    joins.set(forkId, closed ?? restoreArrivedJoin(node, forkId, entry, parentLineage));
  }
  return joins;
}

/** Validates a completed/timed-out tombstone; `undefined` when still open. */
function restoreClosedJoin(
  node: MergeNode,
  forkId: string,
  entry: PersistedJoinState,
  parentLineage: BranchTag[] | undefined,
): JoinState | undefined {
  const closedAt = entry.completedAt ?? entry.timedOutAt;
  if (closedAt === undefined) {
    return undefined;
  }
  const joinPath = `persisted join '${forkId}' on node '${node.id}'`;
  if (typeof closedAt !== 'string' || !Number.isFinite(Date.parse(closedAt))) {
    throw new FieldRestoreError(`${joinPath} has an invalid closed timestamp`);
  }
  if (entry.arrived.length > 0) {
    throw new FieldRestoreError(
      `persisted closed join '${forkId}' on node '${node.id}' still holds branch Pheromones`,
    );
  }
  return {
    forkId,
    ...(parentLineage === undefined ? {} : { lineage: parentLineage }),
    arrived: new Map<string, Pheromone>(),
    ...(entry.completedAt === undefined
      ? { timedOutAt: closedAt }
      : { completedAt: closedAt }),
  };
}

/** Validates an open join's deadline and restores its arrived branches. */
function restoreArrivedJoin(
  node: MergeNode,
  forkId: string,
  entry: PersistedJoinState,
  parentLineage: BranchTag[] | undefined,
): JoinState {
  const joinPath = `persisted join '${forkId}' on node '${node.id}'`;
  if (entry.arrived.length === 0) {
    throw new FieldRestoreError(`${joinPath} has no branch Pheromones`);
  }
  if (entry.deadlineAt === undefined || !Number.isSafeInteger(entry.deadlineAt)) {
    throw new FieldRestoreError(`${joinPath} has no valid deadlineAt`);
  }
  const { arrived, effectiveParent } = restoreArrivedBranches(
    node,
    forkId,
    entry.arrived,
    parentLineage,
  );
  if (parentLineage !== undefined && !sameLineage(parentLineage, effectiveParent)) {
    throw new FieldRestoreError(`${joinPath} lineage does not match its branch Pheromones`);
  }
  return {
    forkId,
    ...(effectiveParent.length === 0 ? {} : { lineage: copyLineage(effectiveParent) }),
    arrived,
    deadlineAt: entry.deadlineAt,
  };
}

/** Restores arrived branch Pheromones and the shared parent lineage. */
function restoreArrivedBranches(
  node: MergeNode,
  forkId: string,
  saved: readonly Pheromone[],
  parentLineage: BranchTag[] | undefined,
): { arrived: Map<string, Pheromone>; effectiveParent: BranchTag[] } {
  const arrived = new Map<string, Pheromone>();
  let derivedParent: BranchTag[] | undefined;
  for (const pheromone of saved) {
    const normalized = normalizePheromone(pheromone);
    const branchId = requireRestoredBranch(node, forkId, normalized, arrived);
    const parent = copyLineage(currentLineage(normalized).slice(0, -1));
    if (derivedParent === undefined) {
      derivedParent = parent;
    } else if (!sameLineage(derivedParent, parent)) {
      throw new FieldRestoreError(
        `persisted join '${forkId}' on node '${node.id}' mixes parent lineages`,
      );
    }
    arrived.set(branchId, normalized);
  }
  const effectiveParent = derivedParent ?? [];
  if (parentLineage !== undefined && !sameLineage(parentLineage, effectiveParent)) {
    throw new FieldRestoreError(
      `persisted join '${forkId}' on node '${node.id}' lineage mismatch`,
    );
  }
  return { arrived, effectiveParent };
}

/** Validates one persisted branch tag and returns it when it is not repeated. */
function requireRestoredBranch(
  node: MergeNode,
  forkId: string,
  pheromone: Pheromone,
  arrived: Map<string, Pheromone>,
): string {
  if (pheromone.forkId !== forkId) {
    throw new FieldRestoreError(
      `persisted join '${forkId}' on node '${node.id}' holds a Pheromone for '${String(pheromone.forkId)}'`,
    );
  }
  const branchId = pheromone.branchId;
  if (branchId === undefined) {
    throw new FieldRestoreError(
      `persisted join '${forkId}' on node '${node.id}' holds an untagged Pheromone`,
    );
  }
  if (
    !node.config.required.includes(branchId) &&
    !node.config.optional.includes(branchId)
  ) {
    throw new FieldRestoreError(
      `persisted join '${forkId}' on node '${node.id}' holds unknown branch '${branchId}'`,
    );
  }
  if (arrived.has(branchId)) {
    throw new FieldRestoreError(
      `persisted join '${forkId}' on node '${node.id}' repeats branch '${branchId}'`,
    );
  }
  return branchId;
}
