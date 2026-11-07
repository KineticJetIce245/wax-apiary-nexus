import { readFileSync } from 'node:fs';

import { atomicWriteJson } from '../storage/atomic-write.js';

/**
 * One resolved `fresh_once` binding: which WAX session a `(graphId, nodeId)`
 * pair currently reuses. `updatedAt` is store metadata, never a prompt or
 * conversation body.
 */
export interface ResolvedGraphBinding {
  readonly graphId: string;
  readonly nodeId: string;
  readonly sessionId: string;
  readonly harness: string;
  readonly projectId: string;
  readonly updatedAt: string;
}

export interface GraphBindingStoreOptions {
  /** ISO timestamp source; defaults to `new Date().toISOString()`. */
  readonly now?: () => string;
}

/** The store file is unreadable, corrupt, or not the supported schema. */
export class GraphBindingStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'GraphBindingStoreError';
  }
}

const SCHEMA_VERSION = 1;

/** graphId -> nodeId -> resolved binding. */
type BindingIndex = Map<string, Map<string, ResolvedGraphBinding>>;

interface StoredBinding {
  readonly sessionId: string;
  readonly harness: string;
  readonly projectId: string;
  readonly updatedAt: string;
}

/**
 * Durable `(graphId, nodeId) -> sessionId` mappings for `fresh_once`.
 *
 * The store is synchronous and atomic: every set/remove rewrites the whole
 * document through `atomicWriteJson`, so a reader never sees a partial file and
 * a failed write leaves the previous file untouched. The daemon directory is
 * already single-writer guarded by the daemon lock, so no extra cross-process
 * lock is needed; all methods are synchronous and therefore serialized within
 * one process.
 *
 * `graphId` and `nodeId` are only used as JSON keys, never joined into a path.
 * Construction reads and validates the file; a corrupt or unsupported store is
 * an error rather than an empty store, so callers cannot silently lose reuse.
 */
export class GraphBindingStore {
  private readonly filePath: string;
  private readonly now: () => string;
  private bindings: BindingIndex;

  constructor(filePath: string, options: GraphBindingStoreOptions = {}) {
    if (typeof filePath !== 'string' || filePath === '') {
      throw new TypeError('filePath must be a non-empty string');
    }
    this.filePath = filePath;
    this.now = options.now ?? (() => new Date().toISOString());
    if (typeof this.now !== 'function') {
      throw new TypeError('now must be a function');
    }
    this.bindings = readBindings(filePath);
  }

  /** A copy of the resolved binding, or `undefined` when none is stored. */
  get(graphId: string, nodeId: string): ResolvedGraphBinding | undefined {
    const record = this.bindings.get(graphId)?.get(nodeId);
    return record === undefined ? undefined : copyBinding(record);
  }

  /**
   * Store a binding and rewrite the file atomically. `updatedAt` is stamped
   * from the injected clock; the caller's value is ignored so every write has
   * one timestamp source.
   */
  set(binding: ResolvedGraphBinding): void {
    const record: ResolvedGraphBinding = {
      graphId: binding.graphId,
      nodeId: binding.nodeId,
      sessionId: binding.sessionId,
      harness: binding.harness,
      projectId: binding.projectId,
      updatedAt: this.now(),
    };
    const next = cloneIndex(this.bindings);
    let nodes = next.get(record.graphId);
    if (nodes === undefined) {
      nodes = new Map<string, ResolvedGraphBinding>();
      next.set(record.graphId, nodes);
    }
    nodes.set(record.nodeId, record);
    this.commit(next);
  }

  /** Remove one binding. A missing key is a no-op and does not rewrite. */
  remove(graphId: string, nodeId: string): void {
    const nodes = this.bindings.get(graphId);
    if (nodes === undefined || !nodes.has(nodeId)) {
      return;
    }
    const next = cloneIndex(this.bindings);
    const nextNodes = next.get(graphId);
    nextNodes?.delete(nodeId);
    if (nextNodes !== undefined && nextNodes.size === 0) {
      next.delete(graphId);
    }
    this.commit(next);
  }

  /** Remove every binding that points at `sessionId`; return the count removed. */
  removeForSession(sessionId: string): number {
    let removed = 0;
    const next: BindingIndex = new Map();
    for (const [graphId, nodes] of this.bindings) {
      const kept = new Map<string, ResolvedGraphBinding>();
      for (const [nodeId, record] of nodes) {
        if (record.sessionId === sessionId) {
          removed += 1;
          continue;
        }
        kept.set(nodeId, record);
      }
      if (kept.size > 0) {
        next.set(graphId, kept);
      }
    }
    if (removed === 0) {
      return 0;
    }
    this.commit(next);
    return removed;
  }

