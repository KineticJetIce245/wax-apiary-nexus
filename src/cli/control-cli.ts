import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import {
  ControlClient,
  ControlClientError,
  discoverDaemon,
} from '../control/client.js';
import type { GraphRunResult, GraphStatus } from '../daemon/graph-host.js';
import { GraphManifestError, loadGraphManifest } from '../graph/manifest.js';
import type { ManifestLoadSpec } from '../graph/manifest.js';
import type { SweepReport } from '../graph/registry.js';
import type { HarnessKind } from '../session/connection.js';
import { CliUsageError, messageOf } from './cli-shared.js';

const GRAPH_USAGE =
  'usage: wax graph <list|status <graphId>|load <composition.json>|load --manifest <file>|' +
  'unload <graphId>|sweep> [--json] [--daemon-dir <dir>] [--harness <codex|dsh>] ' +
  '(load also needs --project <dir> --bindings <file> [--idle-ttl-ms <n>], or --manifest)';
const TRIGGER_USAGE =
  'usage: wax trigger <graphId> <nodeId> [--input <text>] [--json] ' +
  '[--daemon-dir <dir>] [--harness <codex|dsh>]';

/** Injected by the CLI entry points and by tests. */
export interface ControlCliDependencies {
  readonly env?: NodeJS.ProcessEnv;
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
  /** Test seam: count or fail HTTP calls without replacing the real server. */
  readonly fetchImpl?: typeof fetch;
}

type Writer = (line: string) => void;

/** A local input file could not be read; this is an IO failure, not usage. */
class ControlCliIoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ControlCliIoError';
  }
}

export interface ParsedCliTokens {
  readonly positionals: readonly string[];
  readonly flags: ReadonlyMap<string, string>;
  readonly json: boolean;
}

export interface ParseCliTokensOptions {
  /** `waxd` has no `--json` switch; graph and trigger do. */
  readonly allowJson?: boolean;
  /** Flags for which an empty string is a meaningful value (for example --input). */
  readonly allowEmpty?: ReadonlySet<string>;
}

/**
 * Shared token parser for the graph/trigger and waxd front ends.
 *
 * It deliberately mirrors the existing CLI style: `--json` is a boolean,
 * every other `--flag` consumes exactly one value, duplicates are usage
 * errors, and anything that is not a flag is positional.
 */
