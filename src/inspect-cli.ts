import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CliUsageError,
  apiaryForProject,
  loadCompositionFile,
  messageOf,
} from './cli-shared.js';
import { daemonLockState, type DaemonLockState } from './daemon-lock.js';
import { HoneyStore } from './honey.js';
import type {
  CompositionDefinition,
  NodeKind,
  PersistedField,
  PersistedNodeState,
} from './runtime/index.js';
import type { SchedulerState } from './scheduler.js';

/** Default state root, identical to `wax run` and `wax daemon`. */
const DEFAULT_STATE_DIR = '~/.wax';
const DEFAULT_LOG_TAIL = 20;

const INSPECT_USAGE =
  'usage: wax status <composition.json> (--project <dir> | --apiary <id>) ' +
  '[--state-dir <dir>] [--json]\n' +
  '       wax log    <composition.json> (--project <dir> | --apiary <id>) ' +
  '[--state-dir <dir>] [--tail <n>] [--json]\n' +
  '       wax honey  <composition.json> <conversationId> (--project <dir> | --apiary <id>) ' +
  '[--state-dir <dir>] [--tail <n>] [--json]\n' +
  '\n' +
  '  --tail defaults to 20 for "wax log" and to every event for "wax honey".';

const VALUE_FLAGS = new Set(['--project', '--apiary', '--state-dir', '--tail']);

/**
 * Metadata fields the composition log is allowed to carry. The log is the
 * metadata stream, never the transcript: projecting to this closed set keeps a
 * hand-edited or hostile line from smuggling a prompt or output body through
 * `wax log --json`.
 */
const LOG_FIELDS: readonly string[] = [
  'at',
  'event',
  'compositionId',
  'graphRevision',
  'nodeId',
  'nodeKind',
  'pheromoneId',
  'traceId',
  'forkId',
  'branchId',
  'queueDepth',
  'durationMs',
  'answerId',
  'program',
  'pid',
  'stdoutBytes',
  'stderrBytes',
  'exitCode',
  'outcome',
  'error',
  'transcriptRef',
];

export interface InspectCommandBase {
  readonly compositionPath: string;
  readonly projectDirectory?: string;
  /** Explicit apiary id; wins over `--project`. */
  readonly apiary?: string;
  readonly stateDir?: string;
}

export type InspectCommand =
  | (InspectCommandBase & { readonly kind: 'status' })
  | (InspectCommandBase & { readonly kind: 'log'; readonly tail: number })
  | (InspectCommandBase & {
      readonly kind: 'honey';
      readonly conversationId: string;
      /** Omitted means the whole transcript; `--tail` selects the last N events. */
      readonly tail?: number;
    });

export interface ParsedInspectCommand {
  readonly command: InspectCommand;
  /** `--json` is a presentation switch, not part of the inspection command. */
  readonly json: boolean;
}

export interface InspectCliDependencies {
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
  /** Test seam: state root used when --state-dir is omitted. */
  readonly defaultStateDir?: string;
}

/** A read-only failure: a corrupt field/log/transcript or a missing transcript. */
class InspectDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InspectDataError';
  }
}

export interface InspectStatusNode {
  readonly kind: NodeKind;
  readonly queueDepth: number;
  readonly pending: boolean;
  readonly active: boolean;
  readonly hover: 'user' | 'guard' | null;
  readonly lastActivatedAt: string | null;
  /** Persisted join records for this node, including closed tombstones. */
  readonly joins: number;
}

export interface InspectStatusScheduler {
  readonly state: 'absent' | 'ok';
  readonly nextDueAt: string | null;
  /**
   * Consumed one-shot `at` triggers. An `every` trigger does not persist a
   * fired count, so it is never included here.
   */
  readonly fired: number;
}

export interface InspectStatusDaemon {
  readonly state: 'absent' | 'running' | 'stale' | 'invalid';
  readonly pid: number | null;
  readonly startedAt: string | null;
  readonly error: string | null;
}

export interface InspectStatusPaths {
  readonly directory: string;
  readonly field: string;
  readonly scheduler: string;
  readonly log: string;
  readonly transcripts: string;
}

export interface InspectStatus {
  readonly schemaVersion: 1;
  readonly compositionId: string;
  readonly graphRevision: string;
  readonly state: 'ok' | 'missing';
  readonly rest: boolean;
  readonly nodes: Record<string, InspectStatusNode>;
  readonly scheduler: InspectStatusScheduler;
  readonly daemon: InspectStatusDaemon;
  readonly paths: InspectStatusPaths;
}

interface InspectContext {
  readonly definition: CompositionDefinition;
  readonly store: HoneyStore;
}

