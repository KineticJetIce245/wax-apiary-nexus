import type { GraphBindings } from '../../graph/binding.js';
import type { GraphId } from '../../graph/registry.js';
import { GraphSessionBusyError } from './types.js';
import type { GraphHostContext } from './context.js';

/**
 * Explicit-session reservations. A reservation is held from the start of a
 * load until that graph unloads; a failed load releases it.
 */
export class SessionOwnership {
  private readonly owners = new Map<string, GraphId>();

  constructor(private readonly context: GraphHostContext) {}

  /**
   * Reserve every explicit `session` binding for this load. A session already
   * held by another loaded graph, or by a concurrent in-flight load, is a typed
   * rejection. `fresh` bindings reserve nothing: they have no session yet.
   */
  reserve(graphId: GraphId, bindings: GraphBindings): () => void {
    const reserved: string[] = [];
    const release = (): void => {
      for (const sessionId of reserved) {
        if (this.owners.get(sessionId) === graphId) {
          this.owners.delete(sessionId);
        }
      }
    };

    try {
      for (const binding of Object.values(bindings)) {
        if (binding.kind !== 'session') {
          continue;
        }
        const sessionId = binding.sessionId;
        const existingOwner =
          this.owners.get(sessionId) ?? this.findLoadedOwner(sessionId, graphId);
        if (existingOwner !== undefined && existingOwner !== graphId) {
          throw new GraphSessionBusyError(graphId, sessionId, existingOwner);
        }
        if (this.owners.get(sessionId) === undefined) {
          this.owners.set(sessionId, graphId);
          reserved.push(sessionId);
        }
      }
    } catch (error) {
      release();
      throw error;
    }

    return release;
  }

  release(graphId: GraphId): void {
    for (const [sessionId, owner] of this.owners) {
      if (owner === graphId) {
        this.owners.delete(sessionId);
      }
    }
  }

  clear(): void {
    this.owners.clear();
  }

  private findLoadedOwner(sessionId: string, excludingGraphId: GraphId): GraphId | undefined {
    for (const entry of this.context.graphs.list()) {
      if (entry.id === excludingGraphId) {
        continue;
      }
      for (const record of entry.value.instantiated.sessions.values()) {
        if (record.sessionId === sessionId) {
          return entry.id;
        }
      }
    }
    return undefined;
  }
}
