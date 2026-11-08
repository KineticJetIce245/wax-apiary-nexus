import type { BindingLookup } from '../graph/binding.js';
import type { Project } from '../project/kernel.js';
import type {
  ConversationRecord,
  ConversationStore,
} from '../storage/conversation-store.js';
import type { Conversation, Workspace } from './workspace.js';

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

export class SessionAlreadyRegisteredError extends Error {
  constructor(readonly nativeId: string) {
    super(`A session with native id '${nativeId}' is already registered`);
    this.name = 'SessionAlreadyRegisteredError';
  }
}

export class SessionNotFoundError extends Error {
  constructor(readonly sessionId: string) {
    super(`Unknown session: ${sessionId}`);
    this.name = 'SessionNotFoundError';
  }
}

export class SessionBusyError extends Error {
  constructor(readonly sessionId: string) {
    super(`Session is busy: ${sessionId}`);
    this.name = 'SessionBusyError';
  }
}

/**
 * A hydrated session could not be reattached to its native conversation. The
 * record is kept so the caller may retry; this error is never thrown by
 * `create`/`resume`, which surface the underlying failure.
 */
export class SessionAttachError extends Error {
  constructor(
    readonly sessionId: string,
    readonly nativeId: string,
    options?: { readonly cause?: unknown },
  ) {
    super(`Failed to attach session '${sessionId}' to native session '${nativeId}'`, options);
    this.name = 'SessionAttachError';
  }
}

export interface SessionRegistryOptions {
  readonly workspace: Workspace;
  readonly harness: string;
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
}

/**
 * `displayName` is absent because `Workspace.resumeConversation` cannot set a
 * display alias; a resumed conversation is named after its native id. A
 * preserved WAX id can be supplied so a persisted mapping survives a restart.
 */
export interface ResumeSessionOptions extends SessionMetadataOptions {
  readonly sessionId?: string;
}

/**
 * Session registry for one process. When a store is supplied, mappings survive
 * a restart: records are hydrated on construction (without resuming anything)
 * and `ensureAttached` lazily reattaches a hydrated record to its native
 * conversation. All read methods return copies, and `get`/`isBusy` satisfy the
 * binding validator's lookup contract without attaching.
 */
export class SessionRegistry implements BindingLookup {
  private readonly workspace: Workspace;
  private readonly harnessName: string;
  private readonly store: ConversationStore | undefined;
  private readonly now: () => string;
  private readonly records = new Map<string, SessionRecord>();
  /** Native ids reserved by an in-flight resume; prevents duplicate registration. */
  private readonly resumingNativeIds = new Set<string>();
  /** One in-flight lazy attach per session id; concurrent callers share it. */
  private readonly attaching = new Map<string, Promise<SessionRecord>>();

  constructor(options: SessionRegistryOptions) {
    this.workspace = options.workspace;
    this.harnessName = options.harness;
    this.store = options.store;
    this.now = options.now ?? (() => new Date().toISOString());
    if (this.store !== undefined) {
      for (const entry of this.store.load()) {
        // A store copied from another harness is not usable here. Skip the
        // entry rather than fail startup; the bad mapping is never attached.
        if (entry.harness !== this.harnessName) {
          continue;
        }
        const record = hydratedRecord(entry);
        this.records.set(record.sessionId, record);
      }
    }
  }

  /** The harness this registry creates sessions for (read-only). */
  get harness(): string {
    return this.harnessName;
  }

  async create(project: Project, options: CreateSessionOptions = {}): Promise<SessionRecord> {
    const conversation = await this.workspace.createConversation(
      project,
      options.displayName === undefined ? {} : { displayName: options.displayName },
    );
    if (this.isNativeIdReserved(conversation.nativeId)) {
      // The workspace created a conversation for a native session this registry
      // must not share. Close it best-effort so it is not leaked, then reject;
      // a cleanup failure must not mask the duplicate-registration error.
      try {
        await this.workspace.closeConversation(conversation.id);
      } catch {
        // Best effort: the conversation is never registered, so callers cannot
        // address it through the registry.
      }
      throw new SessionAlreadyRegisteredError(conversation.nativeId);
    }
    try {
      return this.register(conversation, options);
    } catch (error) {
      // Persistence failed before the record was registered. Close the
      // conversation best-effort so it is not leaked; the original store error
      // is the one callers can act on, so a cleanup failure must not mask it.
      await this.closeBestEffort(conversation.id);
      throw error;
    }
  }

