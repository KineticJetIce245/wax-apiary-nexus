import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { CliUsageError, messageOf, readCompositionFile } from './cli-shared.js';
import { expandHomePath } from './conversation-store.js';
import {
  DaemonLockError,
  inspectDaemonLock,
  isProcessAlive,
} from './daemon-lock.js';
import { HoneyStore } from './honey.js';
import { findActiveReferences, type ActiveReference } from './revision.js';
import type {
  JoinStateSnapshot,
  NodeStateSnapshot,
  PersistedField,
  PheromoneFieldSnapshot,
} from './runtime/index.js';

/** Matches the default state root used by `wax run` and `wax daemon`. */
export const DEFAULT_COMPOSITION_STATE_DIR = '~/.wax';

const AUDIT_FILE = 'revisions.jsonl';

/** A replace was refused before anything was written. */
export class CompositionEditRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompositionEditRefusedError';
  }
}

/** A replace failed while writing the composition or its audit line. */
export class CompositionIoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompositionIoError';
  }
}

/**
 * Test seams for the atomic write and the audit append. Production callers use
 * the defaults; tests can make one step fail without a read-only directory.
 */
export interface CompositionEditDependencies {
  readonly writeTemp?: (path: string, contents: string) => void;
  readonly rename?: (from: string, to: string) => void;
  readonly remove?: (path: string) => void;
  readonly mkdir?: (path: string) => void;
  readonly appendAudit?: (path: string, line: string) => void;
}

export interface ReplaceCompositionOptions {
  readonly file: string;
  readonly withFile: string;
  /** State root for the audit and, with `apiary`, for the Honey field. */
  readonly stateDir: string;
  readonly apiary?: string;
  readonly now?: () => Date;
}

export type ActiveReferenceCheck =
  | { readonly status: 'checked' }
  | { readonly status: 'not-checked'; readonly reason: string };

export interface ReplaceCompositionResult {
  readonly compositionId: string;
  readonly oldRevision: string;
  readonly newRevision: string;
  /** Absolute path of the file that was replaced. */
  readonly file: string;
  readonly auditPath: string;
  readonly activeReferences: ActiveReferenceCheck;
  /** A stale lock was found and deliberately left in place. */
  readonly staleLockPath?: string;
}

/** `<stateDir>/revisions.jsonl`, shared by all compositions. */
export function compositionAuditPath(stateDir: string): string {
  return resolve(expandHomePath(stateDir), AUDIT_FILE);
}

/**
 * Replaces one composition file with another after validating both.
 *
 * 4A is deliberately stricter than `assertEditKeepsReferences`: any queue,
 * pending, active, hover or merge-waiting reference blocks a whole-file
 * replace, even when the next graph keeps the node. There is no `--force` and
 * no `needsAttention` write in this stage.
 */
export function replaceComposition(
  options: ReplaceCompositionOptions,
  deps: CompositionEditDependencies = {},
): ReplaceCompositionResult {
  const current = readCompositionFile(options.file);
  const next = readCompositionFile(options.withFile);

  if (current.definition.id !== next.definition.id) {
    throw new CompositionEditRefusedError(
      `refused: composition id mismatch: current '${current.definition.id}', ` +
        `next '${next.definition.id}'`,
    );
  }

  let activeReferences: ActiveReferenceCheck = {
    status: 'not-checked',
    reason: 'no --apiary given; no Honey field can be resolved',
  };
  let staleLockPath: string | undefined;

  if (options.apiary !== undefined) {
    let store: HoneyStore;
    try {
      store = HoneyStore.forComposition(
        options.stateDir,
        options.apiary,
        current.definition.id,
      );
    } catch (error) {
      throw new CliUsageError(messageOf(error));
    }

    const lockPath = join(store.paths.directory, 'daemon.lock');
    try {
      const lock = inspectDaemonLock(lockPath);
      if (lock !== undefined) {
        if (isProcessAlive(lock.pid)) {
          throw new CompositionEditRefusedError(
            `refused: daemon lock ${lockPath} is held by live pid ${String(lock.pid)}`,
          );
        }
        // 4A never removes or replaces a lock. Leave the stale file for the
        // owner/daemon path to handle.
        staleLockPath = lockPath;
      }
    } catch (error) {
      if (error instanceof DaemonLockError) {
        throw new CompositionEditRefusedError(`refused: ${error.message}`);
      }
      throw error;
    }

    let field: PersistedField | undefined;
    try {
      field = store.load();
    } catch (error) {
      throw new CompositionEditRefusedError(
        `refused: cannot verify active references from ${store.paths.field}: ${messageOf(error)}`,
      );
    }

    if (field === undefined) {
      activeReferences = {
        status: 'not-checked',
        reason: `no Honey field at ${store.paths.field}`,
      };
    } else {
      if (field.compositionId !== current.definition.id) {
        throw new CompositionEditRefusedError(
          `refused: Honey field at ${store.paths.field} belongs to ` +
            `composition '${field.compositionId}'`,
        );
      }
      const references = findActiveReferences(snapshotFromPersisted(field));
      if (references.length > 0) {
        throw new CompositionEditRefusedError(
          `refused: active references exist: ${formatReferences(references)}`,
        );
      }
      activeReferences = { status: 'checked' };
    }
  }

  const file = resolve(options.file);
  const auditPath = compositionAuditPath(options.stateDir);
  const at = (options.now ?? (() => new Date()))().toISOString();

  writeCompositionAtomic(file, next.text, deps);

  // The audit is appended only after the composition is in place. A failure
  // here exits non-zero, but cannot roll the rename back; 4A has no backup.
  const line = JSON.stringify({
    at,
    compositionId: current.definition.id,
    oldRevision: current.definition.graphRevision,
    newRevision: next.definition.graphRevision,
    file,
    mode: 'replace',
  });
  try {
    (deps.mkdir ?? ((path: string) => mkdirSync(path, { recursive: true })))(
      dirname(auditPath),
    );
    (deps.appendAudit ??
      ((path: string, text: string) =>
        appendFileSync(path, text, { encoding: 'utf8', mode: 0o600 })))(
      auditPath,
      `${line}\n`,
    );
  } catch (error) {
    throw new CompositionIoError(
      `composition ${file} was replaced, but the revision audit at ${auditPath} ` +
        `could not be written: ${messageOf(error)}`,
    );
  }

  return {
    compositionId: current.definition.id,
    oldRevision: current.definition.graphRevision,
    newRevision: next.definition.graphRevision,
    file,
    auditPath,
    activeReferences,
    ...(staleLockPath === undefined ? {} : { staleLockPath }),
  };
}

