import type { GraphBindings } from '../../graph/binding.js';
import type { GraphId } from '../../graph/registry.js';

/**
 * Explicit-session reservations, refcounted per session.
 *
 * Several loaded LiveHives may share one explicit session: the session
 * execution queue in front of `trigger` serializes the actual executions, so
 * sharing is safe and no longer a typed rejection. A reservation is held from
 * the start of a load until that graph unloads; a failed load releases only the
 * sessions this call added.
 *
 * Loading the same graph id twice is still refused by `GraphHostLifecycle`
 * before this layer is consulted.
 */
export class SessionOwnership {
  private readonly owners = new Map<string, Set<GraphId>>();

  /** Register this graph's explicit session bindings; never throws. */
  reserve(graphId: GraphId, bindings: GraphBindings): () => void {
    const touched: string[] = [];
    for (const binding of Object.values(bindings)) {
      if (binding.kind !== 'session') {
        continue;
      }
      const sessionId = binding.sessionId;
      const owners = this.owners.get(sessionId);
      if (owners === undefined) {
        this.owners.set(sessionId, new Set([graphId]));
        touched.push(sessionId);
        continue;
      }
      if (!owners.has(graphId)) {
        owners.add(graphId);
        touched.push(sessionId);
      }
    }
    // The rollback removes only the sessions this call registered; a shared
    // session that another loaded graph still holds survives.
    return () => {
      this.releaseSessions(graphId, touched);
    };
  }

  release(graphId: GraphId): void {
    this.releaseSessions(graphId, [...this.owners.keys()]);
  }

  clear(): void {
    this.owners.clear();
  }

  private releaseSessions(graphId: GraphId, sessionIds: readonly string[]): void {
    for (const sessionId of sessionIds) {
      const owners = this.owners.get(sessionId);
      if (owners === undefined) {
        continue;
      }
      owners.delete(graphId);
      if (owners.size === 0) {
        this.owners.delete(sessionId);
      }
    }
  }
}