interface JsonLine {
  readonly value: Record<string, unknown>;
  /** The parsed line without a trailing CR, for verbatim human output. */
  readonly raw: string;
}

export function parseInspectArgs(argv: readonly string[]): ParsedInspectCommand {
  const [command, ...rest] = argv;
  if (command !== 'status' && command !== 'log' && command !== 'honey') {
    throw new CliUsageError(INSPECT_USAGE);
  }

  const positionals: string[] = [];
  const flags = new Map<string, string>();
  let json = false;

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === undefined) {
      continue;
    }
    if (token === '--json') {
      if (json) {
        throw new CliUsageError("option '--json' was given more than once");
      }
      json = true;
      continue;
    }
    if (token.startsWith('--')) {
      if (!VALUE_FLAGS.has(token)) {
        throw new CliUsageError(`unknown option '${token}' for "wax ${command}"`);
      }
      const value = rest[index + 1];
      if (value === undefined || value.startsWith('--') || value.trim() === '') {
        throw new CliUsageError(`option '${token}' needs a value`);
      }
      if (flags.has(token)) {
        throw new CliUsageError(`option '${token}' was given more than once`);
      }
      flags.set(token, value);
      index += 1;
      continue;
    }
    positionals.push(token);
  }

  if (command === 'status' && flags.has('--tail')) {
    throw new CliUsageError("option '--tail' is only valid for \"wax log\" and \"wax honey\"");
  }

  const expected = command === 'honey' ? 2 : 1;
  if (positionals.length !== expected) {
    throw new CliUsageError(
      command === 'honey'
        ? 'expected <composition.json> and <conversationId> after "wax honey"'
        : `expected exactly one composition file after "wax ${command}"`,
    );
  }

  const projectDirectory = flags.get('--project');
  const apiary = flags.get('--apiary');
  if (projectDirectory === undefined && apiary === undefined) {
    throw new CliUsageError('missing apiary: pass --project <dir> or --apiary <id>');
  }

  const stateDir = flags.get('--state-dir');
  const base: InspectCommandBase = {
    compositionPath: positionals[0] as string,
    ...(projectDirectory === undefined ? {} : { projectDirectory }),
    ...(apiary === undefined ? {} : { apiary }),
    ...(stateDir === undefined ? {} : { stateDir }),
  };

  if (command === 'status') {
    return { command: { kind: 'status', ...base }, json };
  }

  const tailRaw = flags.get('--tail');
  if (command === 'log') {
    return {
      command: {
        kind: 'log',
        ...base,
        tail: tailRaw === undefined ? DEFAULT_LOG_TAIL : parseTail(tailRaw),
      },
      json,
    };
  }

  const conversationId = positionals[1] as string;
  const tail = tailRaw === undefined ? undefined : parseTail(tailRaw);
  return {
    command: {
      kind: 'honey',
      ...base,
      conversationId,
      ...(tail === undefined ? {} : { tail }),
    },
    json,
  };
}

function parseTail(raw: string): number {
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new CliUsageError(`--tail must be a positive integer, got '${raw}'`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new CliUsageError(`--tail is too large: '${raw}'`);
  }
  return value;
}

/**
 * `wax status|log|honey` — read-only Honey inspection.
 *
 * Exit codes: 0 success (a missing field, missing log or absent scheduler is
 * still success); 2 usage or a composition/lock-path that cannot be resolved;
 * 1 corrupt data (field, scheduler, log line, transcript line) or a missing
 * transcript. Errors go to stderr; `--json` writes exactly one JSON value to
 * stdout on success and nothing on failure.
 *
 * No command creates, replaces or removes a state file or lock.
 */
export function runInspectCli(
  argv: readonly string[],
  deps: InspectCliDependencies = {},
): number {
  const out = deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));

  let parsed: ParsedInspectCommand;
  try {
    parsed = parseInspectArgs(argv);
  } catch (error) {
    if (error instanceof CliUsageError) {
      err(error.message);
      return 2;
    }
    throw error;
  }

  try {
    const context = resolveContext(parsed.command, deps);
    switch (parsed.command.kind) {
      case 'status': {
        const status = buildStatus(context);
        if (parsed.json) {
          out(JSON.stringify(status));
        } else {
          printStatus(out, status);
        }
        return 0;
      }
      case 'log': {
        const entries = readLog(context.store, parsed.command.tail);
        if (parsed.json) {
          out(JSON.stringify(entries));
        } else {
          for (const entry of entries) {
            out(formatLogEntry(entry));
          }
        }
        return 0;
      }
      case 'honey': {
        const lines = readTranscript(
          context.store,
          parsed.command.conversationId,
          parsed.command.tail,
        );
        if (parsed.json) {
          out(JSON.stringify(lines.map((line) => line.value)));
        } else {
          for (const line of lines) {
            out(line.raw);
          }
        }
        return 0;
      }
    }
  } catch (error) {
    if (error instanceof CliUsageError) {
      err(error.message);
      return 2;
    }
    if (error instanceof InspectDataError) {
      err(`error: ${error.message}`);
      return 1;
    }
    err(`error: ${messageOf(error)}`);
    return 1;
  }
}

