import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runWaxdCli, type WaxdStartedInfo } from '../../src/cli/waxd-cli.js';
import type { Project } from '../../src/project/kernel.js';

const codexExe = process.env.CODEX_EXE;
const integrationOptions = {
  skip:
    codexExe === undefined || !existsSync(codexExe)
      ? 'Set CODEX_EXE to run the real partial/restart host tests'
      : false,
  timeout: 180_000,
};

interface RunningDaemon {
  readonly info: WaxdStartedInfo;
  readonly controller: AbortController;
  readonly run: Promise<number>;
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let settle: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, resolve: (value: T) => settle?.(value) };
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
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

async function startDaemon(
  stateRoot: string,
  daemonDir: string,
  extraArgs: readonly string[] = [],
): Promise<RunningDaemon> {
  const controller = new AbortController();
  const started = deferred<WaxdStartedInfo>();
  const stdout: string[] = [];
  const stderr: string[] = [];
  const run = runWaxdCli(
    [
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
      ...extraArgs,
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      signal: controller.signal,
      installSignalHandlers: false,
      onStarted: (info) => started.resolve(info),
    },
  );
  run.catch(() => undefined);
  const info = await withTimeout(started.promise, 60_000, 'waxd startup');
  return { info, controller, run, stdout, stderr };
}

async function stopDaemon(daemon: RunningDaemon): Promise<number> {
  daemon.controller.abort();
  return await daemon.run.catch(() => 1);
}

async function fetchJson(
  daemon: RunningDaemon,
  token: string,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ readonly status: number; readonly body: Record<string, any> }> {
  const response = await fetch(`${daemon.info.url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, any>,
  };
}

function workerDefinition(id: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id,
    nodes: {
      work: {
        kind: 'worker',
        config: {
          command: process.execPath,
          args: ['-e', 'process.stdout.write("restart-ok")'],
          cwd: '.',
          timeoutMs: 30_000,
        },
      },
    },
    edges: [],
  };
}

test(
  'real waxd keeps serving codex when dsh has a bad root',
  integrationOptions,
  async (t) => {
    if (codexExe === undefined) {
      throw new Error('CODEX_EXE is missing');
    }
    const stateRoot = mkdtempSync(join(tmpdir(), 'wax-partial-state-'));
    const daemonDir = join(stateRoot, 'waxd');
    const badDshRoot = join(stateRoot, 'missing-dsh-root');
    let daemon: RunningDaemon | undefined;
    try {
      daemon = await startDaemon(stateRoot, daemonDir, [
        '--harnesses',
        'codex,dsh',
        '--codex-exe',
        codexExe,
        '--dsh-root',
        badDshRoot,
      ]);
      assert.deepEqual(daemon.info.harnesses, ['codex']);
      const token = readFileSync(daemon.info.tokenPath, 'utf8').trim();
      const health = await fetchJson(daemon, token, 'GET', '/health');
      assert.equal(health.status, 200);
      assert.deepEqual(health.body['harnesses'], ['codex']);
      assert.equal((await fetchJson(daemon, token, 'GET', '/catalog')).status, 200);
      t.diagnostic(
        `observed partial startup: harnesses=${JSON.stringify(daemon.info.harnesses)}; ` +
          `dshRootMissing=${!existsSync(badDshRoot)}`,
      );

      assert.equal(await stopDaemon(daemon), 0);
    } finally {
      if (daemon !== undefined) {
        await stopDaemon(daemon).catch(() => undefined);
      }
    }
  },
);

test(
  'real waxd restarts on the same daemonDir/stateRoot and reloads the catalog',
  integrationOptions,
  async (t) => {
    if (codexExe === undefined) {
      throw new Error('CODEX_EXE is missing');
    }
    const stateRoot = mkdtempSync(join(tmpdir(), 'wax-restart-state-'));
    const daemonDir = join(stateRoot, 'waxd');
    const project: Project = {
      id: 'project-restart',
      directory: mkdtempSync(join(tmpdir(), 'wax-restart-project-')),
    };
    let first: RunningDaemon | undefined;
    let second: RunningDaemon | undefined;
    try {
      first = await startDaemon(stateRoot, daemonDir, [
        '--harness',
        'codex',
        '--codex-exe',
        codexExe,
      ]);
      const firstToken = readFileSync(first.info.tokenPath, 'utf8').trim();
      const loaded = await fetchJson(first, firstToken, 'POST', '/graphs/load', {
        definition: workerDefinition('restart-live'),
        bindings: {},
        project,
      });
      assert.equal(loaded.status, 200);
      const firstCatalog = await fetchJson(first, firstToken, 'GET', '/catalog');
      assert.equal(firstCatalog.body['entries']?.[0]?.['liveId'], 'restart-live');
      assert.equal(await stopDaemon(first), 0);
      first = undefined;

      second = await startDaemon(stateRoot, daemonDir, [
        '--harness',
        'codex',
        '--codex-exe',
        codexExe,
      ]);
      const secondToken = readFileSync(second.info.tokenPath, 'utf8').trim();
      const health = await fetchJson(second, secondToken, 'GET', '/health');
      assert.equal(health.status, 200);
      const catalog = await fetchJson(second, secondToken, 'GET', '/catalog');
      const entry = (catalog.body['entries'] as Record<string, unknown>[])[0];
      assert.ok(entry !== undefined);
      assert.equal(entry['liveId'], 'restart-live');
      assert.equal(entry['state'], 'unloaded');
      assert.equal(entry['lastUnloadReason'], 'dispose');
      t.diagnostic(
        `observed restart: daemonDir=${daemonDir}; catalog state=${String(entry['state'])}`,
      );
      assert.equal(await stopDaemon(second), 0);
      second = undefined;
    } finally {
      if (first !== undefined) {
        await stopDaemon(first).catch(() => undefined);
      }
      if (second !== undefined) {
        await stopDaemon(second).catch(() => undefined);
      }
    }
  },
);
