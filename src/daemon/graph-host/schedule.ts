import type {
  CompositionDefinition,
  PheromoneFieldSnapshot,
} from '../../runtime/index.js';

/** Earliest pending-node due instant; there is no separate runtime timed wake. */
export function earliestDue(
  definition: CompositionDefinition,
  snapshot: PheromoneFieldSnapshot,
): number | undefined {
  return nextPendingAt(definition, snapshot);
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
