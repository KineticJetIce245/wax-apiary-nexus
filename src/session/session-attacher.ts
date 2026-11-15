import {
  SessionAttachError,
  SessionNotFoundError,
  UnknownHarnessError,
} from './session-errors.js';
import type { SessionRecordStore } from './session-record-store.js';
import type { SessionRecord } from './session-types.js';
import type { Workspace } from './workspace.js';

export interface SessionAttacherOptions {
  readonly records: SessionRecordStore;
  readonly workspaces: ReadonlyMap<string, Workspace>;
}

/**
 * Lazily reattach hydrated sessions to their native conversation. Hydration
 * deliberately does not resume, so this is the only attach point. A failed
 * attach keeps the record and is not retried automatically; concurrent callers
 * for one session share the same attempt.
 */
export class SessionAttacher {
  private readonly records: SessionRecordStore;
  private readonly workspaces: ReadonlyMap<string, Workspace>;
  /** One in-flight lazy attach per session id; concurrent callers share it. */
  private readonly attaching = new Map<string, Promise<SessionRecord>>();

  constructor(options: SessionAttacherOptions) {
    this.records = options.records;
    this.workspaces = options.workspaces;
  }

  async ensureAttached(sessionId: string): Promise<SessionRecord> {
    const record = this.records.find(sessionId);
    if (record === undefined) {
      throw new SessionNotFoundError(sessionId);
    }
    const workspace = this.workspaces.get(record.harness);
    if (workspace === undefined) {
      // A hydrated record may name a harness that is not configured in this
      // process; keep the record and fail the attach clearly.
      throw new SessionAttachError(record.sessionId, record.nativeId, {
        cause: new UnknownHarnessError(record.harness),
      });
    }
    if (workspace.getConversation(sessionId) !== undefined) {
      return this.records.access(record);
    }
    const inFlight = this.attaching.get(sessionId);
    if (inFlight !== undefined) {
      return inFlight;
    }

    const attempt = this.attach(record, workspace);
    this.attaching.set(sessionId, attempt);
    try {
      return await attempt;
    } finally {
      if (this.attaching.get(sessionId) === attempt) {
        this.attaching.delete(sessionId);
      }
    }
  }

  private async attach(record: SessionRecord, workspace: Workspace): Promise<SessionRecord> {
    try {
      await workspace.resumeConversation(
        { id: record.projectId, directory: record.projectDirectory },
        record.nativeId,
        record.sessionId,
      );
    } catch (error) {
      throw new SessionAttachError(record.sessionId, record.nativeId, { cause: error });
    }
    return this.records.access(record);
  }
}
