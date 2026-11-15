import type { ConversationStore } from '../storage/conversation-store.js';
import type { Workspace } from './workspace.js';

/** One WAX session and the native conversation it is bound to. */
export interface SessionRecord {
  /** WAX conversation id. */
  readonly sessionId: string;
  /** Native session/thread id. */
  readonly nativeId: string;
  readonly harness: string;
  readonly projectId: string;
  readonly projectDirectory: string;
  readonly displayName: string;
  readonly createdAt: string;
  /**
   * Last time the session was created, resumed, attached or used by a graph.
   * It is the idle-TTL clock; the durable form of this value is
   * `ConversationRecord.updatedAt` (there is no separate store field).
   */
  readonly lastAccessAt: string;
  readonly model?: string;
  readonly reasoning?: string;
}

export interface SessionRegistryOptions {
  /**
   * One Workspace per harness. A session record's `harness` selects its
   * workspace; there is no single-workspace constructor form.
   */
  readonly workspaces: ReadonlyMap<string, Workspace>;
  /** Durable session mappings; when omitted the registry is memory-only. */
  readonly store?: ConversationStore;
  /** ISO timestamp source; tests inject a fixed clock. */
  readonly now?: () => string;
}

export interface SweepSessionsOptions {
  /** Sessions idle for at least this long are closed; `<= 0` is a no-op. */
  readonly idleTtlMs: number;
  /** Session ids the caller must not close (for example graph-bound ones). */
  readonly exclude?: ReadonlySet<string>;
  /** ISO timestamp source for this pass; defaults to the registry clock. */
  readonly now?: () => string;
}

/**
 * Outcome of one idle-session sweep. `failed` carries a static, sanitized
 * message only: a native close error is never forwarded to a control caller.
 */
export interface SweepSessionsReport {
  readonly closed: readonly string[];
  readonly skipped: readonly string[];
  readonly failed: readonly { readonly sessionId: string; readonly error: string }[];
}

/** Metadata stored next to a session; it is not forwarded to the adapter. */
export interface SessionMetadataOptions {
  readonly model?: string;
  readonly reasoning?: string;
}

export interface CreateSessionOptions extends SessionMetadataOptions {
  readonly displayName?: string;
  /** Required when more than one workspace is configured. */
  readonly harness?: string;
}

/**
 * `displayName` is absent because `Workspace.resumeConversation` cannot set a
 * display alias; a resumed conversation is named after its native id. A
 * preserved WAX id can be supplied so a persisted mapping survives a restart.
 */
export interface ResumeSessionOptions extends SessionMetadataOptions {
  readonly sessionId?: string;
  /** Required when more than one workspace is configured. */
  readonly harness?: string;
}