/**
 * Writes the exact next-file text to a unique temp file in the same directory,
 * then renames it over the old file. The old file is never truncated first.
 */
export function writeCompositionAtomic(
  file: string,
  contents: string,
  deps: CompositionEditDependencies = {},
): void {
  const temp = join(
    dirname(file),
    `.${basename(file)}.tmp-${String(process.pid)}-${randomUUID()}`,
  );
  const writeTemp =
    deps.writeTemp ??
    ((path: string, text: string) =>
      writeFileSync(path, text, { encoding: 'utf8', flag: 'wx' }));
  const rename =
    deps.rename ??
    ((from: string, to: string) => {
      renameSync(from, to);
    });
  const remove =
    deps.remove ??
    ((path: string) => {
      rmSync(path, { force: true });
    });

  try {
    writeTemp(temp, contents);
  } catch (error) {
    safeRemove(remove, temp);
    throw new CompositionIoError(
      `could not write temporary composition file ${temp}: ${messageOf(error)}`,
    );
  }

  try {
    rename(temp, file);
  } catch (error) {
    safeRemove(remove, temp);
    throw new CompositionIoError(
      `could not replace composition file ${file}: ${messageOf(error)}`,
    );
  }
}

function safeRemove(remove: (path: string) => void, path: string): void {
  try {
    remove(path);
  } catch {
    // The old composition is untouched; leave an unexpected temp file alone.
  }
}

/**
 * `findActiveReferences` expects the runtime snapshot shape. A persisted field
 * is very close but omits `state` and stores joins as a forkId-keyed object.
 */
function snapshotFromPersisted(field: PersistedField): PheromoneFieldSnapshot {
  const nodes: Record<string, NodeStateSnapshot> = {};

  for (const [id, state] of Object.entries(field.nodes)) {
    let joins: Record<string, JoinStateSnapshot> | undefined;
    if (state.joins !== undefined) {
      joins = {};
      for (const [forkId, join] of Object.entries(state.joins)) {
        joins[forkId] = {
          forkId,
          arrived: join.arrived,
          ...(join.lineage === undefined ? {} : { lineage: join.lineage }),
          ...(join.completedAt === undefined ? {} : { completedAt: join.completedAt }),
          ...(join.deadlineAt === undefined ? {} : { deadlineAt: join.deadlineAt }),
          ...(join.timedOutAt === undefined ? {} : { timedOutAt: join.timedOutAt }),
        };
      }
    }

    nodes[id] = {
      queue: state.queue,
      state: state.state ?? {},
      ...(state.pending === undefined ? {} : { pending: state.pending }),
      ...(state.active === undefined ? {} : { active: state.active }),
      ...(state.hover === undefined ? {} : { hover: state.hover }),
      ...(state.lastActivatedAt === undefined
        ? {}
        : { lastActivatedAt: state.lastActivatedAt }),
      ...(joins === undefined ? {} : { joins }),
    };
  }

  return {
    schemaVersion: 1,
    compositionId: field.compositionId,
    graphRevision: field.graphRevision,
    rest: field.rest,
    pheromones: [],
    nodes,
  };
}

function formatReferences(references: readonly ActiveReference[]): string {
  return references
    .map((reference) => `${reference.nodeId}(${reference.reason})`)
    .join(', ');
}