  /** A stable copy of every binding; mutating it cannot change the store. */
  snapshot(): readonly ResolvedGraphBinding[] {
    const entries: ResolvedGraphBinding[] = [];
    for (const nodes of this.bindings.values()) {
      for (const record of nodes.values()) {
        entries.push(copyBinding(record));
      }
    }
    return entries;
  }

  /** Write first, then publish in memory; a failed write changes nothing. */
  private commit(next: BindingIndex): void {
    try {
      atomicWriteJson(this.filePath, serializeIndex(next));
    } catch (error) {
      throw new GraphBindingStoreError(
        `Failed to write graph binding store: ${this.filePath} (${messageOf(error)})`,
        { cause: error },
      );
    }
    this.bindings = next;
  }
}

function readBindings(filePath: string): BindingIndex {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return new Map();
    }
    throw new GraphBindingStoreError(
      `Failed to read graph binding store: ${filePath} (${messageOf(error)})`,
      { cause: error },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new GraphBindingStoreError(
      `Graph binding store is not valid JSON: ${filePath} (${messageOf(error)})`,
      { cause: error },
    );
  }
  return parseIndex(parsed, filePath);
}

function parseIndex(input: unknown, filePath: string): BindingIndex {
  if (!isRecord(input)) {
    throw new GraphBindingStoreError(
      `Graph binding store: ${filePath}: expected a JSON object`,
    );
  }
  const schemaVersion = input['schemaVersion'];
  if (schemaVersion !== SCHEMA_VERSION) {
    throw new GraphBindingStoreError(
      `Graph binding store: ${filePath}: unsupported schemaVersion ${String(schemaVersion)}`,
    );
  }
  const rawBindings = input['bindings'];
  if (!isRecord(rawBindings)) {
    throw new GraphBindingStoreError(
      `Graph binding store: ${filePath}.bindings: expected an object`,
    );
  }

  const index: BindingIndex = new Map();
  for (const [graphId, rawNodes] of Object.entries(rawBindings)) {
    if (!isRecord(rawNodes)) {
      throw new GraphBindingStoreError(
        `Graph binding store: ${filePath}.bindings[${graphId}]: expected an object`,
      );
    }
    const nodes = new Map<string, ResolvedGraphBinding>();
    for (const [nodeId, rawRecord] of Object.entries(rawNodes)) {
      nodes.set(
        nodeId,
        parseBinding(rawRecord, graphId, nodeId, `${filePath}.bindings[${graphId}][${nodeId}]`),
      );
    }
    index.set(graphId, nodes);
  }
  return index;
}

function parseBinding(
  input: unknown,
  graphId: string,
  nodeId: string,
  path: string,
): ResolvedGraphBinding {
  if (!isRecord(input)) {
    throw new GraphBindingStoreError(`Graph binding store: ${path}: expected an object`);
  }
  return {
    graphId,
    nodeId,
    sessionId: requireString(input, 'sessionId', path),
    harness: requireString(input, 'harness', path),
    projectId: requireString(input, 'projectId', path),
    updatedAt: requireString(input, 'updatedAt', path),
  };
}

function requireString(
  record: Record<string, unknown>,
  field: string,
  path: string,
): string {
  const value = record[field];
  if (typeof value !== 'string' || value === '') {
    throw new GraphBindingStoreError(
      `Graph binding store: ${path}.${field}: expected a non-empty string`,
    );
  }
  return value;
}

function serializeIndex(index: BindingIndex): {
  readonly schemaVersion: number;
  readonly bindings: Record<string, Record<string, StoredBinding>>;
} {
  // Object.fromEntries defines own data properties, so a node id such as
  // `__proto__` cannot mutate the document prototype.
  return {
    schemaVersion: SCHEMA_VERSION,
    bindings: Object.fromEntries(
      [...index].map(([graphId, nodes]) => [
        graphId,
        Object.fromEntries(
          [...nodes].map(([nodeId, record]) => [
            nodeId,
            {
              sessionId: record.sessionId,
              harness: record.harness,
              projectId: record.projectId,
              updatedAt: record.updatedAt,
            } satisfies StoredBinding,
          ]),
        ),
      ]),
    ),
  };
}

function cloneIndex(index: BindingIndex): BindingIndex {
  const next: BindingIndex = new Map();
  for (const [graphId, nodes] of index) {
    next.set(graphId, new Map(nodes));
  }
  return next;
}

function copyBinding(record: ResolvedGraphBinding): ResolvedGraphBinding {
  return {
    graphId: record.graphId,
    nodeId: record.nodeId,
    sessionId: record.sessionId,
    harness: record.harness,
    projectId: record.projectId,
    updatedAt: record.updatedAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
