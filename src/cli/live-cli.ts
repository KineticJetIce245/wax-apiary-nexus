import { readFileSync } from 'node:fs';

import type { LiveHive, SessionParams } from '../b/types.js';
import { LiveHiveClient } from '../control/live-client.js';
import type { Project } from '../project/kernel.js';
import { CliUsageError } from './cli-shared.js';
import {
  parseCliTokens,
  type ControlCliDependencies,
  type ParsedCliTokens,
} from './control-cli.js';
import {
  createClient,
  projectOf,
  requirePositionals,
  requirePositionalsValue,
  requireValue,
  reportCliError,
  writeJson,
  type Writer,
} from './live-cli-shared.js';

const LIVE_USAGE =
  'usage: wax live <list|new <live.json>|load <liveId> [path]|instantiate <templateId> <liveId>|' +
  'wake <liveId> <beeId> --input <text>|answer <liveId> <beeId> --input <text> [--token <token>]|' +
  'save <liveId>|unload <liveId>|migrate <liveId> <live.json>|inspect <liveId>> ' +
  '[--project <dir>] [--daemon-dir <dir>] [--harness <codex|dsh>] [--json]';
const INPUT_FLAGS = new Set([
  '--daemon-dir',
  '--harness',
  '--project',
  '--input',
  '--token',
]);

class LiveCliIoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LiveCliIoError';
  }
}

export async function runLiveCli(
  argv: readonly string[],
  deps: ControlCliDependencies = {},
): Promise<number> {
  const out = deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  try {
    const parsed = parseCliTokens(argv.slice(2), INPUT_FLAGS);
    const command = liveCommand(argv[1], parsed);
    const client = createClient(parsed, deps);
    return await executeLive(client, command, parsed.json, out, err);
  } catch (error) {
    return reportCliError(error, err);
  }
}

interface LiveCommon {
  readonly project: Project;
  readonly json: boolean;
}

type WakeAnswerCommand = LiveCommon & {
  readonly kind: 'wake' | 'answer';
  readonly liveId: string;
  readonly beeId: string;
  readonly input: string;
  readonly token?: string;
};

type SimpleCommand = LiveCommon & {
  readonly kind: 'save' | 'unload' | 'inspect';
  readonly liveId: string;
};

type LiveCommand =
  | (LiveCommon & { readonly kind: 'list' })
  | (LiveCommon & { readonly kind: 'new'; readonly file: string })
  | (LiveCommon & { readonly kind: 'load'; readonly liveId: string; readonly path?: string })
  | (LiveCommon & {
      readonly kind: 'instantiate';
      readonly templateId: string;
      readonly liveId: string;
      readonly overrides: Readonly<Record<string, SessionParams>>;
    })
  | WakeAnswerCommand
  | SimpleCommand
  | (LiveCommon & { readonly kind: 'migrate'; readonly liveId: string; readonly file: string });

function liveCommand(sub: string | undefined, parsed: ParsedCliTokens): LiveCommand {
  const common = { project: projectOf(parsed), json: parsed.json };
  switch (sub) {
    case 'list':
      requirePositionals(parsed, 0, LIVE_USAGE);
      return { ...common, kind: 'list' };
    case 'new':
      return parseNewCommand(parsed, common);
    case 'load':
      return parseLoadCommand(parsed, common);
    case 'instantiate':
      return parseInstantiateCommand(parsed, common);
    case 'wake':
    case 'answer':
      return parseRunCommand(sub, parsed, common);
    case 'save':
    case 'unload':
    case 'inspect':
      return parseSimpleCommand(sub, parsed, common);
    case 'migrate':
      return parseMigrateCommand(parsed, common);
    default:
      throw new CliUsageError(LIVE_USAGE);
  }
}

function parseNewCommand(parsed: ParsedCliTokens, common: LiveCommon): LiveCommand {
  requirePositionals(parsed, 1, LIVE_USAGE);
  return { ...common, kind: 'new', file: requirePositionalsValue(parsed) };
}

function parseLoadCommand(parsed: ParsedCliTokens, common: LiveCommon): LiveCommand {
  if (parsed.positionals.length < 1 || parsed.positionals.length > 2) {
    throw new CliUsageError(LIVE_USAGE);
  }
  const [liveId, path] = parsed.positionals;
  return {
    ...common,
    kind: 'load',
    liveId: requireValue(liveId, 'liveId'),
    ...(path === undefined ? {} : { path }),
  };
}

function parseInstantiateCommand(
  parsed: ParsedCliTokens,
  common: LiveCommon,
): LiveCommand {
  requirePositionals(parsed, 2, LIVE_USAGE);
  const [templateId, liveId] = parsed.positionals;
  return {
    ...common,
    kind: 'instantiate',
    templateId: requireValue(templateId, 'templateId'),
    liveId: requireValue(liveId, 'liveId'),
    overrides: {},
  };
}

function parseRunCommand(
  kind: 'wake' | 'answer',
  parsed: ParsedCliTokens,
  common: LiveCommon,
): LiveCommand {
  requirePositionals(parsed, 2, LIVE_USAGE);
  const [liveId, beeId] = parsed.positionals;
  const input = parsed.flags.get('--input');
  if (input === undefined) {
    throw new CliUsageError(LIVE_USAGE);
  }
  const token = parsed.flags.get('--token');
  return {
    ...common,
    kind,
    liveId: requireValue(liveId, 'liveId'),
    beeId: requireValue(beeId, 'beeId'),
    input,
    ...(token === undefined ? {} : { token }),
  };
}

