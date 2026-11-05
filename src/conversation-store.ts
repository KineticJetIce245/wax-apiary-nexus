import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

/** One persisted conversation ↔ native session mapping. */
export interface ConversationRecord {
  readonly conversationId: string;
  readonly harness: string;
  readonly nativeId: string;
  readonly projectId: string;
  readonly projectDirectory: string;
  readonly updatedAt: string;
}

const LOCK_TIMEOUT_MS = 2_000;
const STALE_LOCK_MS = 30_000;
/** Per-process lock depth so nested writers in one process do not self-deadlock. */
const heldLocks = new Map<string, { depth: number; token: string }>();

export function defaultConversationStorePath(): string {
  return join(homedir(), '.wax', 'conversations.json');
}

/** Expand a leading `~` or `~/` to the user's home directory. */
export function expandHomePath(input: string): string {
  if (input === '~') {
    return homedir();
  }
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return join(homedir(), input.slice(2));
  }
  return input;
}

/** Case-insensitive on Windows, exact elsewhere. */
export function sameProjectPath(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const absolute = resolve(value);
    return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
  };
  return normalize(left) === normalize(right);
}

function isRecord(value: unknown): value is ConversationRecord {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.conversationId === 'string' &&
    typeof record.harness === 'string' &&
    typeof record.nativeId === 'string' &&
    typeof record.projectId === 'string' &&
    typeof record.projectDirectory === 'string' &&
    typeof record.updatedAt === 'string'
  );
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Small JSON store for conversation mappings. Writes are serialized with a
 * sibling lock file (two processes cannot lose each other's upserts) and go
 * through a temp file plus rename so a crash cannot leave a half-written file.
 */
export class ConversationStore {
  constructor(readonly filePath: string = defaultConversationStorePath()) {}

  load(): ConversationRecord[] {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error(`Conversation store must contain an array: ${this.filePath}`);
    }
    return parsed.filter(isRecord);
  }

  save(records: readonly ConversationRecord[]): void {
    const release = this.acquireLock();
    try {
      this.write(records);
    } finally {
      release();
    }
  }

  upsert(record: ConversationRecord): void {
    const release = this.acquireLock();
    try {
      this.cleanupStaleTemps();
      // Call the public load() (it may run user-provided hooks) and then merge
      // against a fresh read so a writer that slipped in during load() is not
      // lost.
      const snapshot = this.load().filter(
        (entry) => entry.conversationId !== record.conversationId,
      );
      snapshot.push(record);
      const merged = new Map<string, ConversationRecord>();
      for (const entry of this.readUnlocked()) {
        merged.set(entry.conversationId, entry);
      }
      for (const entry of snapshot) {
        merged.set(entry.conversationId, entry);
      }
      this.write([...merged.values()]);
    } finally {
      release();
    }
  }

  /** Read the file without taking the lock (caller already holds it). */
  private readUnlocked(): ConversationRecord[] {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error(`Conversation store must contain an array: ${this.filePath}`);
    }
    return parsed.filter(isRecord);
  }

  find(conversationId: string): ConversationRecord | undefined {
    return this.load().find((entry) => entry.conversationId === conversationId);
  }

  latestForProject(projectDirectory: string): ConversationRecord | undefined {
    const matches = this.load().filter((entry) =>
      sameProjectPath(entry.projectDirectory, projectDirectory),
    );
    matches.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return matches[0];
  }

  /** Remove temp files left behind by a crashed writer (older than one hour). */
  private cleanupStaleTemps(): void {
    const directory = dirname(this.filePath);
    const prefix = `${basename(this.filePath)}.`;
    let entries: string[];
    try {
      entries = readdirSync(directory);
    } catch {
      return;
    }
    for (const name of entries) {
      if (!name.startsWith(prefix) || !name.endsWith('.tmp')) {
        continue;
      }
      const target = join(directory, name);
      try {
        if (Date.now() - statSync(target).mtimeMs > 3_600_000) {
          unlinkSync(target);
        }
      } catch {
        // Another writer may have removed it first.
      }
    }
  }

  private write(records: readonly ConversationRecord[]): void {
    const directory = dirname(this.filePath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const tmp = `${this.filePath}.${String(process.pid)}.${randomUUID()}.tmp`;
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      writeSync(fd, JSON.stringify(records, null, 2));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      renameSync(tmp, this.filePath);
      if (process.platform !== 'win32') {
        try {
          const dirFd = openSync(directory, 'r');
          try {
            fsyncSync(dirFd);
          } finally {
            closeSync(dirFd);
          }
        } catch {
          // Directory fsync is best effort.
        }
      }
    } catch (error) {
      try {
        unlinkSync(tmp);
      } catch {
        // The temp file is already gone.
      }
      throw error;
    }
  }

  /** Exclusive lock with bounded retries and stale-lock recovery. */
  private acquireLock(): () => void {
    const lockPath = `${this.filePath}.lock`;
    const held = heldLocks.get(lockPath);
    if (held !== undefined) {
      // Reentrant within this process: the outer writer already owns the file.
      held.depth += 1;
      return () => this.releaseLock(lockPath);
    }
    mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    const token = `${String(process.pid)}-${randomUUID()}`;
    while (true) {
      try {
        const fd = openSync(lockPath, 'wx', 0o600);
        try {
          writeSync(
            fd,
            JSON.stringify({ pid: process.pid, at: new Date().toISOString(), token }),
          );
        } finally {
          closeSync(fd);
        }
        heldLocks.set(lockPath, { depth: 1, token });
        return () => this.releaseLock(lockPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error;
        }
        try {
          const stat = statSync(lockPath);
          if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
            unlinkSync(lockPath);
            continue;
          }
        } catch {
          // The lock disappeared between open and stat; retry immediately.
          continue;
        }
        if (Date.now() > deadline) {
          throw new Error(`Conversation store is locked: ${lockPath}`);
        }
        sleepSync(10);
      }
    }
  }

  private releaseLock(lockPath: string): void {
    const held = heldLocks.get(lockPath);
    if (held === undefined) {
      return;
    }
    if (held.depth > 1) {
      held.depth -= 1;
      return;
    }
    heldLocks.delete(lockPath);
    // Another process may have recovered this lock after it went stale; never
    // delete a lock file that no longer carries our token.
    try {
      const parsed = JSON.parse(readFileSync(lockPath, 'utf8')) as { token?: unknown };
      if (parsed.token !== held.token) {
        return;
      }
    } catch {
      return;
    }
    try {
      unlinkSync(lockPath);
    } catch {
      // The lock is already gone.
    }
  }
}
