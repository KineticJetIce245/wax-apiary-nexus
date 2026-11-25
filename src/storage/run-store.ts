import { readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { atomicWriteJson } from './atomic-write.js';

/**
 * A guarded wake is still one `trigger` run; guard decisions are part of that
 * wake, not a separate RunOperation. `answer` is the other operation.
 */
export type RunOperation = 'trigger' | 'answer';
export type RunStatus =
  | 'completed'
  | 'hovered'
  | 'incomplete'
  | 'failed'
  | 'cancelled'
  | 'unknown';

export interface RunOutput {
  readonly nodeId: string;
  readonly value: unknown;
}

/** One durable execution record. It never carries a prompt or native transcript. */
export interface RunRecord {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly requestId: string;
  readonly liveId: string;
  /** Trace whose Pheromones this run covers; absent on pre-M18 records. */
  readonly traceId?: string;
  readonly operation: RunOperation;
  readonly status: RunStatus;
  readonly outputs: readonly RunOutput[];
  readonly startedAt: string;
  readonly finishedAt?: string;
  /** Sanitized failure text; never a prompt, output or native payload. */
  readonly error?: string;
}

export class RunStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RunStoreError';
  }
}

export interface RunStoreOptions {
  /** Newest records retained; default 1000. */
  readonly maxRuns?: number;
  /** Maximum serialized record size; default 1 MiB. */
  readonly maxRecordBytes?: number;
}

const DEFAULT_MAX_RUNS = 1000;
const DEFAULT_MAX_RECORD_BYTES = 1024 * 1024;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Durable run records under a directory (`runs/<runId>.json` by convention).
 *
 * Each record is written atomically. The store enforces both a per-record byte
 * cap and a retained-run cap, deleting the oldest files when the cap is
 * exceeded. A malformed file is ignored by list/get rather than breaking the
 * control surface.
 */
export class RunStore {
  private readonly maxRuns: number;
  private readonly maxRecordBytes: number;

  constructor(
    readonly directory: string,
    options: RunStoreOptions = {},
  ) {
    if (typeof directory !== 'string' || directory.trim() === '') {
      throw new TypeError('RunStore directory must be a non-empty string');
    }
    this.maxRuns = positiveInteger(options.maxRuns ?? DEFAULT_MAX_RUNS, 'maxRuns');
    this.maxRecordBytes = positiveInteger(
      options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES,
      'maxRecordBytes',
    );
  }

  save(record: RunRecord): void {
    validateRecord(record);
    const serialized = JSON.stringify(record);
    if (Buffer.byteLength(serialized, 'utf8') > this.maxRecordBytes) {
      throw new RunStoreError(
        `Run '${record.runId}' exceeds the ${String(this.maxRecordBytes)}-byte record limit`,
      );
    }
    atomicWriteJson(join(this.directory, `${record.runId}.json`), record);
    this.prune();
  }

  get(runId: string): RunRecord | undefined {
    if (!RUN_ID_PATTERN.test(runId)) {
      return undefined;
    }
    try {
      return parseRecord(readFileSync(join(this.directory, `${runId}.json`), 'utf8'));
    } catch {
      return undefined;
    }
  }

  /** Newest records first; malformed files are skipped. */
  list(limit = 100): readonly RunRecord[] {
    if (!Number.isInteger(limit) || limit <= 0) {
      return [];
    }
    let names: string[];
    try {
      names = readdirSync(this.directory);
    } catch {
      return [];
    }
    const records: RunRecord[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) {
        continue;
      }
      const runId = name.slice(0, -'.json'.length);
      const record = this.get(runId);
      if (record !== undefined) {
        records.push(record);
      }
    }
    records.sort((left, right) => {
      const rightAt = right.finishedAt ?? right.startedAt;
      const leftAt = left.finishedAt ?? left.startedAt;
      return rightAt.localeCompare(leftAt);
    });
    return records.slice(0, limit);
  }

  latestForLive(liveId: string): RunRecord | undefined {
    return this.list(1000).find((record) => record.liveId === liveId);
  }

  private prune(): void {
    let names: string[];
    try {
      names = readdirSync(this.directory).filter((name) => name.endsWith('.json'));
    } catch {
      return;
    }
    if (names.length <= this.maxRuns) {
      return;
    }
    const withTimes = names.map((name) => {
      const path = join(this.directory, name);
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(path).mtimeMs;
      } catch {
        // A concurrent prune may have removed it.
      }
      return { path, mtimeMs };
    });
    withTimes.sort((left, right) => left.mtimeMs - right.mtimeMs);
    for (const entry of withTimes.slice(0, names.length - this.maxRuns)) {
      try {
        unlinkSync(entry.path);
      } catch {
        // Best effort: the next save retries the cap.
      }
    }
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

function validateRecord(record: RunRecord): void {
  if (!RUN_ID_PATTERN.test(record.runId)) {
    throw new RunStoreError('runId must be a safe file name');
  }
  if (typeof record.requestId !== 'string' || record.requestId === '') {
    throw new RunStoreError('requestId must be a non-empty string');
  }
  if (typeof record.liveId !== 'string' || record.liveId === '') {
    throw new RunStoreError('liveId must be a non-empty string');
  }
  if (record.schemaVersion !== 1) {
    throw new RunStoreError('unsupported run schemaVersion');
  }
  if (!Array.isArray(record.outputs)) {
    throw new RunStoreError('outputs must be an array');
  }
  if (typeof record.startedAt !== 'string' || !Number.isFinite(Date.parse(record.startedAt))) {
    throw new RunStoreError('startedAt must be a timestamp');
  }
  if (
    record.finishedAt !== undefined &&
    (typeof record.finishedAt !== 'string' || !Number.isFinite(Date.parse(record.finishedAt)))
  ) {
    throw new RunStoreError('finishedAt must be a timestamp');
  }
}

function parseRecord(raw: string): RunRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  if (
    record['schemaVersion'] !== 1 ||
    typeof record['runId'] !== 'string' ||
    typeof record['requestId'] !== 'string' ||
    typeof record['liveId'] !== 'string' ||
    typeof record['operation'] !== 'string' ||
    typeof record['status'] !== 'string' ||
    !Array.isArray(record['outputs']) ||
    typeof record['startedAt'] !== 'string'
  ) {
    return undefined;
  }
  try {
    validateRecord(record as unknown as RunRecord);
  } catch {
    return undefined;
  }
  return record as unknown as RunRecord;
}
