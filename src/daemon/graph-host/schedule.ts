import type {
  CompositionDefinition,
  PheromoneFieldSnapshot,
  PheromoneRuntime,
} from '../../runtime/index.js';

/** Earliest runtime wake or pending-node due instant. */
export function earliestDue(
  definition: CompositionDefinition,
  runtime: PheromoneRuntime,
  snapshot: PheromoneFieldSnapshot,
): number | undefined {
  const runtimeWake = runtime.nextWakeAt();
  const pendingDue = nextPendingAt(definition, snapshot);
  if (runtimeWake === undefined) {
    return pendingDue;
  }
  if (pendingDue === undefined) {
    return runtimeWake;
  }
  return Math.min(runtimeWake, pendingDue);
}

/** Earliest `lastActivatedAt + minIntervalMs` among pending nodes. */
function nextPendingAt(
  definition: CompositionDefinition,
  snapshot: PheromoneFieldSnapshot,
): number | undefined {
  let next: number | undefined;
  for (const [id, node] of definition.nodes) {
    const state = snapshot.nodes[id];
    if (state?.pending === undefined) {
      continue;
    }
    const last = state.lastActivatedAt;
    const due = last === undefined ? 0 : Date.parse(last) + node.minIntervalMs;
    if (!Number.isFinite(due)) {
      continue;
    }
    if (next === undefined || due < next) {
      next = due;
    }
  }
  return next;
}
