import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { hostname, homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Append-only factual log for delegation work items. The log is the single
 * source of truth: state views are folded from it, never stored separately.
 * One writer owns a state directory at a time, enforced by `writer.lock`.
 */
export type LedgerEntryType =
  | 'work-item/created'
  | 'delivery/intent'
  | 'delivery/submitted'
  | 'delivery/settled'
  | 'gate/rejected';

export interface LedgerEntry {
  readonly seq: number;
  readonly writer: string;
  readonly at: string;
  readonly type: LedgerEntryType;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface LedgerReadResult {
  readonly entries: readonly LedgerEntry[];
  /** The file ends mid-record; the bytes are left untouched. */
  readonly tornTail: boolean;
  /**
   * True when the torn tail is a complete record that only lost its newline, so
   * a new record can safely start on the next line. False means the fragment
   * cannot be terminated without inventing facts; appends are refused.
   */
  readonly tornTailAppendable: boolean;
}

export class LedgerLockedError extends Error {
  constructor(
    readonly pid: number,
    detail?: string,
  ) {
    super(
      `Delegation ledger is locked by another writer (pid ${String(pid)})` +
        (detail === undefined ? '' : `: ${detail}`),
    );
    this.name = 'LedgerLockedError';
  }
}

export class LedgerLockStaleError extends Error {
  constructor(
    readonly pid: number,
    readonly lockPath: string,
  ) {
    super(
      `Delegation ledger has a stale writer lock (pid ${String(pid)}) at ${lockPath}; ` +
        'confirm the previous process is gone, then reopen with allowStaleLock',
    );
    this.name = 'LedgerLockStaleError';
  }
}

export class LedgerCorruptError extends Error {
  constructor(readonly line: number, message: string) {
    super(`Delegation ledger is corrupt at line ${String(line)}: ${message}`);
    this.name = 'LedgerCorruptError';
  }
}

export class LedgerClosedError extends Error {
  constructor() {
    super('Delegation ledger is closed');
    this.name = 'LedgerClosedError';
  }
}

export class LedgerTornTailError extends Error {
  constructor() {
    super(
      'Delegation ledger ends with an incomplete record; refusing to append until the fragment is repaired by hand',
    );
    this.name = 'LedgerTornTailError';
  }
}

const ENTRY_TYPES = new Set<LedgerEntryType>([
  'work-item/created',
  'delivery/intent',
  'delivery/submitted',
  'delivery/settled',
  'gate/rejected',
]);

export class DelegationLedger {
  private closed = false;

  private constructor(
    private readonly directory: string,
    private readonly lockPath: string,
    private readonly ledgerPath: string,
    private readonly writerId: string,
    private fd: number,
    private nextSeq: number,
    private tornTail: boolean,
    private tornTailAppendable: boolean,
  ) {}

  static open(options: { readonly directory: string; readonly allowStaleLock?: boolean }): DelegationLedger {
    const directory = options.directory;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const writerId = randomUUID();
    const lockPath = acquireLock(directory, writerId, options.allowStaleLock === true);
    const ledgerPath = join(directory, 'ledger.jsonl');
    let read: LedgerReadResult;
    try {
      read = readLedgerFile(ledgerPath);
    } catch (error) {
      rmSync(lockPath, { force: true });
      throw error;
    }
    let fd: number;
    try {
      fd = openSync(ledgerPath, 'a', 0o600);
    } catch (error) {
      // Do not leak the writer lock when the ledger file cannot be opened.
      rmSync(lockPath, { force: true });
      throw error;
    }
    return new DelegationLedger(
      directory,
      lockPath,
      ledgerPath,
      writerId,
      fd,
      read.entries.length + 1,
      read.tornTail,
      read.tornTailAppendable,
    );
  }

  get stateDirectory(): string {
    return this.directory;
  }

  get filePath(): string {
    return this.ledgerPath;
  }

  get id(): string {
    return this.writerId;
  }

  get hasTornTail(): boolean {
    return this.tornTail;
  }

  get tornTailBlocksAppend(): boolean {
    return this.tornTail && !this.tornTailAppendable;
  }

  readAll(): LedgerReadResult {
    return readLedgerFile(this.ledgerPath);
  }

  /**
   * Re-read the file after an external repair. Updates the cached tail state
   * and the next sequence number; the writer lock is unaffected.
   *
   * The file may have been replaced rather than truncated in place (write a
   * temporary file, then rename it over the ledger). An append descriptor
   * would keep writing to the unlinked inode, so reopen the current path
   * before accepting new records. A failure here leaves the caller degraded
   * and the old descriptor untouched.
   */
  refresh(): LedgerReadResult {
    const read = readLedgerFile(this.ledgerPath);
    const nextFd = openSync(this.ledgerPath, 'a', 0o600);
    const previousFd = this.fd;
    this.fd = nextFd;
    this.tornTail = read.tornTail;
    this.tornTailAppendable = read.tornTailAppendable;
    this.nextSeq = read.entries.length + 1;
    try {
      closeSync(previousFd);
    } catch {
      // The old descriptor may already be gone; the new one is what matters.
    }
    return read;
  }

  append(type: LedgerEntryType, data: Readonly<Record<string, unknown>>): LedgerEntry {
    if (this.closed) {
      throw new LedgerClosedError();
    }
    if (this.tornTail && !this.tornTailAppendable) {
      throw new LedgerTornTailError();
    }
    const entry: LedgerEntry = {
      seq: this.nextSeq,
      writer: this.writerId,
      at: new Date().toISOString(),
      type,
      data,
    };
    // A repairable torn tail is a complete record that lost its newline; start
    // the next record on a new line instead of merging into that fragment.
    const prefix = this.tornTail ? '\n' : '';
    writeSync(this.fd, Buffer.from(`${prefix}${JSON.stringify(entry)}\n`, 'utf8'));
    fsyncSync(this.fd);
    this.nextSeq += 1;
    this.tornTail = false;
    this.tornTailAppendable = true;
    return entry;
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      fsyncSync(this.fd);
    } catch {
      // The descriptor may already be unusable; closing still releases the lock.
    }
    try {
      closeSync(this.fd);
    } catch {
      // Ignore double-close races during shutdown.
    }
    // Only release the lock we still own: another writer may have taken over
    // after a stale-lock recovery, and deleting its lock would let a third
    // process write concurrently.
    const lock = readLockInfo(this.lockPath);
    if (lock !== undefined && lock.writer === this.writerId) {
      rmSync(this.lockPath, { force: true });
    }
  }
}

/** Replay the ledger. A complete-but-unterminated last line is accepted. */
export function readLedgerFile(path: string): LedgerReadResult {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { entries: [], tornTail: false, tornTailAppendable: true };
    }
    throw error;
  }
  if (text === '') {
    return { entries: [], tornTail: false, tornTailAppendable: true };
  }
  const terminated = text.endsWith('\n');
  const lines = text.split('\n');
  if (terminated) {
    lines.pop();
  }
  const entries: LedgerEntry[] = [];
  let tornTail = false;
  let tornTailAppendable = true;
  const lastIndex = lines.length - 1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const isLast = index === lastIndex;
    if (!terminated && isLast) {
      tornTail = true;
      if (line.trim() === '') {
        tornTailAppendable = false;
        break;
      }
      const fragment = tryParseEntry(line);
      if (fragment === undefined) {
        tornTailAppendable = false;
        break;
      }
      entries.push(fragment);
      break;
    }
    if (line.trim() === '') {
      throw new LedgerCorruptError(lineNumber(index), 'blank line');
    }
    entries.push(parseEntry(line, lineNumber(index)));
  }
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry !== undefined && entry.seq !== index + 1) {
      throw new LedgerCorruptError(lineNumber(index), `expected seq ${String(index + 1)}, found ${String(entry.seq)}`);
    }
  }
  return { entries, tornTail, tornTailAppendable };
}

