import type { ConversationRecord } from '../storage/conversation-store.js';
import type { SessionRecord } from './session-types.js';

/** Copy a record so registry readers cannot mutate internal state. */
export function snapshotRecord(record: SessionRecord): SessionRecord {
  return {
    sessionId: record.sessionId,
    nativeId: record.nativeId,
    harness: record.harness,
    projectId: record.projectId,
    projectDirectory: record.projectDirectory,
    displayName: record.displayName,
    createdAt: record.createdAt,
    lastAccessAt: record.lastAccessAt,
    ...(record.model === undefined ? {} : { model: record.model }),
    ...(record.reasoning === undefined ? {} : { reasoning: record.reasoning }),
  };
}

/**
 * The durable form of a session record. `updatedAt` is the store's clock and
 * carries `lastAccessAt`, so a restart resumes the idle TTL from the last use
 * instead of the creation time. No separate store field is needed.
 */
export function recordForStore(record: SessionRecord): ConversationRecord {
  return {
    conversationId: record.sessionId,
    harness: record.harness,
    nativeId: record.nativeId,
    projectId: record.projectId,
    projectDirectory: record.projectDirectory,
    updatedAt: record.lastAccessAt,
    displayName: record.displayName,
    createdAt: record.createdAt,
    ...(record.model === undefined ? {} : { model: record.model }),
    ...(record.reasoning === undefined ? {} : { reasoning: record.reasoning }),
  };
}

/**
 * Rebuild a session record from its durable form. The conversation is not
 * resumed here; `displayName`/`createdAt`/`lastAccessAt` have documented
 * fallbacks so records written before those fields existed remain usable.
 */
export function hydratedRecord(entry: ConversationRecord): SessionRecord {
  return {
    sessionId: entry.conversationId,
    nativeId: entry.nativeId,
    harness: entry.harness,
    projectId: entry.projectId,
    projectDirectory: entry.projectDirectory,
    displayName: entry.displayName ?? entry.nativeId,
    createdAt: entry.createdAt ?? entry.updatedAt,
    lastAccessAt: entry.updatedAt,
    ...(entry.model === undefined ? {} : { model: entry.model }),
    ...(entry.reasoning === undefined ? {} : { reasoning: entry.reasoning }),
  };
}