  /**
   * Reattach to a native conversation created by an earlier process. Two
   * records may never share one native conversation, so a duplicate native id
   * is refused before the workspace is touched; an in-flight reservation also
   * covers concurrent calls.
   */
  async resume(
    project: Project,
    nativeId: string,
    options: ResumeSessionOptions = {},
  ): Promise<SessionRecord> {
    this.assertNativeIdAvailable(nativeId);
    this.resumingNativeIds.add(nativeId);
    try {
      const conversation = await this.workspace.resumeConversation(
        project,
        nativeId,
        options.sessionId,
      );
      try {
        return this.register(conversation, options);
      } catch (error) {
        // The native session was resumed but its mapping could not be
        // persisted. Close it best-effort and do not register the record.
        await this.closeBestEffort(conversation.id);
        throw error;
      }
    } finally {
      this.resumingNativeIds.delete(nativeId);
    }
  }

  /**
   * Make sure the session's native conversation is present in the workspace,
   * resuming it on first use. Hydration deliberately does not resume, so this
   * is the only lazy attach point. A failed attach keeps the record and is not
   * retried automatically.
   */
  async ensureAttached(sessionId: string): Promise<SessionRecord> {
    const record = this.records.get(sessionId);
    if (record === undefined) {
      throw new SessionNotFoundError(sessionId);
    }
    if (this.workspace.getConversation(sessionId) !== undefined) {
      return this.recordAccess(record);
    }
    const inFlight = this.attaching.get(sessionId);
    if (inFlight !== undefined) {
      return inFlight;
    }

    const attempt = this.attach(record);
    this.attaching.set(sessionId, attempt);
    try {
      return await attempt;
    } finally {
      if (this.attaching.get(sessionId) === attempt) {
        this.attaching.delete(sessionId);
      }
    }
  }

  /**
   * Refresh a session's `lastAccessAt` (memory and, best effort, its durable
   * mapping). Graph usage calls this, so a session that just finished a run is
   * not closed by the next idle sweep.
   *
   * Persistence is deliberately best effort: a store failure must not turn a
   * completed trigger/answer into an error, and the in-memory clock is what an
   * idle sweep reads. An unknown session still throws.
   */
  touch(sessionId: string): void {
    const record = this.records.get(sessionId);
    if (record === undefined) {
      throw new SessionNotFoundError(sessionId);
    }
    this.recordAccess(record);
  }

  /**
   * One idle sweep. It iterates a snapshot in insertion order and closes every
   * session that is not excluded, not busy and idle for at least `idleTtlMs`.
   * A close failure is collected and never aborts the rest of the pass, and an
   * unparsable timestamp is skipped rather than treated as expired.
   *
   * Bound sessions are not known here: the caller passes them in `exclude`.
   * `fresh_once` mappings are untouched; a stale mapping self-heals on the next
   * load (existing behavior).
   */
  async sweepIdle(options: SweepSessionsOptions): Promise<SweepSessionsReport> {
    const closed: string[] = [];
    const skipped: string[] = [];
    const failed: { sessionId: string; error: string }[] = [];
    if (!Number.isFinite(options.idleTtlMs) || options.idleTtlMs <= 0) {
      return { closed, skipped, failed };
    }

    const nowIso = (options.now ?? this.now)();
    const nowMs = Date.parse(nowIso);
    const exclude = options.exclude;

    // Snapshot first: `close` mutates the map. The snapshot keeps the pass's
    // decision order stable and lets a concurrent close surface as a failure.
    for (const record of [...this.records.values()]) {
      const sessionId = record.sessionId;
      if (exclude?.has(sessionId) === true) {
        skipped.push(sessionId);
        continue;
      }
      // Busy is checked before the TTL so a running session is never a
      // candidate, even if `close` would also refuse it.
      if (this.isBusy(sessionId)) {
        skipped.push(sessionId);
        continue;
      }
      const lastAccessMs = Date.parse(record.lastAccessAt);
      if (!Number.isFinite(nowMs) || !Number.isFinite(lastAccessMs)) {
        skipped.push(sessionId);
        continue;
      }
      if (nowMs - lastAccessMs < options.idleTtlMs) {
        skipped.push(sessionId);
        continue;
      }
      try {
        await this.close(sessionId);
        closed.push(sessionId);
      } catch (error) {
        failed.push({ sessionId, error: sweepErrorMessage(error) });
      }
    }

    return { closed, skipped, failed };
  }

  get(sessionId: string): SessionRecord | undefined {
    const record = this.records.get(sessionId);
    return record === undefined ? undefined : snapshotRecord(record);
  }

  list(): readonly SessionRecord[] {
    return [...this.records.values()].map((record) => snapshotRecord(record));
  }

