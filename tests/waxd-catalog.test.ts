import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  runWaxdCli,
  type WaxdStartedInfo,
} from '../src/cli/waxd-cli.js';
import { LiveHiveCatalog } from '../src/daemon/live-hive-catalog.js';
import type { Project } from '../src/project/kernel.js';
import { FakeAdapter } from './support/fake-adapter.js';

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let settle: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return {
    promise,
    resolve: (value: T) => {
      settle?.(value);
    },
  };
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

test('waxd stores live-catalog.json in its daemon directory', async (t) => {
  const adapter = new FakeAdapter({ output: 'ok' });
  const stateRoot = mkdtempSync(join(tmpdir(), 'wax-m9b-waxd-state-'));
  const daemonDir = join(stateRoot, 'waxd');
  const project: Project = {
    id: 'project-waxd-catalog',
    directory: mkdtempSync(join(tmpdir(), 'wax-m9b-waxd-project-')),
  };
  const controller = new AbortController();
  const started = deferred<WaxdStartedInfo>();
  const stdout: string[] = [];
  const stderr: string[] = [];

  const run = runWaxdCli(
    ['--harness', 'codex', '--state-root', stateRoot, '--daemon-dir', daemonDir],
    {
      createAdapter: async () => adapter,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      signal: controller.signal,
      installSignalHandlers: false,
      onStarted: (info) => started.resolve(info),
    },
  );

  try {
    const info = await withTimeout(started.promise, 5_000, 'waxd startup');
    const token = readFileSync(info.tokenPath, 'utf8').trim();
    const request = async (
      method: 'GET' | 'POST',
      path: string,
      body?: unknown,
    ): Promise<Response> =>
      fetch(`${info.url}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

    const loaded = await request('POST', '/graphs/load', {
      definition: {
        schemaVersion: 1,
        id: 'live',
        nodes: {
          only: {
            kind: 'forager',
            config: { connection: 'fake', prompt: 'go {{input}}' },
          },
        },
        edges: [],
      },
      bindings: { only: { kind: 'fresh' } },
      project,
    });
    assert.equal(loaded.status, 200);

    const unloaded = await request('POST', '/graphs/unload', { graphId: 'live' });
    assert.equal(unloaded.status, 200);
  } finally {
    controller.abort();
    assert.equal(await run, 0);
  }

  assert.deepEqual(stderr, []);
  assert.equal(adapter.stopCalls, 1);
  assert.equal(existsSync(infoPath(daemonDir)), true);
  const catalog = new LiveHiveCatalog(infoPath(daemonDir));
  assert.equal(catalog.get('live')?.state, 'unloaded');
  assert.equal(catalog.get('live')?.lastUnloadReason, 'unload');
  assert.deepEqual(
    stdout.filter((line) => line.startsWith('daemon ')),
    [`daemon   ${daemonDir}`],
  );
});

function infoPath(daemonDir: string): string {
  return join(daemonDir, 'live-catalog.json');
}
