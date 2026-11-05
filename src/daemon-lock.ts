import { randomUUID } from 'node:crypto';
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

export class DaemonLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DaemonLockError';
  }
}

export interface DaemonLockInfo {
  pid: number;
  nonce: string;
  startedAt: string;
  compositionId: string;
}

/**
 * One-daemon-per-composition lock.
 *
 * The lock is created exclusively (`wx`) and carries the owner PID. A dead PID
 * means the lock is stale and may be replaced. Anything we cannot prove — an
 * unreadable lock, a malformed record, or a liveness probe that fails for a
 * reason other than "no such process" — refuses to start instead of stealing.
 */
export class DaemonLock {
  private released = false;

  private constructor(
    readonly path: string,
    readonly info: DaemonLockInfo,
  ) {}

  static acquire(path: string, compositionId: string): DaemonLock {
    mkdirSync(dirname(path), { recursive: true });
    const info: DaemonLockInfo = {
      pid: process.pid,
      nonce: randomUUID(),
      startedAt: new Date().toISOString(),
      compositionId,
    };

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const fd = openSync(path, 'wx');
        try {
          writeFileSync(fd, `${JSON.stringify(info)}\n`, { encoding: 'utf8', mode: 0o600 });
        } finally {
          closeSync(fd);
        }
        return new DaemonLock(path, info);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw new DaemonLockError(
            `cannot create daemon lock ${path}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      let existingText: string;
      try {
        existingText = readFileSync(path, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          continue;
        }
        throw new DaemonLockError(
          `cannot read daemon lock ${path}; refusing to steal it: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      const existing = parseLock(existingText, path);
      if (isProcessAlive(existing.pid)) {
        throw new DaemonLockError(
          `another daemon is already running for composition '${compositionId}' ` +
            `(pid ${String(existing.pid)}, lock ${path})`,
        );
      }

      // Re-read before removing so a lock that was replaced in the meantime is
      // not deleted. This narrows the race window; filesystem locks are not
      // available without a dependency.
      let currentText: string;
      try {
        currentText = readFileSync(path, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          continue;
        }
        throw new DaemonLockError(
          `cannot re-read stale daemon lock ${path}; refusing to steal it`,
        );
      }
      if (currentText !== existingText) {
        continue;
      }
      try {
        rmSync(path, { force: true });
      } catch (error) {
        throw new DaemonLockError(
          `cannot remove stale daemon lock ${path}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    throw new DaemonLockError(
      `daemon lock ${path} kept changing while stale locks were checked; refusing to steal it`,
    );
  }

  release(): void {
    if (this.released) {
      return;
    }
    this.released = true;

    let text: string;
    try {
      text = readFileSync(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw new DaemonLockError(
        `cannot read daemon lock ${this.path} while releasing it: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    let parsed: DaemonLockInfo | undefined;
    try {
      parsed = JSON.parse(text) as DaemonLockInfo;
    } catch {
      return;
    }
    if (parsed?.nonce !== this.info.nonce) {
      // Someone replaced the lock; never delete a lock we do not own.
      return;
    }
    rmSync(this.path, { force: true });
  }
}

/**
 * Reads a lock without acquiring, replacing or removing it.
 *
 * A missing lock returns `undefined`. Unreadable or malformed locks throw, so
 * an offline caller can refuse instead of treating uncertain state as stale.
 */
export function inspectDaemonLock(path: string): DaemonLockInfo | undefined {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw new DaemonLockError(
      `cannot read daemon lock ${path}; refusing to treat it as stale: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseLock(text, path);
}

function parseLock(text: string, path: string): DaemonLockInfo {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new DaemonLockError(`daemon lock ${path} is malformed; refusing to steal it`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new DaemonLockError(`daemon lock ${path} is malformed; refusing to steal it`);
  }
  const record = parsed as Record<string, unknown>;
  const pid = record['pid'];
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    throw new DaemonLockError(
      `daemon lock ${path} has no usable pid; refusing to steal it`,
    );
  }
  return {
    pid,
    nonce: typeof record['nonce'] === 'string' ? record['nonce'] : '',
    startedAt: typeof record['startedAt'] === 'string' ? record['startedAt'] : '',
    compositionId: typeof record['compositionId'] === 'string' ? record['compositionId'] : '',
  };
}

/**
 * PID liveness probe. `EPERM` means the process exists but we may not signal it;
 * any other failure is uncertain and must not be treated as stale.
 */
export function isProcessAlive(pid: number): boolean {
  if (pid === process.pid) {
    return true;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') {
      return false;
    }
    if (code === 'EPERM') {
      return true;
    }
    throw new DaemonLockError(
      `cannot determine whether pid ${String(pid)} is alive; refusing to steal its lock: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
