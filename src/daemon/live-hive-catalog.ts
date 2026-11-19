import { readFileSync } from 'node:fs';

import { atomicWriteJson } from '../storage/atomic-write.js';

export type LiveHiveCatalogState = 'loaded' | 'unloaded';
export type LiveHiveUnloadReason = 'unload' | 'sweep' | 'dispose';

/** Identity and lifecycle metadata for one LiveHive. It never carries a body. */
export interface LiveHiveCatalogEntry {
  readonly liveId: string;
  readonly state: LiveHiveCatalogState;
  readonly loadedAt?: string;
  readonly lastAccessAt?: string;
  readonly lastUnloadReason?: LiveHiveUnloadReason;
}

export interface LiveHiveCatalogOptions {
  /** ISO timestamp source; tests inject a fixed clock. */
  readonly now?: () => string;
}

/** The catalog file is unreadable, corrupt, or not the supported schema. */
export class LiveHiveCatalogError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'LiveHiveCatalogError';
  }
}

const SCHEMA_VERSION = 1;

interface StoredCatalog {
  readonly schemaVersion: number;
  readonly entries: readonly LiveHiveCatalogEntry[];
}

/**
 * Durable identity/state index for LiveHives. It stores only `liveId`, state
 * and timestamps: no definition, session, prompt or output.
 *
 * Mark methods update memory and do not write. `save()` persists the whole
 * catalog atomically; the caller decides whether a failed save changes an
 * operation result. `loadFromDisk()` is called by the constructor so a corrupt
 * file fails before a daemon writes a token or lock.
 */
export class LiveHiveCatalog {
  private readonly filePath: string;
  private readonly now: () => string;
  private readonly entries = new Map<string, LiveHiveCatalogEntry>();

  constructor(filePath: string, options: LiveHiveCatalogOptions = {}) {
    if (typeof filePath !== 'string' || filePath.trim() === '') {
      throw new TypeError('filePath must be a non-empty string');
    }
    this.filePath = filePath;
    this.now = options.now ?? (() => new Date().toISOString());
    if (typeof this.now !== 'function') {
      throw new TypeError('now must be a function');
    }
    this.loadFromDisk();
  }

  /** Read the catalog from disk, replacing memory. A missing file is empty. */
  loadFromDisk(): void {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.entries.clear();
        return;
      }
      throw new LiveHiveCatalogError('Failed to read live-hive catalog', { cause: error });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (error) {
      throw new LiveHiveCatalogError('Live-hive catalog is not valid JSON', { cause: error });
    }

    const stored = parseCatalog(parsed);
    this.entries.clear();
    for (const entry of stored) {
      this.entries.set(entry.liveId, entry);
    }
  }

  /** Snapshot of every entry, in file/insertion order. */
  list(): readonly LiveHiveCatalogEntry[] {
    return [...this.entries.values()].map((entry) => copyEntry(entry));
  }

  get(liveId: string): LiveHiveCatalogEntry | undefined {
    const entry = this.entries.get(liveId);
    return entry === undefined ? undefined : copyEntry(entry);
  }

  /** Mark a successful load. An existing entry is reused and refreshed. */
  markLoaded(liveId: string): void {
    const now = this.now();
    this.entries.set(liveId, {
      liveId,
      state: 'loaded',
      loadedAt: now,
      lastAccessAt: now,
    });
  }

  /** Mark an unload; the entry is retained with the reason that ended it. */
  markUnloaded(liveId: string, reason: LiveHiveUnloadReason): void {
    const previous = this.entries.get(liveId);
    const now = this.now();
    this.entries.set(liveId, {
      liveId,
      state: 'unloaded',
      ...(previous?.loadedAt === undefined ? {} : { loadedAt: previous.loadedAt }),
      lastAccessAt: now,
      lastUnloadReason: reason,
    });
  }

  /** Refresh access time. An unknown live id is a no-op. */
  markAccessed(liveId: string): void {
    const previous = this.entries.get(liveId);
    if (previous === undefined) {
      return;
    }
    this.entries.set(liveId, { ...previous, lastAccessAt: this.now() });
  }

  /**
   * Reconcile a catalog read by a new daemon process: no live graph can be
   * loaded in this process yet, so every persisted `loaded` entry belongs to
   * the previous daemon and is stale. The recorded identity is kept; only the
   * phantom loaded state is cleared. Returns the number of entries changed.
   */
  recoverLoadedEntries(): number {
    let changed = 0;
    for (const entry of this.list()) {
      if (entry.state !== 'loaded') {
        continue;
      }
      const now = this.now();
      this.entries.set(entry.liveId, {
        liveId: entry.liveId,
        state: 'unloaded',
        ...(entry.loadedAt === undefined ? {} : { loadedAt: entry.loadedAt }),
        lastAccessAt: now,
      });
      changed += 1;
    }
    if (changed > 0) {
      this.save();
    }
    return changed;
  }

  /** Persist the whole catalog with the shared atomic-write path. */
  save(): void {
    const value: StoredCatalog = {
      schemaVersion: SCHEMA_VERSION,
      entries: this.list(),
    };
    atomicWriteJson(this.filePath, value);
  }
}

