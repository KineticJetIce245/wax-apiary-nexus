import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { fromCompositionDefinition } from '../../src/b/live-hive-codec.js';
import type { LiveHive } from '../../src/b/types.js';
import { runWaxdCli, type WaxdStartedInfo } from '../../src/cli/waxd-cli.js';
import { parseComposition } from '../../src/runtime/index.js';

const dshRoot = process.env.DSH_ROOT;
const builtDshCli =
  dshRoot === undefined ? undefined : join(dshRoot, 'apps', 'cli', 'lib', 'bin.js');
const hasKey =
  process.env.OPENCODE_API_KEY !== undefined &&
  process.env.OPENCODE_API_KEY.trim() !== '';

const missing: string[] = [];
if (dshRoot === undefined || builtDshCli === undefined || !existsSync(builtDshCli)) {
  missing.push('DSH_ROOT with a built apps/cli/lib/bin.js');
}
if (!hasKey) {
  missing.push('OPENCODE_API_KEY');
}

/** Shared gate for the real DSH shutdown tests; no Codex is involved. */
export const dshIntegrationOptions = {
  skip:
    missing.length > 0
      ? `Real DSH shutdown tests need ${missing.join(', ')}`
      : false,
  timeout: 900_000,
};

export const WAXD_ENTRY = join(process.cwd(), 'dist', 'src', 'cli', 'waxd.js');

export function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let settle: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, resolve: (value: T) => settle?.(value) };
}

export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

export async function waitFor<T>(
  probe: () => Promise<T | undefined> | T | undefined,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== undefined) {
        return value;
      }
    } catch (error) {
      last = error instanceof Error ? error.name : 'probe-error';
    }
    await delay(100);
  }
  throw new Error(`timed out waiting for ${label}; last=${String(last)}`);
}

export interface HttpResult {
  readonly status: number;
  readonly body: Record<string, any>;
}

export type RequestOutcome =
  | { readonly kind: 'response'; readonly status: number; readonly body: Record<string, any> }
  | { readonly kind: 'transport-error'; readonly errorName: string };

