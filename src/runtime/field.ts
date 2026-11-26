import type {
  CompositionDefinition,
  NodeId,
  NodeState,
  NodeStateSnapshot,
  Pheromone,
  PheromoneFieldSnapshot,
  QueueEntry,
} from './types.js';
import { cloneJson } from './value-paths.js';

export function createNodeState(): NodeState {
  // A resting bee has no receptor; the first enqueue creates one.
  return {};
}
export function clonePheromone(pheromone: Pheromone): Pheromone {
  return { value: cloneJson(pheromone.value) };
}

export function cloneEntry(entry: QueueEntry): QueueEntry {
  return { value: cloneJson(entry.value), enqueuedAt: entry.enqueuedAt };
}

/** The receptor of a bee; a resting bee has none, which reads as empty here. */
export function receptorOf(state: NodeState): readonly QueueEntry[] {
  return state.receptor ?? [];
}

/** Restores a receptor only when it holds input; an empty one is omitted. */
export function setReceptor(state: NodeState, receptor: readonly QueueEntry[]): void {
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

export function isFieldResting(nodes: Iterable<NodeState>): boolean {
  for (const node of nodes) {
    if (
      node.active !== undefined ||
      node.pending !== undefined ||
      node.hover !== undefined ||
      receptorOf(node).length > 0
    ) {
      return false;
    }
  }
  return true;
}

export function snapshotField(
  definition: CompositionDefinition,
  nodes: ReadonlyMap<NodeId, NodeState>,
  rest: boolean,
): PheromoneFieldSnapshot {
  const nodeSnapshots: Record<NodeId, NodeStateSnapshot> = {};

  for (const [id, state] of nodes) {
    const snapshot: NodeStateSnapshot = {
      receptor: receptorOf(state).map(cloneEntry),
      state: state.state === undefined ? {} : structuredClone(state.state),
    };
    if (state.pending !== undefined) {
      snapshot.pending = clonePheromone(state.pending);
    }
    if (state.active !== undefined) {
      snapshot.active = clonePheromone(state.active);
    }
    if (state.hover !== undefined) {
      snapshot.hover = structuredClone(state.hover);
    }
    if (state.hoverPheromone !== undefined) {
      snapshot.hoverPheromone = clonePheromone(state.hoverPheromone);
    }
    if (state.lastActivatedAt !== undefined) {
      snapshot.lastActivatedAt = state.lastActivatedAt;
    }
    if (state.lastOutput !== undefined) {
      snapshot.lastOutput = cloneJson(state.lastOutput);
    }
    nodeSnapshots[id] = snapshot;
  }

  const field: PheromoneFieldSnapshot = {
    schemaVersion: 2,
    compositionId: definition.id,
    graphRevision: definition.graphRevision,
    rest,
    nodes: nodeSnapshots,
  };

  return deepFreeze(field);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  for (const key of Object.keys(value)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return Object.freeze(value);
}
