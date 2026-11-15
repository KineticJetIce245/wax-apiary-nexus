import type { ConversationStore } from '../storage/conversation-store.js';
import {
  SessionAlreadyRegisteredError,
  SessionNotFoundError,
} from './session-errors.js';
import { hydratedRecord, recordForStore, snapshotRecord } from './session-record.js';
import type { SessionMetadataOptions, SessionRecord } from './session-types.js';
import type { Conversation } from './workspace.js';

export interface SessionRecordStoreOptions {
  /** Durable session mappings; when omitted the store is memory-only. */
  readonly store?: ConversationStore;
  /** ISO timestamp source; tests inject a fixed clock. */
  readonly now?: () => string;
}

/**
 * In-memory session records plus their durable `sessions.json` mapping.
 *
 * Hydration rebuilds every record without resuming anything. Register persists
 * before making a record visible, while `access` is deliberately best effort:
 * a completed trigger must not fail because its idle-TTL timestamp could not be
 * rewritten. Native-id uniqueness is scoped per harness and also covers an
 * in-flight resume reservation.
 */
export class SessionRecordStore {
  private readonly store: ConversationStore | undefined;
  private readonly now: () => string;
  private readonly records = new Map<string, SessionRecord>();
  /** `${harness}\0${nativeId}` reservations for in-flight resumes. */
  private readonly resumingNativeIds = new Set<string>();

  constructor(options: SessionRecordStoreOptions = {}) {
    this.store = options.store;
    this.now = options.now ?? (() => new Date().toISOString());
    if (this.store !== undefined) {
      // Hydration keeps every harness. A record whose harness has no workspace
      // stays visible and fails clearly on attach instead of being discarded.
      for (const entry of this.store.load()) {
        const record = hydratedRecord(entry);
        this.records.set(record.sessionId, record);
      }
    }
  }

  /** Snapshot of every record, in insertion order. */
  all(): readonly SessionRecord[] {
    return [...this.records.values()].map((record) => snapshotRecord(record));
  }

  /** Snapshot of one record, or undefined. */
  get(sessionId: string): SessionRecord | undefined {
    const record = this.records.get(sessionId);
    return record === undefined ? undefined : snapshotRecord(record);
  }

  /** Internal live record; callers must not mutate or retain it. */
  find(sessionId: string): SessionRecord | undefined {
    return this.records.get(sessionId);
  }

  /** Persist first, then publish; a failed write leaves no visible record. */
  register(
    conversation: Conversation,
    metadata: SessionMetadataOptions,
    harness: string,
  ): SessionRecord {
    const accessedAt = this.now();
    const record: SessionRecord = {
      sessionId: conversation.id,
      nativeId: conversation.nativeId,
      harness,
      projectId: conversation.project.id,
      projectDirectory: conversation.project.directory,
      displayName: conversation.displayName,
      createdAt: accessedAt,
      lastAccessAt: accessedAt,
      ...(metadata.model === undefined ? {} : { model: metadata.model }),
      ...(metadata.reasoning === undefined ? {} : { reasoning: metadata.reasoning }),
    };
    this.store?.upsert(recordForStore(record));
    this.records.set(record.sessionId, record);
    return snapshotRecord(record);
  }

  /**
   * Refresh the access clock in memory and persist best effort. A close that
   * races this call wins: the record is not resurrected and no write happens.
   */
  access(record: SessionRecord): SessionRecord {
    const current = this.records.get(record.sessionId);
    if (current === undefined) {
      return snapshotRecord(record);
    }
    const updated: SessionRecord = { ...current, lastAccessAt: this.now() };
    this.records.set(updated.sessionId, updated);
    try {
      this.store?.upsert(recordForStore(updated));
    } catch {
      // Best effort: the in-memory clock drives sweepIdle, and callers using a
      // session must not fail because the durable timestamp could not be
      // rewritten.
    }
    return snapshotRecord(updated);
  }

  /** Drop the record and its durable mapping after the native close succeeds. */
  remove(sessionId: string): void {
    this.records.delete(sessionId);
    this.store?.remove(sessionId);
  }

  /** Refresh one session's access clock; an unknown session id throws. */
  touch(sessionId: string): SessionRecord {
    const record = this.records.get(sessionId);
    if (record === undefined) {
      throw new SessionNotFoundError(sessionId);
    }
    return this.access(record);
  }

  isNativeIdReserved(harness: string, nativeId: string): boolean {
    for (const record of this.records.values()) {
      if (record.harness === harness && record.nativeId === nativeId) {
        return true;
      }
    }
    return this.resumingNativeIds.has(nativeKey(harness, nativeId));
  }

  /** Reserve a native id before an async resume; duplicate ids are refused. */
  reserveNativeId(harness: string, nativeId: string): void {
    if (this.isNativeIdReserved(harness, nativeId)) {
      throw new SessionAlreadyRegisteredError(nativeId);
    }
    this.resumingNativeIds.add(nativeKey(harness, nativeId));
  }

  releaseNativeId(harness: string, nativeId: string): void {
    this.resumingNativeIds.delete(nativeKey(harness, nativeId));
  }

  nowIso(): string {
    return this.now();
  }
}

function nativeKey(harness: string, nativeId: string): string {
  return `${harness}\u0000${nativeId}`;
}