function resolveContext(
  command: InspectCommand,
  deps: InspectCliDependencies,
): InspectContext {
  const definition = loadCompositionFile(command.compositionPath);
  const apiary = command.apiary ?? apiaryForProject(command.projectDirectory as string);
  let store: HoneyStore;
  try {
    store = HoneyStore.forComposition(
      command.stateDir ?? deps.defaultStateDir ?? DEFAULT_STATE_DIR,
      apiary,
      definition.id,
    );
  } catch (error) {
    // An unsafe apiary/composition id is an argument problem, not corrupt state.
    throw new CliUsageError(messageOf(error));
  }
  return { definition, store };
}

function buildStatus(context: InspectContext): InspectStatus {
  const { definition, store } = context;
  const field = loadField(store);
  const schedulerState = loadScheduler(store);
  const lock = daemonLockState(join(store.paths.directory, 'daemon.lock'));

  const nodes: Record<string, InspectStatusNode> = {};
  for (const [id, node] of definition.nodes) {
    nodes[id] = summarizeNode(node.kind, field?.nodes[id]);
  }

  return {
    schemaVersion: 1,
    compositionId: definition.id,
    graphRevision: definition.graphRevision,
    state: field === undefined ? 'missing' : 'ok',
    rest: field?.rest ?? true,
    nodes,
    scheduler: summarizeScheduler(schedulerState),
    daemon: summarizeDaemon(lock),
    paths: {
      directory: store.paths.directory,
      field: store.paths.field,
      scheduler: store.paths.scheduler,
      log: store.paths.log,
      transcripts: store.paths.transcripts,
    },
  };
}

function loadField(store: HoneyStore): PersistedField | undefined {
  try {
    return store.load();
  } catch (error) {
    throw new InspectDataError(
      `cannot read Honey field ${store.paths.field}: ${messageOf(error)}`,
    );
  }
}

function loadScheduler(store: HoneyStore): SchedulerState | undefined {
  try {
    return store.loadScheduler();
  } catch (error) {
    throw new InspectDataError(
      `cannot read scheduler state ${store.paths.scheduler}: ${messageOf(error)}`,
    );
  }
}

function summarizeNode(
  kind: NodeKind,
  state: PersistedNodeState | undefined,
): InspectStatusNode {
  return {
    kind,
    queueDepth: state?.queue.length ?? 0,
    pending: state?.pending !== undefined,
    active: state?.active !== undefined,
    hover: hoverKind(state?.hover),
    lastActivatedAt: state?.lastActivatedAt ?? null,
    joins: state?.joins === undefined ? 0 : Object.keys(state.joins).length,
  };
}

function hoverKind(
  hover: PersistedNodeState['hover'],
): 'user' | 'guard' | null {
  if (hover === undefined) {
    return null;
  }
  // The status contract exposes only the two hover kinds a human can settle.
  return hover.kind === 'user' || hover.kind === 'guard' ? hover.kind : null;
}

function summarizeScheduler(state: SchedulerState | undefined): InspectStatusScheduler {
  if (state === undefined) {
    return { state: 'absent', nextDueAt: null, fired: 0 };
  }

  let nextDueMs: number | undefined;
  let fired = 0;
  for (const entry of Object.values(state.triggers)) {
    if (entry.kind === 'at') {
      if (entry.fired) {
        fired += 1;
        continue;
      }
      const due = Date.parse(entry.at);
      if (Number.isFinite(due)) {
        nextDueMs = earliest(nextDueMs, due);
      }
      continue;
    }
    if (Number.isFinite(entry.nextDueMs)) {
      nextDueMs = earliest(nextDueMs, entry.nextDueMs);
    }
  }

  return {
    state: 'ok',
    nextDueAt: isoOrNull(nextDueMs),
    fired,
  };
}

function summarizeDaemon(lock: DaemonLockState): InspectStatusDaemon {
  switch (lock.state) {
    case 'absent':
      return { state: 'absent', pid: null, startedAt: null, error: null };
    case 'running':
    case 'stale':
      return {
        state: lock.state,
        pid: lock.info.pid,
        startedAt: lock.info.startedAt === '' ? null : lock.info.startedAt,
        error: null,
      };
    case 'invalid':
      return { state: 'invalid', pid: null, startedAt: null, error: lock.error };
  }
}

