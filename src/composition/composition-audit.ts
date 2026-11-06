import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { CliUsageError, messageOf } from '../cli/cli-shared.js';
import {
  compositionAuditPath,
  DEFAULT_COMPOSITION_STATE_DIR,
} from './composition-edit.js';
import { CompositionValidationError, parseComposition } from '../runtime/index.js';

/** Stage 4C reads at most the 1000 newest matching audit lines. */
export const DEFAULT_REVISION_LIMIT = 50;
export const MAX_REVISION_LIMIT = 1000;

const AUDIT_FIELDS = [
  'at',
  'compositionId',
  'oldRevision',
  'newRevision',
  'file',
  'mode',
] as const;

/**
 * One metadata-only revision audit record. The audit writer never stores a
 * composition body, and the reader whitelists these six fields so an unexpected
 * field in a hand-edited audit file can never leak into command output.
 */
export interface CompositionRevisionEntry {
  readonly at: string;
  readonly compositionId: string;
  readonly oldRevision: string;
  readonly newRevision: string;
  readonly file: string;
  readonly mode: string;
}

/** A revision audit line is not JSON or not an audit record. */
export class CompositionAuditParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompositionAuditParseError';
  }
}

/** Reading the revision audit or scanning recovery candidates failed. */
export class CompositionAuditIoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompositionAuditIoError';
  }
}

export interface ReadCompositionRevisionsOptions {
  /** Defaults to `~/.wax`, the same root as `wax run` and `wax composition replace`. */
  readonly stateDir?: string;
  /** Exact composition id filter; omitted means every composition. */
  readonly compositionId?: string;
  /** 1..1000, default 50. The newest matching entries are returned. */
  readonly limit?: number;
}

/**
 * Reads `<stateDir>/revisions.jsonl` and returns the newest matching entries in
 * file (append) order.
 *
 * A missing audit file is an empty audit, not an error: a fresh state dir has
 * simply never recorded an edit. Any malformed line aborts the whole read
 * instead of being skipped, and the error never echoes the line contents,
 * because a corrupt line may contain a composition body.
 */
export function readCompositionRevisions(
  options: ReadCompositionRevisionsOptions = {},
): CompositionRevisionEntry[] {
  const limit = options.limit ?? DEFAULT_REVISION_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_REVISION_LIMIT) {
    throw new CliUsageError(
      `--limit must be an integer between 1 and ${String(MAX_REVISION_LIMIT)}`,
    );
  }

  const path = compositionAuditPath(options.stateDir ?? DEFAULT_COMPOSITION_STATE_DIR);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw new CompositionAuditIoError(
      `cannot read revision audit ${path}: ${messageOf(error)}`,
    );
  }

  const lines = text.split('\n');
  // The writer always terminates a line with `\n`; drop only that final empty
  // element. A blank line anywhere else is corruption, not a silent skip.
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }

  const entries: CompositionRevisionEntry[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    entries.push(parseAuditLine(lines[index] as string, index + 1));
  }

  const filtered =
    options.compositionId === undefined
      ? entries
      : entries.filter((entry) => entry.compositionId === options.compositionId);

  return filtered.slice(Math.max(0, filtered.length - limit));
}

/** Parses one argv limit value; invalid values are a usage error (exit 2). */
export function parseRevisionLimit(raw: string): number {
  if (!/^[0-9]+$/.test(raw)) {
    throw new CliUsageError(
      `--limit must be an integer between 1 and ${String(MAX_REVISION_LIMIT)}`,
    );
  }
  const limit = Number(raw);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_REVISION_LIMIT) {
    throw new CliUsageError(
      `--limit must be an integer between 1 and ${String(MAX_REVISION_LIMIT)}`,
    );
  }
  return limit;
}

function parseAuditLine(line: string, lineNumber: number): CompositionRevisionEntry {
  if (line.trim() === '') {
    throw new CompositionAuditParseError(
      `malformed revision audit line ${String(lineNumber)}: empty line`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    // Do not include the parser message: it can quote the malformed line.
    throw new CompositionAuditParseError(
      `malformed revision audit line ${String(lineNumber)}: not valid JSON`,
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CompositionAuditParseError(
      `malformed revision audit line ${String(lineNumber)}: expected a JSON object`,
    );
  }

  const record = parsed as Record<string, unknown>;
  for (const field of AUDIT_FIELDS) {
    if (!isNonEmptyString(record[field])) {
      throw new CompositionAuditParseError(
        `malformed revision audit line ${String(lineNumber)}: ` +
          `field '${field}' must be a non-empty string`,
      );
    }
  }

  return {
    at: record['at'] as string,
    compositionId: record['compositionId'] as string,
    oldRevision: record['oldRevision'] as string,
    newRevision: record['newRevision'] as string,
    file: record['file'] as string,
    mode: record['mode'] as string,
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

/** A temp file next to a composition that may be left over from a failed replace. */
export type CompositionRecoveryCandidate =
  | {
      readonly path: string;
      readonly valid: true;
      readonly compositionId: string;
      readonly graphRevision: string;
    }
  | {
      readonly path: string;
      readonly valid: false;
      readonly error: string;
    };

export interface CompositionRecoveryInspection {
  /** Absolute path of the composition the caller asked about. */
  readonly file: string;
  readonly candidates: readonly CompositionRecoveryCandidate[];
}

/**
 * Scans the composition's own directory for `.<basename>.tmp-*` candidates and
 * parses each one. This is inspection only: nothing is renamed, deleted or
 * overwritten, and the target file itself is not read or validated.
 */
export function inspectCompositionRecovery(file: string): CompositionRecoveryInspection {
  const resolved = resolve(file);
  const directory = dirname(resolved);
  const prefix = `.${basename(resolved)}.tmp-`;

  let names: string[];
  try {
    names = readdirSync(directory);
  } catch (error) {
    throw new CompositionAuditIoError(
      `cannot scan directory ${directory}: ${messageOf(error)}`,
    );
  }

  const candidates = names
    .filter((name) => name.startsWith(prefix))
    .sort()
    .map((name) => inspectCandidate(join(directory, name)));

  return { file: resolved, candidates };
}

function inspectCandidate(path: string): CompositionRecoveryCandidate {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return {
      path,
      valid: false,
      error: `cannot read candidate: ${messageOf(error)}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // A temp file holds a composition body; never echo the parser message.
    return { path, valid: false, error: 'not valid JSON' };
  }

  try {
    const definition = parseComposition(parsed);
    return {
      path,
      valid: true,
      compositionId: definition.id,
      graphRevision: definition.graphRevision,
    };
  } catch (error) {
    if (error instanceof CompositionValidationError) {
      return { path, valid: false, error: collapseLines(error.message) };
    }
    return { path, valid: false, error: 'could not parse candidate composition' };
  }
}

function collapseLines(message: string): string {
  return message.replace(/\s*\n\s*/g, '; ');
}