export async function request(
  url: string,
  token: string,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<HttpResult> {
  const response = await fetch(`${url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(240_000),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, any>,
  };
}

/**
 * Poll the field until it reaches Rest or parks at a hover. There is no run
 * object: the LiveHive's own `inspect` is the execution state.
 */
export async function waitForRest(
  url: string,
  token: string,
  liveId: string,
  timeoutMs = 120_000,
): Promise<HttpResult> {
  return waitFor(async () => {
    const result = await request(
      url,
      token,
      'GET',
      `/lives/${encodeURIComponent(liveId)}/inspect`,
    );
    const status = result.body?.['status'];
    return status?.rest === true || status?.hovered === true ? result : undefined;
  }, timeoutMs, `live ${liveId} Rest`);
}

export async function requestOutcome(  url: string,
  token: string,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<RequestOutcome> {
  try {
    const result = await request(url, token, method, path, body);
    return { kind: 'response', status: result.status, body: result.body };
  } catch (error) {
    return {
      kind: 'transport-error',
      errorName: error instanceof Error ? error.name : 'unknown',
    };
  }
}

export function liveFor(liveId: string): LiveHive {
  return fromCompositionDefinition(
    parseComposition({
      schemaVersion: 1,
      id: liveId,
      nodes: {
        only: {
          kind: 'forager',
          config: { connection: 'dsh', prompt: 'run {{input}}' },
        },
      },
      edges: [],
    }),
    { only: { kind: 'fresh', harness: 'dsh' } },
  );
}

export function numberPrompt(min: number, max: number): string {
  return (
    `Pick a random integer from ${String(min)} through ${String(max)}. ` +
    'Do not use tools. Reply with only the integer.'
  );
}

export function shellWritePrompt(fileName: string, marker: string): string {
  return (
    `Use the shell tool to create a file named ${fileName} in the current directory ` +
    `with the exact content ${marker}. Report done. Do not use any other directory.`
  );
}

export function textOf(value: unknown): string {
  if (typeof value !== 'object' || value === null) {
    return '';
  }
  const record = value as Record<string, unknown>;
  return typeof record['text'] === 'string' ? record['text'] : '';
}

export function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
}

export function readToken(path: string): string {
  return readFileSync(path, 'utf8').trim();
}

/** `live-catalog.json` entries keyed by live id; `{}` when absent. */
export function catalogOnDisk(daemonDir: string): Record<string, any> {
  const path = join(daemonDir, 'live-catalog.json');
  if (!existsSync(path)) {
    return {};
  }
  const file = readJson(path);
  const entries = new Map<string, Record<string, any>>();
  for (const entry of (file['entries'] ?? []) as Record<string, unknown>[]) {
    entries.set(String(entry['liveId']), entry);
  }
  return Object.fromEntries(entries);
}

export function status500(logs: readonly string[]): string[] {
  return logs.filter((line) => line.includes('status=500'));
}

export interface InProcessDaemon {
  readonly info: WaxdStartedInfo;
  readonly controller: AbortController;
  readonly run: Promise<number>;
  readonly stdout: string[];
  readonly stderr: string[];
  readonly logs: string[];
}

export async function startInProcessDaemon(
  stateRoot: string,
  daemonDir: string,
): Promise<InProcessDaemon> {
  if (dshRoot === undefined) {
    throw new Error('DSH_ROOT is missing');
  }
  const controller = new AbortController();
  const started = deferred<WaxdStartedInfo>();
  const stdout: string[] = [];
  const stderr: string[] = [];
  const logs: string[] = [];
  const run = runWaxdCli(
    [
      '--harness',
      'dsh',
      '--dsh-root',
      dshRoot,
      '--state-root',
      stateRoot,
      '--daemon-dir',
      daemonDir,
      '--apiary',
      'apiary',
      '--port',
      '0',
      '--session-ttl-ms',
      '0',
      '--session-sweep-interval-ms',
      '0',
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      logger: (line) => logs.push(line),
      signal: controller.signal,
      installSignalHandlers: false,
      onStarted: (info) => started.resolve(info),
    },
  );
  run.catch(() => undefined);
  const info = await withTimeout(started.promise, 120_000, 'in-process waxd startup');
  return { info, controller, run, stdout, stderr, logs };
}

export async function stopInProcessDaemon(
  daemon: InProcessDaemon,
): Promise<{ readonly code: number; readonly elapsedMs: number }> {
  const startedAt = Date.now();
  daemon.controller.abort();
  const code = await withTimeout(daemon.run, 60_000, 'in-process waxd stop');
  return { code, elapsedMs: Date.now() - startedAt };
}

export interface ChildDaemon {
  readonly child: ChildProcess;
  readonly url: string;
  readonly tokenPath: string;
  readonly stdout: string[];
  readonly stderr: string[];
  readonly exit: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>;
}

/** Run the real `dist/src/cli/waxd.js` as its own OS process. */
export async function startChildDaemon(
  stateRoot: string,
  daemonDir: string,
): Promise<ChildDaemon> {
  if (dshRoot === undefined) {
    throw new Error('DSH_ROOT is missing');
  }
  const child = spawn(
    process.execPath,
    [
      WAXD_ENTRY,
      '--harness',
      'dsh',
      '--dsh-root',
      dshRoot,
      '--state-root',
      stateRoot,
      '--daemon-dir',
      daemonDir,
      '--apiary',
      'apiary',
      '--port',
      '0',
      '--session-ttl-ms',
      '0',
      '--session-sweep-interval-ms',
      '0',
    ],
    {
      env: { ...process.env, DSH_PERMISSION_MODE: 'read-only' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  const stdout: string[] = [];
  const stderr: string[] = [];
  const listening = deferred<string>();
  const tokenPath = deferred<string>();
  let buffer = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      stdout.push(line);
      const url = /^waxd listening (http:\/\/\S+)$/.exec(line);
      if (url?.[1] !== undefined) {
        listening.resolve(url[1]);
      }
      const token = /^token\s+(\S+)$/.exec(line);
      if (token?.[1] !== undefined) {
        tokenPath.resolve(token[1]);
      }
    }
  });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (line !== '') {
        stderr.push(line);
      }
    }
  });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.once('exit', (code, signal) => {
        listening.resolve('');
        tokenPath.resolve('');
        resolve({ code, signal });
      });
    },
  );
  const url = await withTimeout(listening.promise, 120_000, 'child waxd startup');
  const token = await tokenPath.promise;
  if (url === '' || token === '') {
    throw new Error(
      `child waxd exited before listening (stdoutLines=${String(stdout.length)}, ` +
        `stderrLines=${String(stderr.length)})`,
    );
  }
  return { child, url, tokenPath: token, stdout, stderr, exit };
}

/** Direct children only; enough to find the DSH ACP process under waxd. */
export function directChildPids(pid: number): number[] {
  const command =
    `Get-CimInstance Win32_Process -Filter "ParentProcessId = ${String(pid)}" ` +
    '| Select-Object -ExpandProperty ProcessId';
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', command],
    { encoding: 'utf8', windowsHide: true },
  );
  return (result.stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^\d+$/.test(line))
    .map(Number);
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function forceKillTree(pid: number | undefined): void {
  if (pid === undefined) {
    return;
  }
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
    stdio: 'ignore',
    windowsHide: true,
  });
}

export function killOrphan(pid: number): void {
  if (isAlive(pid)) {
    forceKillTree(pid);
  }
}