function earliest(current: number | undefined, candidate: number): number {
  return current === undefined || candidate < current ? candidate : current;
}

function isoOrNull(ms: number | undefined): string | null {
  if (ms === undefined || !Number.isFinite(ms)) {
    return null;
  }
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function readLog(store: HoneyStore, tail: number): readonly Record<string, unknown>[] {
  const lines = readJsonLines(store.paths.log, 'log', 'empty');
  return last(lines, tail).map((line) => projectLogEntry(line.value));
}

function readTranscript(
  store: HoneyStore,
  conversationId: string,
  tail: number | undefined,
): readonly JsonLine[] {
  let path: string;
  try {
    path = store.transcriptPath(conversationId);
  } catch (error) {
    // The id failed the store's own safe-segment rule.
    throw new CliUsageError(messageOf(error));
  }
  if (!existsSync(path)) {
    throw new InspectDataError(
      `no transcript for conversation '${conversationId}' at ${path}`,
    );
  }
  return last(readJsonLines(path, 'transcript', 'error'), tail);
}

/**
 * Reads a JSONL file in order. Empty lines are ignored, but a malformed or
 * non-object line fails with its 1-based line number instead of being skipped.
 * A missing file is empty only when `missing` is `empty`.
 */
function readJsonLines(
  path: string,
  label: string,
  missing: 'empty' | 'error',
): JsonLine[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (missing === 'empty' && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw new InspectDataError(`cannot read ${label} ${path}: ${messageOf(error)}`);
  }

  const lines = text.split('\n');
  const entries: JsonLine[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const raw = (lines[index] ?? '').replace(/\r$/, '');
    if (raw.trim() === '') {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new InspectDataError(
        `${label} line ${String(index + 1)} is not valid JSON: ${path} (${messageOf(error)})`,
      );
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new InspectDataError(
        `${label} line ${String(index + 1)} is not a JSON object: ${path}`,
      );
    }
    entries.push({
      value: parsed as Record<string, unknown>,
      raw,
    });
  }
  return entries;
}

function projectLogEntry(entry: Record<string, unknown>): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const field of LOG_FIELDS) {
    if (entry[field] !== undefined) {
      projected[field] = entry[field];
    }
  }
  return projected;
}

function last<T>(items: readonly T[], tail: number | undefined): readonly T[] {
  if (tail === undefined) {
    return items;
  }
  return items.slice(Math.max(0, items.length - tail));
}

function formatLogEntry(entry: Record<string, unknown>): string {
  const at = typeof entry['at'] === 'string' ? entry['at'] : '-';
  const event = typeof entry['event'] === 'string' ? entry['event'] : '?';
  const parts = [at, event];
  if (typeof entry['nodeId'] === 'string') {
    parts.push(`node=${entry['nodeId']}`);
  }
  if (typeof entry['outcome'] === 'string') {
    parts.push(`outcome=${entry['outcome']}`);
  }
  return parts.join(' ');
}

function printStatus(out: (line: string) => void, status: InspectStatus): void {
  out(`composition  ${status.compositionId}`);
  out(`revision     ${status.graphRevision}`);
  out(`state        ${status.state}`);
  out(`rest         ${String(status.rest)}`);
  out(`scheduler    ${formatScheduler(status.scheduler)}`);
  out(`daemon       ${formatDaemon(status.daemon)}`);
  for (const [id, node] of Object.entries(status.nodes)) {
    out(
      `node         ${id} kind=${node.kind} queue=${String(node.queueDepth)} ` +
        `pending=${yesNo(node.pending)} active=${yesNo(node.active)} ` +
        `hover=${node.hover ?? '-'} joins=${String(node.joins)} ` +
        `lastActivatedAt=${node.lastActivatedAt ?? '-'}`,
    );
  }
  out(`path         directory ${status.paths.directory}`);
  out(`path         field ${status.paths.field}`);
  out(`path         scheduler ${status.paths.scheduler}`);
  out(`path         log ${status.paths.log}`);
  out(`path         transcripts ${status.paths.transcripts}`);
}

function formatScheduler(scheduler: InspectStatusScheduler): string {
  if (scheduler.state === 'absent') {
    return 'absent';
  }
  return `ok nextDueAt=${scheduler.nextDueAt ?? '-'} fired=${String(scheduler.fired)}`;
}

function formatDaemon(daemon: InspectStatusDaemon): string {
  if (daemon.state === 'invalid') {
    return `invalid ${daemon.error ?? ''}`.trimEnd();
  }
  if (daemon.state === 'absent') {
    return 'absent';
  }
  return `${daemon.state} pid=${String(daemon.pid)} startedAt=${daemon.startedAt ?? '-'}`;
}

function yesNo(value: boolean): string {
  return value ? 'yes' : 'no';
}