function parseEntry(line: string, lineNo: number): LedgerEntry {
  const entry = tryParseEntry(line);
  if (entry === undefined) {
    throw new LedgerCorruptError(lineNo, 'invalid entry record');
  }
  return entry;
}

function tryParseEntry(line: string): LedgerEntry | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const seq = record.seq;
  const writer = record.writer;
  const at = record.at;
  const type = record.type;
  const data = record.data;
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 1) {
    return undefined;
  }
  if (typeof writer !== 'string' || writer.length === 0) {
    return undefined;
  }
  if (typeof at !== 'string' || at.length === 0) {
    return undefined;
  }
  if (typeof type !== 'string' || !ENTRY_TYPES.has(type as LedgerEntryType)) {
    return undefined;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return undefined;
  }
  return { seq, writer, at, type: type as LedgerEntryType, data: data as Record<string, unknown> };
}

function lineNumber(index: number): number {
  return index + 1;
}

/**
 * Default state root for a project. Project ids are user input, so they never
 * reach the path verbatim unless they match a strict whitelist.
 */
export function defaultDelegationStateDirectory(
  projectId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.WAX_STATE_DIR?.trim();
  const base = override !== undefined && override !== '' ? override : join(homedir(), '.wax');
  return join(base, sanitizeSegment(projectId));
}

function sanitizeSegment(id: string): string {
  if (/^[A-Za-z0-9._-]{1,64}$/.test(id) && id !== '.' && id !== '..') {
    return id;
  }
  const digest = createHash('sha256').update(id).digest('hex').slice(0, 16);
  return `id-${digest}`;
}

function acquireLock(directory: string, writerId: string, allowStaleLock: boolean): string {
  const lockPath = join(directory, 'writer.lock');
  const payload = JSON.stringify({
    pid: process.pid,
    writer: writerId,
    startedAt: new Date().toISOString(),
    host: hostname(),
    version: 1,
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(lockPath, payload, { flag: 'wx', mode: 0o600 });
      return lockPath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
      const info = readLockInfo(lockPath);
      // A lock from another host cannot be probed; treat it as owned.
      if (info?.host !== undefined && info.host !== hostname()) {
        throw new LedgerLockedError(info.pid ?? -1, `lock owner host is ${info.host}`);
      }
      if (info?.pid !== undefined && isProcessAlive(info.pid)) {
        throw new LedgerLockedError(info.pid);
      }
      if (!allowStaleLock) {
        throw new LedgerLockStaleError(info?.pid ?? -1, lockPath);
      }
      // Bounded race: another process may win between the removal and the
      // retry; the retry then observes its lock and reports it.
      rmSync(lockPath, { force: true });
    }
  }
  throw new Error(`Cannot acquire the delegation ledger lock at ${lockPath}`);
}

interface LockInfo {
  readonly pid: number | undefined;
  readonly host: string | undefined;
  readonly writer: string | undefined;
}

function readLockInfo(lockPath: string): LockInfo | undefined {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8')) as Record<string, unknown>;
    return {
      pid: typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) ? parsed.pid : undefined,
      host: typeof parsed.host === 'string' ? parsed.host : undefined,
      writer: typeof parsed.writer === 'string' ? parsed.writer : undefined,
    };
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