function copyEntry(entry: LiveHiveCatalogEntry): LiveHiveCatalogEntry {
  return {
    liveId: entry.liveId,
    state: entry.state,
    ...(entry.loadedAt === undefined ? {} : { loadedAt: entry.loadedAt }),
    ...(entry.lastAccessAt === undefined ? {} : { lastAccessAt: entry.lastAccessAt }),
    ...(entry.lastUnloadReason === undefined
      ? {}
      : { lastUnloadReason: entry.lastUnloadReason }),
  };
}

function parseCatalog(value: unknown): readonly LiveHiveCatalogEntry[] {
  if (!isRecord(value) || value['schemaVersion'] !== SCHEMA_VERSION) {
    throw new LiveHiveCatalogError('Unsupported live-hive catalog schema');
  }
  const rawEntries = value['entries'];
  if (!Array.isArray(rawEntries)) {
    throw new LiveHiveCatalogError('Live-hive catalog entries must be an array');
  }

  const entries: LiveHiveCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const raw of rawEntries) {
    const entry = parseEntry(raw);
    if (seen.has(entry.liveId)) {
      throw new LiveHiveCatalogError(`Duplicate live-hive catalog id: ${entry.liveId}`);
    }
    seen.add(entry.liveId);
    entries.push(entry);
  }
  return entries;
}

function parseEntry(value: unknown): LiveHiveCatalogEntry {
  if (!isRecord(value)) {
    throw new LiveHiveCatalogError('Live-hive catalog entry must be an object');
  }
  const liveId = value['liveId'];
  if (typeof liveId !== 'string' || liveId.trim() === '') {
    throw new LiveHiveCatalogError('Live-hive catalog entry requires a non-empty liveId');
  }
  const state = value['state'];
  if (state !== 'loaded' && state !== 'unloaded') {
    throw new LiveHiveCatalogError(`Invalid live-hive catalog state for '${liveId}'`);
  }
  const loadedAt = optionalString(value, 'loadedAt', liveId);
  const lastAccessAt = optionalString(value, 'lastAccessAt', liveId);
  const rawReason = value['lastUnloadReason'];
  if (
    rawReason !== undefined &&
    rawReason !== 'unload' &&
    rawReason !== 'sweep' &&
    rawReason !== 'dispose'
  ) {
    throw new LiveHiveCatalogError(`Invalid unload reason for '${liveId}'`);
  }
  return {
    liveId,
    state,
    ...(loadedAt === undefined ? {} : { loadedAt }),
    ...(lastAccessAt === undefined ? {} : { lastAccessAt }),
    ...(rawReason === undefined ? {} : { lastUnloadReason: rawReason }),
  };
}

function optionalString(
  record: Record<string, unknown>,
  field: string,
  liveId: string,
): string | undefined {
  const value = record[field];
  if (value !== undefined && typeof value !== 'string') {
    throw new LiveHiveCatalogError(`Invalid ${field} for live hive '${liveId}'`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
