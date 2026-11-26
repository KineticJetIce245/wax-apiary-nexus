import type { EngineContext } from './engine-context.js';
import type { EdgeDefinition, EdgeWhen, NodeDefinition, Pheromone, QueueEntry } from './types.js';
import {
  appendEntry,
  consumeReservation,
  type OutputReservation,
} from './queue.js';

/** Finds the single outgoing edge for a Bee; condition/counter use the branch. */
export function outgoingEdge(
  ctx: EngineContext,
  node: NodeDefinition,
  branch?: EdgeWhen,
): EdgeDefinition | undefined {
  if (node.kind === 'condition' || node.kind === 'counter') {
    return ctx.definition.edges.find((edge) => edge.from === node.id && edge.when === branch);
  }
  return ctx.definition.edges.find((edge) => edge.from === node.id);
}

/**
 * Moves the same Pheromone object to the next Bee. The object already carries
 * its value; only the queue instant is refreshed, then the same reference is
 * appended to the target receptor. A normal beeline never allocates a second
 * Pheromone.
 */
export function emitAlong(
  ctx: EngineContext,
  node: NodeDefinition,
  pheromone: Pheromone,
  branch?: EdgeWhen,
  reservation?: OutputReservation,
): boolean {
  const edge = outgoingEdge(ctx, node, branch);
  if (edge === undefined) {
    return false;
  }
  if (reservation !== undefined) {
    consumeReservation(ctx.queue, reservation, edge.to);
  }
  const entry = pheromone as QueueEntry;
  entry.enqueuedAt = ctx.iso();
  appendEntry(ctx.queue, edge.to, entry, 'pheromone.emitted');
  return true;
}
