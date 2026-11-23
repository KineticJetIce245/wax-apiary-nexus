import type { BindingLookup } from '../graph/binding.js';
import type { Project } from '../project/kernel.js';
import {
  SessionAlreadyRegisteredError,
  SessionBusyError,
  SessionNotFoundError,
  UnknownHarnessError,
} from './session-errors.js';
import { SessionAttacher } from './session-attacher.js';
import { SessionRecordStore } from './session-record-store.js';
import { sweepIdleSessions } from './session-sweeper.js';
import type {
  CreateSessionOptions,
  ResumeSessionOptions,
  SessionRecord,
  SessionRegistryOptions,
  SweepSessionsOptions,
  SweepSessionsReport,
} from './session-types.js';
import type { Workspace } from './workspace.js';

export {
  SessionAlreadyRegisteredError,
  SessionAttachError,
  SessionBusyError,
  SessionNotFoundError,
  UnknownHarnessError,
} from './session-errors.js';
export type {
  CreateSessionOptions,
  ResumeSessionOptions,
  SessionMetadataOptions,
  SessionRecord,
  SessionRegistryOptions,
  SweepSessionsOptions,
  SweepSessionsReport,
} from './session-types.js';

interface WorkspaceConfiguration {
  readonly workspaces: ReadonlyMap<string, Workspace>;
}

/**
 * Session registry for one process. When a store is supplied, mappings survive
 * a restart: records are hydrated on construction (without resuming anything)
 * and `ensureAttached` lazily reattaches a hydrated record to its native
 * conversation. All read methods return copies, and `get`/`isBusy` satisfy the
 * binding validator's lookup contract without attaching.
 *
 * A record's `harness` selects its Workspace; this facade only routes and
 * delegates persistence/attach/sweep mechanics to the focused helpers.
 */
export class SessionRegistry implements BindingLookup {
  private readonly workspaces: ReadonlyMap<string, Workspace>;
  private readonly records: SessionRecordStore;
  private readonly attacher: SessionAttacher;

  constructor(options: SessionRegistryOptions) {
    const configuration = resolveWorkspaceConfiguration(options);
    this.workspaces = configuration.workspaces;
    this.records = new SessionRecordStore(options);
    this.attacher = new SessionAttacher({
      records: this.records,
      workspaces: this.workspaces,
    });
  }

  /** Harnesses with a Workspace in this registry, in configuration order. */
  harnesses(): readonly string[] {
    return [...this.workspaces.keys()];
  }

  workspaceFor(harness: string): Workspace {
    const workspace = this.workspaces.get(harness);
    if (workspace === undefined) {
      throw new UnknownHarnessError(harness);
    }
    return workspace;
  }