export function parseCliTokens(
  tokens: readonly string[],
  valueFlags: ReadonlySet<string>,
  options: ParseCliTokensOptions = {},
): ParsedCliTokens {
  const positionals: string[] = [];
  const flags = new Map<string, string>();
  let json = false;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) {
      continue;
    }
    if (token === '--json') {
      if (options.allowJson === false) {
        throw new CliUsageError(`unknown option '${token}'`);
      }
      if (json) {
        throw new CliUsageError("option '--json' was given more than once");
      }
      json = true;
      continue;
    }
    if (token.startsWith('--')) {
      if (!valueFlags.has(token)) {
        throw new CliUsageError(`unknown option '${token}'`);
      }
      const value = tokens[index + 1];
      if (
        value === undefined ||
        value.startsWith('--') ||
        (value === '' && options.allowEmpty?.has(token) !== true)
      ) {
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

  return { positionals, flags, json };
}

const LIST_FLAGS = new Set(['--daemon-dir', '--harness']);
const STATUS_FLAGS = new Set(['--daemon-dir', '--harness']);
const LOAD_FLAGS = new Set([
  '--manifest',
  '--project',
  '--bindings',
  '--idle-ttl-ms',
  '--daemon-dir',
  '--harness',
]);
const UNLOAD_FLAGS = new Set(['--daemon-dir', '--harness']);
const SWEEP_FLAGS = new Set(['--daemon-dir', '--harness']);
const TRIGGER_FLAGS = new Set(['--input', '--daemon-dir', '--harness']);
const TRIGGER_EMPTY_FLAGS = new Set(['--input']);

interface GraphCommon {
  readonly json: boolean;
  readonly daemonDir?: string;
  readonly harness?: HarnessKind;
}

/** Where a `graph load` takes its definition, bindings and project from. */
export type GraphLoadSource =
  | {
      readonly kind: 'composition';
      readonly compositionPath: string;
      readonly projectDirectory: string;
      readonly bindingsPath: string;
      readonly idleTtlMs?: number;
    }
  | { readonly kind: 'manifest'; readonly manifestPath: string };

export type GraphCommand =
  | (GraphCommon & { readonly kind: 'list' })
  | (GraphCommon & { readonly kind: 'status'; readonly graphId: string })
  | (GraphCommon & { readonly kind: 'load'; readonly source: GraphLoadSource })
  | (GraphCommon & { readonly kind: 'unload'; readonly graphId: string })
  | (GraphCommon & { readonly kind: 'sweep' });

export interface TriggerCommand {
  readonly graphId: string;
  readonly nodeId: string;
  readonly input: string;
  readonly json: boolean;
  readonly daemonDir?: string;
  readonly harness?: HarnessKind;
}

function harnessOf(parsed: ParsedCliTokens): { readonly harness?: HarnessKind } {
  const value = parsed.flags.get('--harness');
  if (value === undefined) {
    return {};
  }
  if (value !== 'codex' && value !== 'dsh') {
    throw new CliUsageError("--harness must be 'codex' or 'dsh'");
  }
  return { harness: value };
}

function commonOf(parsed: ParsedCliTokens): {
  readonly daemonDir?: string;
  readonly harness?: HarnessKind;
} {
  const daemonDir = parsed.flags.get('--daemon-dir');
  return {
    ...(daemonDir === undefined ? {} : { daemonDir }),
    ...harnessOf(parsed),
  };
}

function requirePositionals(parsed: ParsedCliTokens, count: number, message: string): void {
  if (parsed.positionals.length !== count) {
    throw new CliUsageError(message);
  }
}

function requireFlag(parsed: ParsedCliTokens, flag: string, label: string): string {
  const value = parsed.flags.get(flag);
  if (value === undefined) {
    throw new CliUsageError(`missing required option ${flag} <${label}>`);
  }
  return value;
}

function requireIdentifier(value: string | undefined, label: string): string {
  if (value === undefined || value.trim() === '') {
    throw new CliUsageError(`missing ${label}`);
  }
  return value;
}

function parseNonNegativeInteger(raw: string, flag: string): number {
  if (!/^[0-9]+$/.test(raw)) {
    throw new CliUsageError(`${flag} must be a non-negative integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CliUsageError(`${flag} must be a non-negative integer`);
  }
  return value;
}

export function parseGraphArgs(argv: readonly string[]): GraphCommand {
  const [command, subcommand, ...rest] = argv;
  if (command !== 'graph') {
    throw new CliUsageError(GRAPH_USAGE);
  }

  if (subcommand === 'list') {
    const parsed = parseCliTokens(rest, LIST_FLAGS);
    requirePositionals(parsed, 0, 'expected no arguments after "wax graph list"');
    return { kind: 'list', json: parsed.json, ...commonOf(parsed) };
  }

  if (subcommand === 'status') {
    const parsed = parseCliTokens(rest, STATUS_FLAGS);
    requirePositionals(parsed, 1, 'expected exactly one graph id after "wax graph status"');
    return {
      kind: 'status',
      graphId: requireIdentifier(parsed.positionals[0], 'graph id'),
      json: parsed.json,
      ...commonOf(parsed),
    };
  }

  if (subcommand === 'load') {
    const parsed = parseCliTokens(rest, LOAD_FLAGS);
    const manifestPath = parsed.flags.get('--manifest');
    if (manifestPath !== undefined) {
      if (parsed.positionals.length > 0) {
        throw new CliUsageError('--manifest cannot be combined with a composition file');
      }
      for (const flag of ['--project', '--bindings', '--idle-ttl-ms']) {
        if (parsed.flags.has(flag)) {
          throw new CliUsageError(`${flag} cannot be combined with --manifest`);
        }
      }
      return {
        kind: 'load',
        source: { kind: 'manifest', manifestPath },
        json: parsed.json,
        ...commonOf(parsed),
      };
    }
    requirePositionals(parsed, 1, 'expected exactly one composition file after "wax graph load"');
    const idleRaw = parsed.flags.get('--idle-ttl-ms');
    return {
      kind: 'load',
      source: {
        kind: 'composition',
        compositionPath: parsed.positionals[0] as string,
        projectDirectory: requireFlag(parsed, '--project', 'dir'),
        bindingsPath: requireFlag(parsed, '--bindings', 'file'),
        ...(idleRaw === undefined
          ? {}
          : { idleTtlMs: parseNonNegativeInteger(idleRaw, '--idle-ttl-ms') }),
      },
      json: parsed.json,
      ...commonOf(parsed),
    };
  }

  if (subcommand === 'unload') {
    const parsed = parseCliTokens(rest, UNLOAD_FLAGS);
    requirePositionals(parsed, 1, 'expected exactly one graph id after "wax graph unload"');
    return {
      kind: 'unload',
      graphId: requireIdentifier(parsed.positionals[0], 'graph id'),
      json: parsed.json,
      ...commonOf(parsed),
    };
  }

  if (subcommand === 'sweep') {
    const parsed = parseCliTokens(rest, SWEEP_FLAGS);
    requirePositionals(parsed, 0, 'expected no arguments after "wax graph sweep"');
    return { kind: 'sweep', json: parsed.json, ...commonOf(parsed) };
  }

  if (subcommand === undefined) {
    throw new CliUsageError(GRAPH_USAGE);
  }
  throw new CliUsageError(`unknown graph command '${subcommand}'`);
}

export function parseTriggerArgs(argv: readonly string[]): TriggerCommand {
  const [command, ...rest] = argv;
  if (command !== 'trigger') {
    throw new CliUsageError(TRIGGER_USAGE);
  }
  const parsed = parseCliTokens(rest, TRIGGER_FLAGS, {
    allowEmpty: TRIGGER_EMPTY_FLAGS,
  });
  if (parsed.positionals.length !== 2) {
    throw new CliUsageError(
      'expected exactly a graph id and a node id after "wax trigger"',
    );
  }
  return {
    graphId: requireIdentifier(parsed.positionals[0], 'graph id'),
    nodeId: requireIdentifier(parsed.positionals[1], 'node id'),
    input: parsed.flags.get('--input') ?? '',
    json: parsed.json,
    ...commonOf(parsed),
  };
}

interface PreparedLoad {
  readonly definition: unknown;
  readonly bindings: unknown;
  readonly project: { readonly id: string; readonly directory: string };
  readonly idleTtlMs?: number;
}

function readJsonFile(path: string, label: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new ControlCliIoError(
      `cannot read ${label} file '${path}': ${ioCode(error)}`,
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    // The parser message can echo file content (a prompt, for example), so the
    // error deliberately carries only the path.
    throw new CliUsageError(`${label} file '${path}' is not valid JSON`);
  }
}

function ioCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === 'string' && code !== '' ? code : 'read failed';
}

/**
 * The control API requires a project id, but graph load is the only consumer
 * and no project registry is persisted. A path-derived id keeps repeated loads
 * of the same directory stable without introducing new state.
 */
function projectIdForDirectory(directory: string): string {
  const name = basename(directory).replace(/[\u0000-\u001f\u007f]/g, '-');
  const safe = name.slice(0, 256);
  return safe === '' ? 'project' : safe;
}

function loadManifestOrUsage(manifestPath: string): ManifestLoadSpec {
  try {
    return loadGraphManifest(manifestPath);
  } catch (error) {
    // A bad manifest is local input, so it keeps the CLI's exit-2 contract and
    // never reaches discovery or the daemon.
    if (error instanceof GraphManifestError) {
      throw new CliUsageError(error.message);
    }
    throw error;
  }
}

function prepareLoad(command: Extract<GraphCommand, { kind: 'load' }>): PreparedLoad {
  if (command.source.kind === 'manifest') {
    const spec = loadManifestOrUsage(command.source.manifestPath);
    if (command.harness !== undefined && command.harness !== spec.harness) {
      throw new CliUsageError(
        `manifest harness '${spec.harness}' conflicts with --harness '${command.harness}'`,
      );
    }
    return {
      definition: spec.definition,
      bindings: spec.bindings,
      project: spec.project,
      ...(spec.idleTtlMs === undefined ? {} : { idleTtlMs: spec.idleTtlMs }),
    };
  }

  const definition = readJsonFile(command.source.compositionPath, 'composition');
  const bindings = readJsonFile(command.source.bindingsPath, 'bindings');
  if (!isRecord(bindings)) {
    throw new CliUsageError(
      `bindings file '${command.source.bindingsPath}' must contain a JSON object`,
    );
  }
  const directory = resolve(command.source.projectDirectory);
  return {
    definition,
    bindings,
    project: { id: projectIdForDirectory(directory), directory },
    ...(command.source.idleTtlMs === undefined
      ? {}
      : { idleTtlMs: command.source.idleTtlMs }),
  };
}

function defaultDaemonRoot(env: NodeJS.ProcessEnv | undefined): string {
  const home = env?.['HOME'] || env?.['USERPROFILE'] || homedir();
  return join(home, '.wax', 'waxd');
}

/**
 * A single-harness daemon keeps the original `<root>` layout. A multi-harness
 * daemon puts each harness under `<root>/<harness>`, so the CLI must be told
 * which one it means; it never guesses.
 */
function discoveryDirectory(
  daemonDir: string | undefined,
  harness: HarnessKind | undefined,
  env: NodeJS.ProcessEnv | undefined,
): string | undefined {
  if (harness === undefined) {
    return daemonDir;
  }
  return join(daemonDir ?? defaultDaemonRoot(env), harness);
}

function createClient(
  daemonDir: string | undefined,
  harness: HarnessKind | undefined,
  deps: ControlCliDependencies,
): ControlClient {
  const directory = discoveryDirectory(daemonDir, harness, deps.env);
  const discovery = discoverDaemon({
    ...(directory === undefined ? {} : { daemonDir: directory }),
    ...(directory === undefined && deps.env !== undefined ? { env: deps.env } : {}),
  });
  return new ControlClient({
    baseUrl: discovery.baseUrl,
    token: discovery.token,
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
  });
}

export async function runGraphCli(
  argv: readonly string[],
  deps: ControlCliDependencies = {},
): Promise<number> {
  const out = deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  let harnessHint = false;
  try {
    const command = parseGraphArgs(argv);
    harnessHint = command.harness === undefined;
    // Local validation happens before discovery or any HTTP request, so a bad
    // file can never create a session or reach the daemon.
    const prepared = command.kind === 'load' ? prepareLoad(command) : undefined;
    const client = createClient(command.daemonDir, command.harness, deps);

    switch (command.kind) {
      case 'list': {
        const statuses = (await client.status()) as readonly GraphStatus[];
        if (command.json) {
          writeJson(out, { status: statuses });
        } else {
          for (const status of statuses) {
            out(listLine(status));
          }
        }
        return 0;
      }
      case 'status': {
        const status = await client.statusOf(command.graphId);
        if (status === undefined) {
          err(`error: graph '${command.graphId}' is not loaded`);
          return 1;
        }
        if (command.json) {
          writeJson(out, status);
        } else {
          printStatus(out, status as GraphStatus, 'status');
        }
        return 0;
      }
      case 'load': {
        if (prepared === undefined) {
          throw new Error('load command was not prepared');
        }
        const status = (await client.load(prepared)) as GraphStatus;
        if (command.json) {
          writeJson(out, status);
        } else {
          printStatus(out, status, 'loaded');
        }
        return 0;
      }
      case 'unload': {
        const unloaded = await client.unload(command.graphId);
        if (!unloaded) {
          err(`error: graph '${command.graphId}' is not unloadable`);
          return 1;
        }
        if (command.json) {
          writeJson(out, { graphId: command.graphId, unloaded: true });
        } else {
          out(`unloaded ${command.graphId}`);
        }
        return 0;
      }
      case 'sweep': {
        const report = (await client.sweep()) as SweepReport;
        if (command.json) {
          writeJson(out, report);
        } else {
          out(
            `unloaded=${String(report.unloaded.length)} ` +
              `skipped=${String(report.skipped.length)} ` +
              `failed=${String(report.failed.length)}`,
          );
        }
        return 0;
      }
    }
  } catch (error) {
    return reportCliError(error, err, { harnessHint });
  }
}

export async function runTriggerCli(
  argv: readonly string[],
  deps: ControlCliDependencies = {},
): Promise<number> {
  const out = deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  let harnessHint = false;
  try {
    const command = parseTriggerArgs(argv);
    harnessHint = command.harness === undefined;
    const client = createClient(command.daemonDir, command.harness, deps);
    // Exactly one attempt. ControlClient never retries, and neither does this
    // CLI: a trigger can have side effects, so a failure is reported as-is.
    const result = (await client.trigger(command.graphId, command.nodeId, {
      kind: 'text',
      text: command.input,
    })) as GraphRunResult;
    if (command.json) {
      writeJson(out, result);
    } else {
      out(
        `trigger ${result.graphId} rest=${String(result.rest)} ` +
          `hovered=${String(result.hovered)} pumps=${String(result.pumps)} ` +
          `persisted=${String(result.persisted)}`,
      );
      if (!result.persisted) {
        out(`persist-failed ${oneLine(result.persistError ?? 'unknown')}`);
      }
    }
    return 0;
  } catch (error) {
    return reportCliError(error, err, { harnessHint });
  }
}

function reportCliError(
  error: unknown,
  err: Writer,
  options: { readonly harnessHint?: boolean } = {},
): number {
  if (error instanceof CliUsageError) {
    err(oneLine(error.message));
    return 2;
  }
  if (error instanceof ControlClientError) {
    const hint =
      options.harnessHint === true && error.code === 'discovery'
        ? '; if this waxd serves per-harness directories, pass --harness <codex|dsh>'
        : '';
    err(`${controlErrorLine(error)}${hint}`);
    return 1;
  }
  if (error instanceof ControlCliIoError) {
    err(`error: ${oneLine(error.message)}`);
    return 1;
  }
  err(`error: ${oneLine(messageOf(error))}`);
  return 1;
}

function controlErrorLine(error: ControlClientError): string {
  const details = [`code=${error.code}`];
  if (error.status !== undefined) {
    details.unshift(`status=${String(error.status)}`);
  }
  return `error: ${oneLine(error.message)} (${details.join(', ')})`;
}

function writeJson(out: Writer, value: unknown): void {
  const text = JSON.stringify(value);
  if (text === undefined) {
    throw new Error('control response could not be serialized as JSON');
  }
  out(text);
}

function listLine(status: GraphStatus): string {
  return (
    `${status.graphId} rest=${String(status.rest)} ` +
    `hovered=${String(status.hovered)} nodes=${String(status.nodes.length)} ` +
    `refCount=${String(status.residency.refCount)}`
  );
}

function printStatus(out: Writer, status: GraphStatus, label: string): void {
  out(
    `${label} ${status.graphId} rest=${String(status.rest)} ` +
      `hovered=${String(status.hovered)} nodes=${String(status.nodes.length)} ` +
      `refCount=${String(status.residency.refCount)}`,
  );
  for (const node of status.nodes) {
    out(
      `node ${node.nodeId} kind=${node.kind} queue=${String(node.queue)} ` +
        `pending=${yesNo(node.pending)} active=${yesNo(node.active)} ` +
        `hovered=${yesNo(node.hovered)} joins=${String(node.joins)}`,
    );
  }
  out(
    `residency state=${status.residency.state} ` +
      `ttlMs=${String(status.residency.idleTtlMs)} ` +
      `refCount=${String(status.residency.refCount)} ` +
      `pinned=${yesNo(status.residency.pinned)}`,
  );
  if (status.recovery !== undefined) {
    out(
      `recovery resumed=${status.recovery.resumedHovers.join(',') || '-'} ` +
        `unknown=${status.recovery.unknownActive.join(',') || '-'} ` +
        `stuck=${status.recovery.stuckActive.join(',') || '-'}`,
    );
  }
}

function yesNo(value: boolean): string {
  return value ? 'yes' : 'no';
}

function oneLine(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
