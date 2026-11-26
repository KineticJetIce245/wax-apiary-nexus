import type { EngineContext } from './engine-context.js';
import { ReceptorFullError } from './receptor-overflow.js';
import { logDropped } from './runtime-log.js';
import { appendEntry } from './queue.js';
import type { EdgeDefinition, EdgeWhen, NodeDefinition, Pheromone, QueueEntry } from './types.js';

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
 *
 * A full target is the temporary §9 behaviour: the moved value is dropped and
 * the drop is logged; the pump keeps running and nothing is retried.
 */
export function emitAlong(
  ctx: EngineContext,
  node: NodeDefinition,
  pheromone: Pheromone,
  branch?: EdgeWhen,
): boolean {
  const edge = outgoingEdge(ctx, node, branch);
  if (edge === undefined) {
    return false;
  }
  const entry = pheromone as QueueEntry;
  entry.enqueuedAt = ctx.iso();
  try {
    appendEntry(ctx.queue, edge.to, entry, 'pheromone.emitted');
  } catch (error) {
    if (!(error instanceof ReceptorFullError)) {
      throw error;
    }
    logDropped(ctx.log, node.id, node.kind, `target-full:${edge.to}`, {
      enqueuedAt: entry.enqueuedAt,
      queueDepth: error.pending,
      limit: error.limit,
    });
  }
  return true;
}