  /** Unknown sessions are not busy, so the binding validator can ask safely. */
  isBusy(sessionId: string): boolean {
    if (!this.records.has(sessionId)) {
      return false;
    }
    return this.workspace.isConversationBusy(sessionId);
  }

  has(sessionId: string): boolean {
    return this.records.has(sessionId);
  }

  /**
   * Close an idle session. A busy session is refused rather than cancelled:
   * callers must settle or stop the execution first. The record is removed only
   * after the workspace close succeeds. A hydrated session that was never
   * attached has no workspace conversation, so only its record and store entry
   * are removed.
   */
  async close(sessionId: string): Promise<void> {
    if (!this.records.has(sessionId)) {
      throw new SessionNotFoundError(sessionId);
    }
    const attached = this.workspace.getConversation(sessionId) !== undefined;
    if (attached) {
      if (this.workspace.isConversationBusy(sessionId)) {
        throw new SessionBusyError(sessionId);
      }
      await this.workspace.closeConversation(sessionId);
    }
    this.records.delete(sessionId);
    this.store?.remove(sessionId);
  }

  private register(conversation: Conversation, metadata: SessionMetadataOptions): SessionRecord {
    const accessedAt = this.now();
    const record: SessionRecord = {
      sessionId: conversation.id,
      nativeId: conversation.nativeId,
      harness: this.harnessName,
      projectId: conversation.project.id,
      projectDirectory: conversation.project.directory,
      displayName: conversation.displayName,
      createdAt: accessedAt,
      lastAccessAt: accessedAt,
      ...(metadata.model === undefined ? {} : { model: metadata.model }),
      ...(metadata.reasoning === undefined ? {} : { reasoning: metadata.reasoning }),
    };
    // Persist first: if the store write fails, the caller cleans up the
    // conversation and no half-registered session is visible in memory.
    this.persist(record);
    this.records.set(record.sessionId, record);
    return snapshotRecord(record);
  }

  /**
   * Update the access clock in memory and persist best effort. A close that
   * races this call wins: the record is not resurrected and no write happens.
   */
  private recordAccess(record: SessionRecord): SessionRecord {
    const current = this.records.get(record.sessionId);
    if (current === undefined) {
      // Closed concurrently; return the last known snapshot rather than
      // re-inserting a session nobody can address.
      return snapshotRecord(record);
    }
    const updated: SessionRecord = { ...current, lastAccessAt: this.now() };
    this.records.set(updated.sessionId, updated);
    try {
      this.persist(updated);
    } catch {
      // Best effort: the in-memory clock drives sweepIdle, and callers using a
      // session must not fail because the durable timestamp could not be
      // rewritten.
    }
    return snapshotRecord(updated);
  }

  /** Persist the current mapping; a no-op for a memory-only registry. */
  private persist(record: SessionRecord): void {
    this.store?.upsert(recordForStore(record));
  }

  private async attach(record: SessionRecord): Promise<SessionRecord> {
    try {
      await this.workspace.resumeConversation(
        { id: record.projectId, directory: record.projectDirectory },
        record.nativeId,
        record.sessionId,
      );
    } catch (error) {
      throw new SessionAttachError(record.sessionId, record.nativeId, { cause: error });
    }
    return this.recordAccess(record);
  }

  private async closeBestEffort(conversationId: string): Promise<void> {
    try {
      await this.workspace.closeConversation(conversationId);
    } catch {
      // The conversation is not registered, so callers cannot address it; the
      // original persistence error is the useful failure.
    }
  }

  private isNativeIdReserved(nativeId: string): boolean {
    for (const record of this.records.values()) {
      if (record.nativeId === nativeId) {
        return true;
      }
    }
    return this.resumingNativeIds.has(nativeId);
  }

  private assertNativeIdAvailable(nativeId: string): void {
    if (this.isNativeIdReserved(nativeId)) {
      throw new SessionAlreadyRegisteredError(nativeId);
    }
  }
}

function snapshotRecord(record: SessionRecord): SessionRecord {
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
function recordForStore(record: SessionRecord): ConversationRecord {
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
function hydratedRecord(entry: ConversationRecord): SessionRecord {
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

/**
 * Static sweep-failure text. A close error may come from the native adapter,
 * so its message is never forwarded: a control caller only learns that this
 * session could not be closed, not anything a native process said.
 */
function sweepErrorMessage(error: unknown): string {
  if (error instanceof SessionBusyError) {
    return 'session is busy';
  }
  if (error instanceof SessionNotFoundError) {
    return 'session not found';
  }
  return 'close failed';
}
