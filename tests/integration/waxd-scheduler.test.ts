import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runWaxdCli, type WaxdStartedInfo } from '../../src/cli/waxd-cli.js';
import type { Project } from '../../src/project/kernel.js';

const codexExe = process.env.CODEX_EXE;
const integrationOptions = {
  skip:
    codexExe === undefined || !existsSync(codexExe)
      ? 'Set CODEX_EXE to the Codex CLI executable to run the real scheduler host test'
      : false,
  timeout: 180_000,
};

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

async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('timed out waiting for scheduled run');
}

async function fetchJson(
  info: WaxdStartedInfo,
  token: string,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ readonly status: number; readonly body: Record<string, any> }> {
  const response = await fetch(`${info.url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(120_000),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, any>,
  };
}

test(
  'real waxd scheduler wakes a LiveHive and persists output past unload',
  integrationOptions,
  async (t) => {
    if (codexExe === undefined) {
      throw new Error('CODEX_EXE is missing');
    }

    const stateRoot = mkdtempSync(join(tmpdir(), 'wax-m9d-host-state-'));
    const daemonDir = join(stateRoot, 'waxd');
    const project: Project = {
      id: 'project-scheduler-host',
      directory: mkdtempSync(join(tmpdir(), 'wax-m9d-host-project-')),
    };
    const controller = new AbortController();
    const started = deferred<WaxdStartedInfo>();
    const stderr: string[] = [];

    const run = runWaxdCli(
      [
        '--harness',
        'codex',
        '--codex-exe',
        codexExe,
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
        stdout: () => undefined,
        stderr: (line) => stderr.push(line),
        signal: controller.signal,
        installSignalHandlers: false,
        onStarted: (info) => started.resolve(info),
      },
    );
    run.catch(() => undefined);
    let mainError: unknown;

    try {
      const info = await withTimeout(started.promise, 30_000, 'waxd startup');
      const token = readFileSync(info.tokenPath, 'utf8').trim();
      const scheduledFor = new Date(Date.now() - 1_000).toISOString();
      const definition = {
        schemaVersion: 1,
        id: 'scheduled-live',
        nodes: {
          only: {
            kind: 'forager',
            config: {
              connection: 'codex',
              prompt:
                'Pick a random integer from 1000 through 9999. ' +
                'Do not use tools. Reply with only the integer.',
            },
          },
        },
        edges: [],
        triggers: [
          { id: 'once', target: 'only', schedule: { kind: 'at', at: scheduledFor } },
        ],
      };

      const load = await fetchJson(info, token, 'POST', '/graphs/load', {
        definition,
        bindings: { only: { kind: 'fresh', harness: 'codex' } },
        project,
      });
      assert.equal(load.status, 200);

      let runId = '';
      let output = '';
      await waitFor(async () => {
        const response = await fetchJson(
          info,
          token,
          'GET',
          '/graphs/scheduled-live/output',
        );
        if (response.status !== 200) {
          return false;
        }
        const entries = response.body['outputs'] as Record<string, unknown>[];
        const value = entries[0]?.['value'] as Record<string, unknown> | undefined;
        const text = typeof value?.['text'] === 'string' ? value['text'].trim() : '';
        if (/^\d{4}$/.test(text)) {
          runId = String(response.body['runId']);
          output = text;
          return true;
        }
        return false;
      });
      assert.notEqual(runId, '');
      const numeric = Number(output);
      assert.ok(numeric >= 1000 && numeric <= 9999);
      t.diagnostic(`observed: scheduler-triggered Codex output=${output}`);

      const runFiles = readdirSync(join(daemonDir, 'runs')).filter((name) =>
        name.endsWith('.json'),
      );
      assert.ok(runFiles.includes(`${runId}.json`));
      const record = JSON.parse(
        readFileSync(join(daemonDir, 'runs', `${runId}.json`), 'utf8'),
      ) as Record<string, unknown>;
      assert.equal(record['liveId'], 'scheduled-live');
      assert.equal(record['status'], 'completed');
      assert.equal(record['operation'], 'trigger');

      const unload = await fetchJson(info, token, 'POST', '/graphs/unload', {
        graphId: 'scheduled-live',
      });
      assert.equal(unload.status, 200);
      const afterUnload = await fetchJson(
        info,
        token,
        'GET',
        `/graphs/scheduled-live/output?runId=${runId}`,
      );
      assert.equal(afterUnload.status, 200);
      const afterEntries = afterUnload.body['outputs'] as Record<string, unknown>[];
      assert.equal(
        (afterEntries[0]?.['value'] as Record<string, unknown> | undefined)?.['text'],
        output,
      );

      t.diagnostic('observed: run persisted and output readable after unload');
    } catch (error) {
      mainError = error;
      throw error;
    } finally {
      controller.abort();
      const code = await run.catch(() => 1);
      if (mainError === undefined) {
        assert.equal(code, 0);
        assert.deepEqual(stderr, []);
      } else {
        // Keep the main failure authoritative; cleanup is diagnostic only.
        t.diagnostic(
          `cleanup after failure: exit=${String(code)} stderr=${JSON.stringify(stderr)}`,
        );
      }
    }
  },
);
