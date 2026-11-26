import type {
  CompositionDefinition,
  JoinState,
  JoinStateSnapshot,
  NodeId,
  NodeState,
  NodeStateSnapshot,
  PersistedJoinState,
  Pheromone,
  PheromoneFieldSnapshot,
} from './types.js';

export function createNodeState(): NodeState {
  // A resting bee has no receptor; the first enqueue creates one.
  return {};
}

export function clonePheromone(pheromone: Pheromone): Pheromone {
  return structuredClone(pheromone);
}

/** The receptor of a bee; a resting bee has none, which reads as empty here. */
export function receptorOf(state: NodeState): readonly Pheromone[] {
  return state.receptor ?? [];
}

/** Restores a receptor only when it holds input; an empty one is omitted. */
export function setReceptor(state: NodeState, receptor: readonly Pheromone[]): void {
  if (receptor.length === 0) {
    return;
  }
  state.receptor = [...receptor];
}

/** Removes the receptor of a bee with no active or pending activation left. */
export function restReceptorIfIdle(state: NodeState): void {
  if (state.active !== undefined || state.pending !== undefined) {
    return;
  }
  if ((state.receptor?.length ?? 0) > 0) {
    return;
  }
  delete state.receptor;
}

/** Drops one fork's queued siblings, keeping the receptor only for survivors. */
export function dropForkFromReceptor(state: NodeState, forkId: string): void {
  const receptor = state.receptor;
  if (receptor === undefined || !receptor.some((pheromone) => pheromone.forkId === forkId)) {
    return;
  }
  const kept = receptor.filter((pheromone) => pheromone.forkId !== forkId);
  if (kept.length === 0) {
    delete state.receptor;
  } else {
    state.receptor = kept;
  }
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

export function isFieldResting(nodes: Iterable<NodeState>): boolean {
  for (const node of nodes) {
    if (
      node.active !== undefined ||
      node.pending !== undefined ||
      node.hover !== undefined ||
      receptorOf(node).length > 0 ||
      hasIncompleteJoin(node)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * A closed join is a tombstone for late branches. Stage 5A closed joins with
 * `completedAt`; Stage 5B closes a timed-out join with `timedOutAt`. Neither is
 * live work, so neither keeps the field out of Rest nor blocks an edit.
 */
export function isJoinClosed(join: {
  readonly completedAt?: string;
  readonly timedOutAt?: string;
}): boolean {
  return join.completedAt !== undefined || join.timedOutAt !== undefined;
}

/**
 * A closed join is a tombstone for late branches, not live work: it never keeps
 * the field out of Rest.
 */
function hasIncompleteJoin(node: NodeState): boolean {
  if (node.joins === undefined) {
    return false;
  }
  for (const join of node.joins.values()) {
    if (!isJoinClosed(join)) {
      return true;
    }
  }
  return false;
}

export function collectPheromones(nodes: Iterable<NodeState>): Pheromone[] {
  const pheromones: Pheromone[] = [];
  for (const node of nodes) {
    if (node.active !== undefined) {
      pheromones.push(clonePheromone(node.active));
    }
    if (node.hoverPheromone !== undefined) {
      pheromones.push(clonePheromone(node.hoverPheromone));
    }
    if (node.pending !== undefined) {
      pheromones.push(clonePheromone(node.pending));
    }
    for (const queued of receptorOf(node)) {
      pheromones.push(clonePheromone(queued));
    }
    if (node.joins !== undefined) {
      for (const join of node.joins.values()) {
        for (const arrived of join.arrived.values()) {
          pheromones.push(clonePheromone(arrived));
        }
      }
    }
  }
  return pheromones;
}

/** JSON shape of the open/closed joins a Merge keeps across a pause. */
export function joinsToPersisted(
  joins: ReadonlyMap<string, JoinState>,
): Record<string, PersistedJoinState> {
  return Object.fromEntries(
    [...joins].map(([forkId, join]) => [
      forkId,
      {
        arrived: [...join.arrived.values()].map(clonePheromone),
        ...(join.lineage === undefined
          ? {}
          : { lineage: join.lineage.map((tag) => ({ ...tag })) }),
        ...(join.completedAt === undefined ? {} : { completedAt: join.completedAt }),
        ...(join.deadlineAt === undefined ? {} : { deadlineAt: join.deadlineAt }),
        ...(join.timedOutAt === undefined ? {} : { timedOutAt: join.timedOutAt }),
      },
    ]),
  );
}

export function snapshotField(
  definition: CompositionDefinition,
  nodes: ReadonlyMap<NodeId, NodeState>,
  rest: boolean,
): PheromoneFieldSnapshot {
  const nodeSnapshots: Record<NodeId, NodeStateSnapshot> = {};

  for (const [id, state] of nodes) {
    const snapshot: NodeStateSnapshot = {
      receptor: receptorOf(state).map(clonePheromone),
      state: state.state === undefined ? {} : cloneValue(state.state),
    };
    if (state.pending !== undefined) {
      snapshot.pending = clonePheromone(state.pending);
    }
    if (state.active !== undefined) {
      snapshot.active = clonePheromone(state.active);
    }
    if (state.hover !== undefined) {
      snapshot.hover = cloneValue(state.hover);
    }
    if (state.joins !== undefined && state.joins.size > 0) {
      const entries: [string, JoinStateSnapshot][] = [];
      for (const [forkId, join] of state.joins) {
        entries.push([
          forkId,
          {
            forkId,
            arrived: [...join.arrived.values()].map(clonePheromone),
            ...(join.lineage === undefined
              ? {}
              : { lineage: join.lineage.map((tag) => ({ ...tag })) }),
            ...(join.completedAt === undefined ? {} : { completedAt: join.completedAt }),
            ...(join.deadlineAt === undefined ? {} : { deadlineAt: join.deadlineAt }),
            ...(join.timedOutAt === undefined ? {} : { timedOutAt: join.timedOutAt }),
          },
        ]);
      }
      snapshot.joins = Object.fromEntries(entries);
    }
    if (state.lastActivatedAt !== undefined) {
      snapshot.lastActivatedAt = state.lastActivatedAt;
    }
    if (state.lastOutput !== undefined) {
      snapshot.lastOutput = cloneValue(state.lastOutput);
    }
    nodeSnapshots[id] = snapshot;
  }

  const field: PheromoneFieldSnapshot = {
    schemaVersion: 1,
    compositionId: definition.id,
    graphRevision: definition.graphRevision,
    rest,
    pheromones: collectPheromones(nodes.values()),
    nodes: nodeSnapshots,
  };

  return deepFreeze(field);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  for (const key of Object.keys(value)) {
    const child = (value as Record<string, unknown>)[key];
    deepFreeze(child);
  }
  return Object.freeze(value);
}