function parseSimpleCommand(
  kind: 'save' | 'unload' | 'inspect',
  parsed: ParsedCliTokens,
  common: LiveCommon,
): LiveCommand {
  requirePositionals(parsed, 1, LIVE_USAGE);
  return { ...common, kind, liveId: requirePositionalsValue(parsed) };
}

function parseMigrateCommand(parsed: ParsedCliTokens, common: LiveCommon): LiveCommand {
  requirePositionals(parsed, 2, LIVE_USAGE);
  const [liveId, file] = parsed.positionals;
  return {
    ...common,
    kind: 'migrate',
    liveId: requireValue(liveId, 'liveId'),
    file: requireValue(file, 'live file'),
  };
}

async function executeLive(
  client: LiveHiveClient,
  command: LiveCommand,
  json: boolean,
  out: Writer,
  err: Writer,
): Promise<number> {
  switch (command.kind) {
    case 'list':
      return executeList(client, json, out);
    case 'new':
      return executeNew(client, command, json, out);
    case 'load':
      return executeLoad(client, command, json, out);
    case 'instantiate':
      return executeInstantiate(client, command, json, out);
    case 'wake':
    case 'answer':
      return executeRun(client, command, json, out);
    case 'save':
      return executeSave(client, command, json, out);
    case 'unload':
      return executeUnload(client, command, json, out, err);
    case 'migrate':
      return executeMigrate(client, command, json, out);
    case 'inspect':
      return executeInspect(client, command, json, out);
  }
}

async function executeList(
  client: LiveHiveClient,
  json: boolean,
  out: Writer,
): Promise<number> {
  const lives = await client.listLives();
  if (json) {
    writeJson(out, { lives });
  } else {
    for (const live of lives) {
      const record = live as Record<string, unknown>;
      out(`${String(record['liveId'])} ${String(record['state'])}`);
    }
  }
  return 0;
}

async function executeNew(
  client: LiveHiveClient,
  command: Extract<LiveCommand, { kind: 'new' }>,
  json: boolean,
  out: Writer,
): Promise<number> {
  return printLiveResult(await client.createLive(readLive(command.file), command.project), json, out);
}

async function executeLoad(
  client: LiveHiveClient,
  command: Extract<LiveCommand, { kind: 'load' }>,
  json: boolean,
  out: Writer,
): Promise<number> {
  return printLiveResult(
    await client.loadLive(command.liveId, command.path, command.project),
    json,
    out,
  );
}

async function executeInstantiate(
  client: LiveHiveClient,
  command: Extract<LiveCommand, { kind: 'instantiate' }>,
  json: boolean,
  out: Writer,
): Promise<number> {
  return printLiveResult(
    await client.instantiateLive(
      command.templateId,
      command.liveId,
      command.overrides,
      command.project,
    ),
    json,
    out,
  );
}

async function executeRun(
  client: LiveHiveClient,
  command: WakeAnswerCommand,
  json: boolean,
  out: Writer,
): Promise<number> {
  const result = command.kind === 'wake'
    ? await client.wake(command.liveId, command.beeId, command.input)
    : await client.answerLive(command.liveId, command.beeId, command.input, command.token);
  if (json) {
    writeJson(out, result);
  } else {
    out(JSON.stringify(result));
  }
  return 0;
}

async function executeSave(
  client: LiveHiveClient,
  command: SimpleCommand,
  json: boolean,
  out: Writer,
): Promise<number> {
  const status = await client.saveLive(command.liveId);
  if (json) {
    writeJson(out, status);
  } else {
    out(`saved ${command.liveId}`);
  }
  return 0;
}

async function executeUnload(
  client: LiveHiveClient,
  command: SimpleCommand,
  json: boolean,
  out: Writer,
  err: Writer,
): Promise<number> {
  const unloaded = await client.unloadLive(command.liveId);
  if (!unloaded) {
    err(`error: live '${command.liveId}' is not unloadable`);
    return 1;
  }
  if (json) {
    writeJson(out, { liveId: command.liveId, unloaded: true });
  } else {
    out(`unloaded ${command.liveId}`);
  }
  return 0;
}

async function executeMigrate(
  client: LiveHiveClient,
  command: Extract<LiveCommand, { kind: 'migrate' }>,
  json: boolean,
  out: Writer,
): Promise<number> {
  return printLiveResult(
    await client.migrateLive(command.liveId, readLive(command.file), command.project),
    json,
    out,
  );
}

async function executeInspect(
  client: LiveHiveClient,
  command: SimpleCommand,
  json: boolean,
  out: Writer,
): Promise<number> {
  const inspected = await client.inspect(command.liveId);
  if (json) {
    writeJson(out, inspected);
  } else {
    out(`inspected ${command.liveId}`);
  }
  return 0;
}

function printLiveResult(
  result: { readonly liveId: string; readonly status: Record<string, unknown> },
  json: boolean,
  out: Writer,
): number {
  if (json) {
    writeJson(out, result);
  } else {
    out(`${result.liveId} ${JSON.stringify(result.status)}`);
  }
  return 0;
}

function readLive(path: string): LiveHive {
  const parsed = readJsonFile(path);
  const candidate = isRecord(parsed) && isRecord(parsed['live']) ? parsed['live'] : parsed;
  return candidate as LiveHive;
}

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new LiveCliIoError(`cannot read JSON file '${path}'`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
