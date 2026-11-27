import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runWaxdCli, type WaxdStartedInfo } from '../../src/cli/waxd-cli.js';
import type { Project } from '../../src/project/kernel.js';
import { fromCompositionDefinition } from '../../src/b/live-hive-codec.js';
import { parseComposition } from '../../src/runtime/index.js';

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
  throw new Error('timed out waiting for scheduled delivery');
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

function outputText(body: Record<string, any>): string {
  const entries = body['outputs'] as Record<string, unknown>[] | undefined;
  const value = entries?.[0]?.['value'] as Record<string, unknown> | undefined;
  return typeof value?.['message'] === 'string' ? value['message'].trim() : '';
}

test(
  'real waxd scheduler delivers a LiveHive and releases field output on unload',
  integrationOptions,
  async (t) => {
    if (codexExe === undefined) {
      throw new Error('CODEX_EXE is missing');
    }

    const stateRoot = mkdtempSync(join(tmpdir(), 'wax-m9d-host-state-'));
    const daemonDir = join(stateRoot, 'waxd');
    const runsDirectory = join(daemonDir, 'runs');
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
      // M18: no run records. Startup must not create a runs/ directory.
      assert.equal(existsSync(runsDirectory), false, 'startup created a runs/ directory');

      const scheduledFor = new Date(Date.now() - 1_000).toISOString();
      const live = fromCompositionDefinition(
        parseComposition({
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
        }),
        { only: { kind: 'fresh', harness: 'codex' } },
      );
      const load = await fetchJson(info, token, 'POST', '/lives', {
        live: {
          ...live,
          schedules: [{ scheduleId: 'once', targetBee: 'only', at: scheduledFor }],
        },
        project,
      });
      assert.equal(load.status, 200);

      // The scheduler delivers into the field; the only observable result is the
      // field-owned output, with no run id and no runs/ record.
      let output = '';
      await waitFor(async () => {
        const response = await fetchJson(
          info,
          token,
          'GET',
          '/lives/scheduled-live/output',
        );
        if (response.status !== 200) {
          return false;
        }
        assert.equal(response.body['runId'], undefined);
        assert.equal(response.body['traceId'], undefined);
        const text = outputText(response.body);
        if (/^\d{4}$/.test(text)) {
          output = text;
          return true;
        }
        return false;
      });
      const numeric = Number(output);
      assert.ok(numeric >= 1000 && numeric <= 9999);
      t.diagnostic(`observed: scheduler-delivered Codex output=${output}`);

      const inspected = await fetchJson(
        info,
        token,
        'GET',
        '/lives/scheduled-live/inspect',
      );
      assert.equal(inspected.status, 200);
      assert.equal(inspected.body['status']?.['rest'], true);
      assert.equal(outputText(inspected.body), output);
      assert.equal(existsSync(runsDirectory), false, 'a run record directory was created');

      const unload = await fetchJson(info, token, 'POST', '/lives/unload', {
        liveId: 'scheduled-live',
      });
      assert.equal(unload.status, 200);

      // D2: the last output is a memory-only field cache, released by unload.
      const afterUnload = await fetchJson(
        info,
        token,
        'GET',
        '/lives/scheduled-live/output',
      );
      assert.equal(afterUnload.status, 404);
      assert.equal(afterUnload.body['ok'], false);
      assert.equal(afterUnload.body['code'], 'not-found');
      const inspectedAfterUnload = await fetchJson(
        info,
        token,
        'GET',
        '/lives/scheduled-live/inspect',
      );
      assert.equal(inspectedAfterUnload.status, 200);
      assert.deepEqual(inspectedAfterUnload.body['outputs'], []);
      assert.equal(existsSync(runsDirectory), false);

      t.diagnostic('observed: field output readable while loaded, released by unload');
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
