import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';

import { assertValueShape } from './honey.js';
import type { NodeId, Value } from './runtime/index.js';

/**
 * One answer queued by `wax answer` for the daemon.
 *
 * The record carries the answer Value itself, which is input, and deliberately
 * no prompt or output body. The daemon is the only writer of Honey state; this
 * file is a transport artifact until the daemon applies it and deletes it.
 */
export interface AnswerRecord {
  readonly answerId: string;
  readonly compositionId: string;
  readonly nodeId: NodeId;
  readonly hoverToken: string;
  readonly value: Value;
  readonly at: string;
}

const ANSWER_FILE_SUFFIX = '.json';
const SAFE_ANSWER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${path}: expected a non-empty string`);
  }
  return value;
}

/**
 * Creates the answer inbox with owner-only permissions. The daemon calls this
 * at startup; the answer CLI calls it before writing so a missing directory is
 * never a race.
 */
export function ensureAnswerInbox(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
}

export function createAnswerId(): string {
  return `ans_${randomUUID()}`;
}

/**
 * Writes one answer record through a same-directory temp file plus rename. A
 * reader never observes a partially written record.
 */
export function writeAnswerRecord(directory: string, record: AnswerRecord): string {
  if (!SAFE_ANSWER_ID.test(record.answerId)) {
    throw new Error(`invalid answer id: '${record.answerId}'`);
  }
  ensureAnswerInbox(directory);
  const path = join(directory, `${record.answerId}${ANSWER_FILE_SUFFIX}`);
  const temp = join(
    directory,
    `.${record.answerId}.tmp-${String(process.pid)}-${randomUUID()}`,
  );

  try {
    writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    // Same-directory rename is atomic on both NTFS and POSIX filesystems.
    renameSync(temp, path);
  } catch (error) {
    try {
      rmSync(temp, { force: true });
    } catch {
      // Preserve the original write/rename error; a leftover temp file is
      // ignored by the scanner and never becomes an answer.
    }
    throw error;
  }
  return path;
}

/** Answer files in deterministic name order; temp files are ignored. */
export function listAnswerFiles(directory: string): string[] {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(ANSWER_FILE_SUFFIX))
    .map((entry) => join(directory, entry.name))
    .sort();
}

export function readAnswerRecord(path: string): AnswerRecord {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(
      `cannot read answer file '${basename(path)}': ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `answer file '${basename(path)}' is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return parseAnswerRecord(parsed);
}

export function parseAnswerRecord(input: unknown): AnswerRecord {
  if (!isRecord(input)) {
    throw new Error('answer record: expected an object');
  }

  const answerId = nonEmptyString(input['answerId'], 'answer.answerId');
  const compositionId = nonEmptyString(input['compositionId'], 'answer.compositionId');
  const nodeId = nonEmptyString(input['nodeId'], 'answer.nodeId');
  const hoverToken = nonEmptyString(input['hoverToken'], 'answer.hoverToken');
  const at = nonEmptyString(input['at'], 'answer.at');
  if (!Number.isFinite(Date.parse(at))) {
    throw new Error('answer.at: expected an ISO timestamp');
  }

  assertValueShape(input['value'], 'answer.value');

  return {
    answerId,
    compositionId,
    nodeId,
    hoverToken,
    value: input['value'],
    at,
  };
}

export function removeAnswerFile(path: string): void {
  rmSync(path, { force: true });
}
