import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import type { HiveTemplate } from '../b/types.js';
import {
  ControlClientError,
  discoverDaemon,
} from '../control/client.js';
import { LiveHiveClient } from '../control/live-client.js';
import type { Project } from '../project/kernel.js';
import { CliUsageError, messageOf } from './cli-shared.js';
import type {
  ControlCliDependencies,
  ParsedCliTokens,
} from './control-cli.js';

export type Writer = (line: string) => void;

export function createClient(
  parsed: ParsedCliTokens,
  deps: ControlCliDependencies,
): LiveHiveClient {
  const daemonDir = parsed.flags.get('--daemon-dir');
  const discovery = discoverDaemon({
    ...(daemonDir === undefined ? {} : { daemonDir }),
    ...(daemonDir === undefined && deps.env !== undefined ? { env: deps.env } : {}),
  });
  return new LiveHiveClient({
    baseUrl: discovery.baseUrl,
    token: discovery.token,
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
  });
}

export function projectOf(parsed: ParsedCliTokens): Project {
  const directory = resolve(parsed.flags.get('--project') ?? process.cwd());
  return { id: basename(directory) || 'project', directory };
}

export function harnessOf(parsed: ParsedCliTokens): string | undefined {
  const value = parsed.flags.get('--harness');
  if (value === undefined) {
    return undefined;
  }
  if (value !== 'codex' && value !== 'dsh') {
    throw new CliUsageError("--harness must be 'codex' or 'dsh'");
  }
  return value;
}

export function optionalFlag(
  parsed: ParsedCliTokens,
  flag: string,
): Record<string, string> {
  const value = parsed.flags.get(flag);
  return value === undefined ? {} : { [flag.slice(2)]: value };
}

export function requirePositionals(
  parsed: ParsedCliTokens,
  count: number,
  usage: string,
): void {
  if (parsed.positionals.length !== count) {
    throw new CliUsageError(usage);
  }
}

export function requirePositionalsValue(parsed: ParsedCliTokens): string {
  return requireValue(parsed.positionals[0], 'value');
}

export function requireValue(value: string | undefined, label: string): string {
  if (value === undefined || value.trim() === '') {
    throw new CliUsageError(`missing ${label}`);
  }
  return value;
}

export function readTemplate(path: string): HiveTemplate {
  const parsed = readJsonFile(path);
  const candidate = isRecord(parsed) && isRecord(parsed['template'])
    ? parsed['template']
    : parsed;
  return candidate as HiveTemplate;
}

export function positiveInteger(raw: string): number {
  if (!/^[0-9]+$/.test(raw) || Number(raw) <= 0) {
    throw new CliUsageError('--timeout-ms must be a positive integer');
  }
  return Number(raw);
}

export function writeJson(out: Writer, value: unknown): void {
  out(JSON.stringify(value));
}

export function reportCliError(error: unknown, err: Writer): number {
  if (error instanceof CliUsageError) {
    err(error.message);
    return 2;
  }
  if (error instanceof ControlClientError) {
    err(`error: ${messageOf(error)} (code=${error.code})`);
    return 1;
  }
  err(`error: ${messageOf(error)}`);
  return 1;
}

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new CliUsageError(`cannot read JSON file '${path}'`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
