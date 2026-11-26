import { HoneyIncompatibleError, FieldRestoreError } from './errors.js';
import type { RuntimeLogFieldsSink } from './log.js';
import { cloneEntry, clonePheromone } from './field.js';
import type {
  CompositionDefinition,
  NodeDefinition,
  NodeId,
  NodeState,
  PersistedField,
  PersistedNodeState,
  RecoveryReport,
} from './types.js';

/** Builds the durable `honey/field.json` v2 snapshot from live field state. */
export function exportField(
  definition: CompositionDefinition,
  states: ReadonlyMap<NodeId, NodeState>,
  rest: boolean,
): PersistedField {
  const nodes: Record<NodeId, PersistedNodeState> = {};
  for (const [id, state] of states) {
    nodes[id] = persistedNode(state);
  }
  return {
    schemaVersion: 2,
    compositionId: definition.id,
    graphRevision: definition.graphRevision,
    rest,
    nodes,
  };
}

function persistedNode(state: NodeState): PersistedNodeState {
  const receptor = state.receptor;
  return {
    ...(receptor === undefined || receptor.length === 0
      ? {}
      : { receptor: receptor.map(cloneEntry) }),
    ...(state.pending === undefined ? {} : { pending: clonePheromone(state.pending) }),
    ...(state.active === undefined ? {} : { active: clonePheromone(state.active) }),
    ...(state.hover === undefined ? {} : { hover: structuredClone(state.hover) }),
    ...(state.hoverPheromone === undefined
      ? {}
      : { hoverPheromone: clonePheromone(state.hoverPheromone) }),
    ...(state.lastActivatedAt === undefined
      ? {}
      : { lastActivatedAt: state.lastActivatedAt }),
    ...(state.state === undefined ? {} : { state: structuredClone(state.state) }),
  };
}

/**
 * Applies a persisted field to the runtime states. Queue entries, pending slots,
 * user hovers and an active activation are all resumed; the active one waits for
 * its own native result and is never replayed. A schema or shape mismatch fails
 * closed.
 */
export function applyPersistedField(
  definition: CompositionDefinition,
  states: ReadonlyMap<NodeId, NodeState>,
  field: PersistedField,
  log: RuntimeLogFieldsSink,
): RecoveryReport {
  assertCompatible(definition, field);
  const report: { resumedHovers: NodeId[]; active: NodeId[] } = {
    resumedHovers: [],
    active: [],
  };
  for (const [id, node] of definition.nodes) {
    const saved = field.nodes[id];
    if (saved === undefined) {
      continue;
    }
    restoreNode(node, stateOf(states, id), saved, report);
  }
  log({
    event: 'runtime.restored',
    outcome: `hovers=${String(report.resumedHovers.length)} active=${String(report.active.length)}`,
  });
  return { resumedHovers: report.resumedHovers };
}

function assertCompatible(
  definition: CompositionDefinition,
  field: PersistedField,
): void {
  if (field.schemaVersion !== 2) {
    throw new HoneyIncompatibleError(
      `unsupported field schemaVersion: ${String(field.schemaVersion)}`,
    );
  }
  if (field.compositionId !== definition.id) {
    throw new FieldRestoreError(
      `persisted field belongs to composition '${field.compositionId}', not '${definition.id}'`,
    );
  }
  if (field.graphRevision !== definition.graphRevision) {
    throw new FieldRestoreError(
      `persisted field was written for graph revision '${field.graphRevision}', current is '${definition.graphRevision}'`,
    );
  }
  for (const id of Object.keys(field.nodes)) {
    if (!definition.nodes.has(id)) {
      throw new FieldRestoreError(`persisted field has unknown node '${id}'`);
    }
  }
}

function restoreNode(
  node: NodeDefinition,
  state: NodeState,
  saved: PersistedNodeState,
  report: { resumedHovers: NodeId[]; active: NodeId[] },
): void {
  if (saved.receptor !== undefined && saved.receptor.length > 0) {
    state.receptor = saved.receptor.map(cloneEntry);
  }
  if (saved.pending !== undefined) {
    state.pending = clonePheromone(saved.pending);
  }
  if (saved.lastActivatedAt !== undefined) {
    state.lastActivatedAt = saved.lastActivatedAt;
  }
  if (saved.state !== undefined) {
    state.state = structuredClone(saved.state);
  }
  restoreHover(node, state, saved, report);
  restoreActive(node, state, saved, report);
}

function restoreHover(
  node: NodeDefinition,
  state: NodeState,
  saved: PersistedNodeState,
  report: { resumedHovers: NodeId[] },
): void {
  if (saved.hover === undefined) {
    return;
  }
  if (saved.hover.kind === 'user' && saved.hoverPheromone !== undefined) {
    state.hover = structuredClone(saved.hover);
    state.hoverPheromone = clonePheromone(saved.hoverPheromone);
    report.resumedHovers.push(node.id);
  }
  // A Guard/approval hover cannot be resumed after its native request is gone;
  // it is not replayed and is not auto-allowed. The field keeps no such hover.
}

function restoreActive(
  node: NodeDefinition,
  state: NodeState,
  saved: PersistedNodeState,
  report: { active: NodeId[] },
): void {
  if (saved.active === undefined) {
    return;
  }
  state.active = clonePheromone(saved.active);
  report.active.push(node.id);
}

function stateOf(states: ReadonlyMap<NodeId, NodeState>, nodeId: NodeId): NodeState {
  const state = states.get(nodeId);
  if (state === undefined) {
    throw new FieldRestoreError(`persisted field has unknown node '${nodeId}'`);
  }
  return state;
}
