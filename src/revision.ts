import type { CompositionDefinition, NodeId, PheromoneFieldSnapshot } from './runtime/index.js';

export type ReferenceReason = 'queue' | 'pending' | 'active' | 'hover' | 'merge-waiting';

export interface ActiveReference {
  readonly nodeId: NodeId;
  readonly reason: ReferenceReason;
}

/** A graph edit would orphan live work. */
export class GraphEditBlockedError extends Error {
  readonly references: readonly ActiveReference[];

  constructor(references: readonly ActiveReference[]) {
    super(
      `graph edit blocked by live references: ${references
        .map((reference) => `${reference.nodeId}(${reference.reason})`)
        .join(', ')}`,
    );
    this.name = 'GraphEditBlockedError';
    this.references = references;
  }
}

/** Every node that still holds queue, pending, active, hover or merge-waiting state. */
export function findActiveReferences(snapshot: PheromoneFieldSnapshot): ActiveReference[] {
  const references: ActiveReference[] = [];
  for (const [nodeId, state] of Object.entries(snapshot.nodes)) {
    if (state.queue.length > 0) {
      references.push({ nodeId, reason: 'queue' });
    }
    if (state.pending !== undefined) {
      references.push({ nodeId, reason: 'pending' });
    }
    if (state.active !== undefined) {
      references.push({ nodeId, reason: 'active' });
    }
    if (state.hover !== undefined) {
      references.push({ nodeId, reason: 'hover' });
    }
    if (state.joins !== undefined && Object.keys(state.joins).length > 0) {
      references.push({ nodeId, reason: 'merge-waiting' });
    }
  }
  return references;
}

/**
 * Checks a proposed composition against the live field before it replaces the
 * current definition.
 *
 * Removing (or renaming) a node that still owns queue/pending/active/hover or
 * merge-waiting state is refused by default. With `force`, the caller gets the
 * node ids back and must mark them stuck; the work is never silently migrated.
 */
export function assertEditKeepsReferences(
  current: CompositionDefinition,
  next: CompositionDefinition,
  snapshot: PheromoneFieldSnapshot,
  options: { readonly force?: boolean } = {},
): { readonly forced: readonly NodeId[] } {
  const removed = new Set([...current.nodes.keys()].filter((id) => !next.nodes.has(id)));
  const blocked = findActiveReferences(snapshot).filter((reference) => removed.has(reference.nodeId));

  if (blocked.length === 0) {
    return { forced: [] };
  }
  if (options.force !== true) {
    throw new GraphEditBlockedError(blocked);
  }
  return { forced: [...new Set(blocked.map((reference) => reference.nodeId))] };
}