  async create(project: Project, options: CreateSessionOptions = {}): Promise<SessionRecord> {
    const harness = this.resolveCreateHarness(options.harness);
    const workspace = this.workspaceFor(harness);
    const conversation = await workspace.createConversation(
      project,
      options.displayName === undefined ? {} : { displayName: options.displayName },
    );
    if (this.records.isNativeIdReserved(harness, conversation.nativeId)) {
      // The workspace created a conversation for a native session this registry
      // must not share. Close it best-effort so it is not leaked, then reject;
      // a cleanup failure must not mask the duplicate-registration error.
      await closeConversationBestEffort(workspace, conversation.id);
      throw new SessionAlreadyRegisteredError(conversation.nativeId);
    }
    try {
      return this.records.register(conversation, options, harness);
    } catch (error) {
      // Persistence failed before the record was registered. Close the
      // conversation best-effort so it is not leaked; the original store error
      // is the one callers can act on, so a cleanup failure must not mask it.
      await closeConversationBestEffort(workspace, conversation.id);
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
    const harness = this.resolveCreateHarness(options.harness);
    const workspace = this.workspaceFor(harness);
    this.records.reserveNativeId(harness, nativeId);
    try {
      const conversation = await workspace.resumeConversation(
        project,
        nativeId,
        options.sessionId,
      );
      try {
        return this.records.register(conversation, options, harness);
      } catch (error) {
        // The native session was resumed but its mapping could not be
        // persisted. Close it best-effort and do not register the record.
        await closeConversationBestEffort(workspace, conversation.id);
        throw error;
      }
    } finally {
      this.records.releaseNativeId(harness, nativeId);
    }
  }

  /**
   * Make sure the session's native conversation is present in the workspace,
   * resuming it on first use. Hydration deliberately does not resume, so this
   * is the only lazy attach point. A failed attach keeps the record and is not
   * retried automatically.
   */
  ensureAttached(sessionId: string): Promise<SessionRecord> {
    return this.attacher.ensureAttached(sessionId);
  }

  /**
   * Refresh a session's `lastAccessAt` (memory and, best effort, its durable
   * mapping). Graph usage calls this, so a session that just finished a run is
   * not closed by the next idle sweep. An unknown session still throws.
   */
  touch(sessionId: string): void {
    this.records.touch(sessionId);
  }

  /** One idle sweep; see `sweepIdleSessions` for the pass semantics. */
  sweepIdle(options: SweepSessionsOptions): Promise<SweepSessionsReport> {
    return sweepIdleSessions(
      {
        all: () => this.records.all(),
        nowIso: () => this.records.nowIso(),
        isBusy: (sessionId) => this.isBusy(sessionId),
        close: (sessionId) => this.close(sessionId),
      },
      options,
    );
  }

  get(sessionId: string): SessionRecord | undefined {
    return this.records.get(sessionId);
  }

  list(): readonly SessionRecord[] {
    return this.records.all();
  }

  /** Unknown sessions are not busy, so the binding validator can ask safely. */
  isBusy(sessionId: string): boolean {
    const record = this.records.find(sessionId);
    if (record === undefined) {
      return false;
    }
    return this.workspaces.get(record.harness)?.isConversationBusy(sessionId) ?? false;
  }

  /**
   * True when the session's adapter serializes its own prompts. A busy session
   * may still be bound: the prompt waits in that adapter's FIFO.
   */
  canQueue(sessionId: string): boolean {
    const record = this.records.find(sessionId);
    if (record === undefined) {
      return false;
    }
    return this.workspaces.get(record.harness)?.canQueue() ?? false;
  }

  /**
   * Close an idle session. A busy session is refused rather than cancelled:
   * callers must settle or stop the execution first. The record is removed only
   * after the workspace close succeeds. A hydrated session that was never
   * attached has no workspace conversation, so only its record and store entry
   * are removed.
   */
  async close(sessionId: string): Promise<void> {
    const record = this.records.find(sessionId);
    if (record === undefined) {
      throw new SessionNotFoundError(sessionId);
    }
    const workspace = this.workspaces.get(record.harness);
    // A record without a workspace (hydrated for a harness this process does
    // not run) has no attached conversation; dropping the mapping is enough.
    if (workspace !== undefined && workspace.getConversation(sessionId) !== undefined) {
      if (workspace.isConversationBusy(sessionId)) {
        throw new SessionBusyError(sessionId);
      }
      await workspace.closeConversation(sessionId);
    }
    this.records.remove(sessionId);
  }

  /**
   * An explicit harness always wins. With exactly one configured workspace, an
   * omitted harness is unambiguous; with multiple workspaces it is an error.
   */
  private resolveCreateHarness(requested: string | undefined): string {
    if (requested !== undefined) {
      if (!this.workspaces.has(requested)) {
        throw new UnknownHarnessError(requested);
      }
      return requested;
    }
    const only = this.workspaces.size === 1 ? this.workspaces.keys().next().value : undefined;
    if (only === undefined) {
      throw new UnknownHarnessError(undefined);
    }
    return only;
  }
}

function resolveWorkspaceConfiguration(
  options: SessionRegistryOptions,
): WorkspaceConfiguration {
  if (options.workspaces === undefined || options.workspaces.size === 0) {
    throw new TypeError('workspaces must contain at least one harness');
  }
  return { workspaces: new Map(options.workspaces) };
}

async function closeConversationBestEffort(
  workspace: Workspace,
  conversationId: string,
): Promise<void> {
  try {
    await workspace.closeConversation(conversationId);
  } catch {
    // The conversation is not registered, so callers cannot address it; the
    // original persistence error is the useful failure.
  }
}
