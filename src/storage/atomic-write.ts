import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';

/**
 * Minimal file abstraction for an atomic JSON write. The default backend is
 * Node's synchronous `fs`; tests inject a backend that fails at a chosen step.
 *
 * A write is considered committed after `rename(from, to)` succeeds. The
 * directory fsync is best effort: it improves crash durability on POSIX, but
 * some filesystems (notably Windows) do not support it, and a failure after
 * the rename must not turn a committed target into a reported failure.
 */
export interface AtomicWriteFile {
  write(data: string): void;
  sync(): void;
  close(): void;
}

export interface AtomicWriteBackend {
  mkdirp(dir: string): void;
  create(path: string, mode: number): AtomicWriteFile;
  rename(from: string, to: string): void;
  remove(path: string): void;
  fsyncDirectory(dir: string): void;
}

class NodeAtomicWriteFile implements AtomicWriteFile {
  constructor(private readonly fd: number) {}

  write(data: string): void {
    const buffer = Buffer.from(data, 'utf8');
    let offset = 0;
    while (offset < buffer.length) {
      const written = writeSync(this.fd, buffer, offset, buffer.length - offset);
      if (written <= 0) {
        throw new Error('atomic write: writeSync made no progress');
      }
      offset += written;
    }
  }

  sync(): void {
    fsyncSync(this.fd);
  }

  close(): void {
    closeSync(this.fd);
  }
}

function fsyncDirectoryBestEffort(dir: string): void {
  // Node cannot open a directory for fsync on Windows. The file fsync plus the
  // same-directory rename still prevent readers from seeing a partial JSON
  // document; directory fsync is an additional POSIX crash-durability measure.
  if (process.platform === 'win32') {
    return;
  }
  let fd: number | undefined;
  try {
    fd = openSync(dir, 'r');
    fsyncSync(fd);
  } catch {
    // Best effort only: unsupported filesystems and permission models must not
    // turn an already-renamed target into a reported failure.
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // The rename already committed; a close failure cannot change that.
      }
    }
  }
}

export const nodeAtomicWriteBackend: AtomicWriteBackend = {
  mkdirp(dir: string): void {
    mkdirSync(dir, { recursive: true });
  },
  create(path: string, mode: number): AtomicWriteFile {
    return new NodeAtomicWriteFile(openSync(path, 'w', mode));
  },
  rename(from: string, to: string): void {
    renameSync(from, to);
  },
  remove(path: string): void {
    rmSync(path, { force: true });
  },
  fsyncDirectory(dir: string): void {
    fsyncDirectoryBestEffort(dir);
  },
};

/**
 * Write `value` as pretty JSON to `path` without exposing a partial file.
 *
 * Order: mkdir -> create unique temp in the same directory -> write -> fsync
 * temp -> close -> rename over the target -> best-effort directory fsync.
 * Any failure before the rename removes the temp file and leaves the previous
 * target untouched. A failure after the rename is not reported as a failed
 * write because the target is already committed.
 */
export function atomicWriteJson(
  path: string,
  value: unknown,
  backend: AtomicWriteBackend = nodeAtomicWriteBackend,
): void {
  const dir = dirname(path);
  backend.mkdirp(dir);
  const temp = `${path}.tmp-${String(process.pid)}-${randomUUID()}`;
  let file: AtomicWriteFile | undefined;
  try {
    file = backend.create(temp, 0o600);
    file.write(`${JSON.stringify(value, null, 2)}\n`);
    file.sync();
    file.close();
    file = undefined;
    backend.rename(temp, path);
  } catch (error) {
    if (file !== undefined) {
      try {
        file.close();
      } catch {
        // The original write error is the useful failure.
      }
    }
    try {
      backend.remove(temp);
    } catch {
      // Best effort cleanup; the target was not replaced before the rename.
    }
    throw error;
  }

  try {
    backend.fsyncDirectory(dir);
  } catch {
    // Best effort only; the rename already committed the new content.
  }
}
