import type {
  CompositionDefinition,
  NodeId,
  NodeState,
  NodeStateSnapshot,
  Pheromone,
  PheromoneFieldSnapshot,
} from './types.js';

export function createNodeState(): NodeState {
  return { queue: [] };
}

export function clonePheromone(pheromone: Pheromone): Pheromone {
  return structuredClone(pheromone);
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
      node.queue.length > 0
    ) {
      return false;
    }
  }
  return true;
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
    for (const queued of node.queue) {
      pheromones.push(clonePheromone(queued));
    }
  }
  return pheromones;
}

export function snapshotField(
  definition: CompositionDefinition,
  nodes: ReadonlyMap<NodeId, NodeState>,
  rest: boolean,
): PheromoneFieldSnapshot {
  const nodeSnapshots: Record<NodeId, NodeStateSnapshot> = {};

  for (const [id, state] of nodes) {
    const snapshot: NodeStateSnapshot = {
      queue: state.queue.map(clonePheromone),
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
    if (state.lastActivatedAt !== undefined) {
      snapshot.lastActivatedAt = state.lastActivatedAt;
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
