import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { HarnessAdapter } from '../../src/adapters/harness.js';
import { createDefaultAdapter, type AdapterRequest } from '../../src/cli/cli-shared.js';
import { runWaxdCli, type WaxdStartedInfo } from '../../src/cli/waxd-cli.js';
import type { Project } from '../../src/project/kernel.js';
import { fromCompositionDefinition } from '../../src/b/live-hive-codec.js';
import type { GraphBindings } from '../../src/graph/binding.js';
import { parseComposition } from '../../src/runtime/index.js';
import { waitForRest } from '../support/control-server-http.js';

const dshRoot = process.env.DSH_ROOT;
const builtDshCli =
  dshRoot === undefined ? undefined : join(dshRoot, 'apps', 'cli', 'lib', 'bin.js');
const codexExe = process.env.CODEX_EXE;
const hasKey =
  process.env.OPENCODE_API_KEY !== undefined &&
  process.env.OPENCODE_API_KEY.trim() !== '';

const missing: string[] = [];
if (!hasKey) {
  missing.push('OPENCODE_API_KEY');
}
if (dshRoot === undefined || builtDshCli === undefined || !existsSync(builtDshCli)) {
  missing.push('DSH_ROOT with a built apps/cli/lib/bin.js');
}
if (codexExe === undefined || !existsSync(codexExe)) {
  missing.push('CODEX_EXE');
}

const integrationOptions = {
  skip:
    missing.length > 0
      ? `Real mixed-harness waxd test needs ${missing.join(', ')}`
      : false,
  timeout: 600_000,
};

interface HttpResult {
  readonly status: number;
  readonly body: Record<string, any>;
}

type MixedRequest = (
  info: WaxdStartedInfo,
  token: string,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
) => Promise<HttpResult>;

/** Deliver one bee, then wait for its field to settle. */
async function wakeAndSettle(
  request: MixedRequest,
  info: WaxdStartedInfo,
  token: string,
  liveId: string,
  beeId: string,
  input: string,
): Promise<Record<string, any>> {
  const woke = await request(info, token, 'POST', '/lives/trigger', {
    liveId,
    beeId,
    input,
  });
  assert.equal(woke.status, 202, JSON.stringify(woke.body));
  const rest = await waitForRest(info.url, token, liveId, 300_000);
  assert.ok(rest.body !== undefined, 'inspect response body is missing');
  return rest.body as Record<string, any>;
}

/** One bee's field-owned output; it is isolated per bee, not per run. */
function outputOf(run: Record<string, any>, nodeId: string): string {
  const entries = run['outputs'] as Record<string, unknown>[] | undefined;
  const entry = entries?.find((item) => item['nodeId'] === nodeId);
  return entry === undefined ? '' : textOf(entry['value']).trim();
}

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

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

