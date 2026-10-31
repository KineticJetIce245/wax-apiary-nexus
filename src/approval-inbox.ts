import type { ApprovalRequest } from './adapters/harness.js';

export interface ApprovalInboxEntry {
  readonly id: number;
  readonly connection: string;
  readonly request: ApprovalRequest;
}

/**
 * Stable, never-reused display ids for pending approvals.
 *
 * The CLI previously used list positions, so a timed-out approval could make a
 * later `/approve 1` target a different connection's request. An id here is
 * bound to one connection/execution/request for the lifetime of the process;
 * removing the entry makes the id permanently unknown instead of re-pointing it.
 */
export class ApprovalInbox {
  private nextId = 1;
  private readonly entries = new Map<number, ApprovalInboxEntry>();

  add(connection: string, request: ApprovalRequest): ApprovalInboxEntry {
    const entry: ApprovalInboxEntry = { id: this.nextId, connection, request };
    this.nextId += 1;
    this.entries.set(entry.id, entry);
    return entry;
  }

  get(id: number): ApprovalInboxEntry | undefined {
    return this.entries.get(id);
  }

  list(): readonly ApprovalInboxEntry[] {
    return [...this.entries.values()];
  }

  remove(connection: string, requestId: string): ApprovalInboxEntry | undefined {
    for (const [id, entry] of this.entries) {
      if (entry.connection === connection && entry.request.requestId === requestId) {
        this.entries.delete(id);
        return entry;
      }
    }
    return undefined;
  }

  clear(): void {
    this.entries.clear();
  }
}