async function request(
  info: WaxdStartedInfo,
  token: string,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<HttpResult> {
  const response = await fetch(`${info.url}${path}`, {
    method,
    headers: auth(token),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(240_000),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, any>,
  };
}

function graphDefinition(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: 'mixed-harness',
    nodes: {
      codex: {
        kind: 'forager',
        config: {
          connection: 'codex',
          prompt:
            'Pick a random integer from 1000 through 9999. ' +
            'Do not use tools. Reply with only the integer.',
        },
      },
      dsh: {
        kind: 'forager',
        config: {
          connection: 'dsh',
          prompt:
            'Pick a random integer from 100 through 999. ' +
            'Do not use tools. Reply with only the integer.',
        },
      },
    },
    edges: [],
  };
}

function textOf(value: unknown): string {
  if (typeof value !== 'object' || value === null) {
    return '';
  }
  const record = value as Record<string, unknown>;
  return typeof record['message'] === 'string' ? record['message'] : '';
}

function mixedLive(): Record<string, unknown> {
  return fromCompositionDefinition(parseComposition(graphDefinition()), {
    codex: { kind: 'fresh', harness: 'codex' },
    dsh: { kind: 'fresh', harness: 'dsh' },
  } as GraphBindings) as unknown as Record<string, unknown>;
}

test(
  'real waxd serves one mixed-harness graph through one endpoint and catalog',
  integrationOptions,
  async (t) => {
    if (
      dshRoot === undefined ||
      codexExe === undefined ||
      process.env.OPENCODE_API_KEY === undefined
    ) {
      throw new Error('integration environment is missing');
    }

    const stateRoot = mkdtempSync(join(tmpdir(), 'wax-m9c-state-'));
    const daemonDir = join(stateRoot, 'waxd');
    const project: Project = {
      id: 'project-mixed-host',
      directory: mkdtempSync(join(tmpdir(), 'wax-m9c-project-')),
    };
    const controller = new AbortController();
    const started = deferred<WaxdStartedInfo>();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const promptsByHarness = new Map<string, string[]>();
    const createAdapter = async (request: AdapterRequest): Promise<HarnessAdapter> => {
      const adapter = await createDefaultAdapter(request);
      const prompts: string[] = [];
      promptsByHarness.set(request.harness, prompts);
      const submit = adapter.submit.bind(adapter);
      return new Proxy(adapter, {
        get(target, property, receiver) {
          if (property === 'submit') {
            return (...args: Parameters<HarnessAdapter['submit']>) => {
              prompts.push(args[2]);
              return submit(...args);
            };
          }
          return Reflect.get(target, property, receiver) as unknown;
        },
      });
    };

    const run = runWaxdCli(
      [
        '--harnesses',
        'codex,dsh',
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
        '--codex-exe',
        codexExe,
        '--dsh-root',
        dshRoot,
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
        signal: controller.signal,
        installSignalHandlers: false,
        createAdapter,
        onStarted: (info) => started.resolve(info),
      },
    );
    run.catch(() => undefined);
    let mainError: unknown;

    try {
      const info = await withTimeout(started.promise, 180_000, 'real waxd startup');
      const token = readFileSync(info.tokenPath, 'utf8').trim();
      assert.deepEqual(info.harnesses, ['codex', 'dsh']);
      t.diagnostic(
        'constraints: codex 4 digits 1000..9999; dsh 3 digits 100..999; one endpoint',
      );

      const health = await request(info, token, 'GET', '/health');
      assert.equal(health.status, 200);
      assert.deepEqual(health.body['harnesses'], ['codex', 'dsh']);

      const loaded = await request(info, token, 'POST', '/lives', {
        live: mixedLive(),
        project,
      });
      assert.equal(loaded.status, 200);
      assert.equal(loaded.body['liveId'], 'mixed-harness');

      const codexRun = await wakeAndSettle(request, info, token, 'mixed-harness', 'codex', 'codex');
      const dshRun = await wakeAndSettle(request, info, token, 'mixed-harness', 'dsh', 'dsh');
      const codexOutput = outputOf(codexRun, 'codex');
      const dshOutput = outputOf(dshRun, 'dsh');
      assert.match(codexOutput, /^\d{4}$/);
      assert.match(dshOutput, /^\d{3}$/);
      const codexValue = Number(codexOutput);
      const dshValue = Number(dshOutput);
      assert.ok(codexValue >= 1000 && codexValue <= 9999);
      assert.ok(dshValue >= 100 && dshValue <= 999);
      t.diagnostic(`observed: codex=${codexOutput} (1000..9999), dsh=${dshOutput} (100..999)`);

      // Prove which native adapter received which prompt, not just which
      // harness label the session record carries.
      const codexPrompts = promptsByHarness.get('codex') ?? [];
      const dshPrompts = promptsByHarness.get('dsh') ?? [];
      assert.equal(codexPrompts.length, 1);
      assert.equal(dshPrompts.length, 1);
      assert.match(codexPrompts[0] ?? '', /1000 through 9999/);
      assert.match(dshPrompts[0] ?? '', /100 through 999/);
      t.diagnostic('adapter routing: codex prompt has 4-digit range; dsh prompt has 3-digit range');

      const sessions = await request(info, token, 'GET', '/sessions');
      assert.equal(sessions.status, 200);
      const summaries = sessions.body['sessions'] as Record<string, unknown>[];
      assert.deepEqual(
        summaries.map((session) => session['harness']).sort(),
        ['codex', 'dsh'],
      );
      assert.equal(
        summaries.every((session) => session['projectId'] === project.id),
        true,
      );

      const catalogLoaded = await request(info, token, 'GET', '/lives');
      assert.equal(catalogLoaded.status, 200);
      assert.equal(catalogLoaded.body['lives']?.[0]?.['state'], 'loaded');

      const unload = await request(info, token, 'POST', '/lives/unload', {
        liveId: 'mixed-harness',
      });
      assert.equal(unload.status, 200);
      const catalogUnloaded = await request(info, token, 'GET', '/lives');
      assert.equal(catalogUnloaded.body['lives']?.[0]?.['state'], 'unloaded');
      assert.equal(catalogUnloaded.body['lives']?.[0]?.['catalog']?.['lastUnloadReason'], 'unload');

      // Reload once on the same daemon; the catalog returns to loaded and the
      // same single endpoint serves it.
      const reloaded = await request(info, token, 'POST', '/lives/load', {
        liveId: 'mixed-harness',
        project,
      });
      assert.equal(reloaded.status, 200);
      const catalogReloaded = await request(info, token, 'GET', '/lives');
      assert.equal(catalogReloaded.body['lives']?.[0]?.['state'], 'loaded');

      // A reload must be usable, not merely visible in the catalog: trigger
      // both harnesses again and read the fresh outputs.
      const codexReloadRun = await wakeAndSettle(
        request,
        info,
        token,
        'mixed-harness',
        'codex',
        'codex-reload',
      );
      const dshReloadRun = await wakeAndSettle(
        request,
        info,
        token,
        'mixed-harness',
        'dsh',
        'dsh-reload',
      );
      const reloadCodex = outputOf(codexReloadRun, 'codex');
      const reloadDsh = outputOf(dshReloadRun, 'dsh');
      assert.match(reloadCodex, /^\d{4}$/);
      assert.match(reloadDsh, /^\d{3}$/);
      assert.ok(Number(reloadCodex) >= 1000 && Number(reloadCodex) <= 9999);
      assert.ok(Number(reloadDsh) >= 100 && Number(reloadDsh) <= 999);
      t.diagnostic(
        `observed after reload: codex=${reloadCodex}, dsh=${reloadDsh}`,
      );

      // Both harnesses received a second prompt after reload.
      const codexPromptsAfterReload = promptsByHarness.get('codex') ?? [];
      const dshPromptsAfterReload = promptsByHarness.get('dsh') ?? [];
      assert.equal(codexPromptsAfterReload.length, 2);
      assert.equal(dshPromptsAfterReload.length, 2);
      assert.match(codexPromptsAfterReload[1] ?? '', /1000 through 9999/);
      assert.match(dshPromptsAfterReload[1] ?? '', /100 through 999/);

      const sessionsOnDisk = JSON.parse(
        readFileSync(join(daemonDir, 'sessions.json'), 'utf8'),
      ) as Array<Record<string, unknown>>;
      assert.deepEqual(
        sessionsOnDisk.map((record) => record['harness']).sort(),
        ['codex', 'dsh'],
      );
      assert.equal(existsSync(join(daemonDir, 'codex')), false);
      assert.equal(existsSync(join(daemonDir, 'dsh')), false);
      assert.equal(existsSync(join(stateRoot, 'codex')), false);
      assert.equal(existsSync(join(stateRoot, 'dsh')), false);
    } catch (error) {
      mainError = error;
      throw error;
    } finally {
      controller.abort();
      const code = await run.catch(() => 1);
      if (mainError === undefined) {
        assert.equal(stderr.length, 0, stderr.join(' | '));
        assert.equal(code, 0);
        assert.equal(existsSync(join(daemonDir, 'token')), false);
        assert.equal(existsSync(join(daemonDir, 'server.json')), false);
        assert.equal(
          stdout.filter((line) => line.startsWith('waxd listening ')).length,
          1,
        );
      } else {
        // Do not mask the main assertion/request failure with cleanup detail.
        t.diagnostic(
          `cleanup after failure: exit=${String(code)} stderr=${JSON.stringify(stderr)}`,
        );
      }
    }
  },
);
