import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import type { Project } from '../../src/project/kernel.js';
import { runWaxdCli, type WaxdStartedInfo } from '../../src/cli/waxd-cli.js';
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
      ? `Real LiveHive operations need ${missing.join(', ')}`
      : false,
  timeout: 600_000,
};

interface HttpResult {
  readonly status: number;
  readonly body: Record<string, any>;
}

type LiveRequest = (
  info: WaxdStartedInfo,
  token: string,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
) => Promise<HttpResult>;

/** Deliver one bee, then wait for its field to settle. */
async function triggerAndSettle(
  request: LiveRequest,
  info: WaxdStartedInfo,
  token: string,
  liveId: string,
  beeId: string,
  input: string,
): Promise<void> {
  const woke = await request(info, token, 'POST', '/lives/trigger', { liveId, beeId, input });
  assert.equal(woke.status, 202, JSON.stringify(woke.body));
  await waitForRest(info.url, token, liveId, 300_000);
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

async function waitFor<T>(
  probe: () => Promise<T | undefined> | T | undefined,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) {
      return value;
    }
    await delay(100);
  }
  throw new Error(`timed out waiting for ${label}`);
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
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(240_000),
  });
  const parsed = (await response.json()) as unknown;
  return {
    status: response.status,
    body: typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, any>)
      : {},
  };
}

function textOf(value: unknown): string {
  if (typeof value !== 'object' || value === null) {
    return '';
  }
  const record = value as Record<string, unknown>;
  return typeof record['text'] === 'string' ? record['text'] : '';
}

function outputsByName(body: Record<string, any>): Map<string, string> {
  const outputs = new Map<string, string>();
  for (const entry of (body['outputs'] ?? []) as Record<string, unknown>[]) {
    outputs.set(String(entry['nodeId']), textOf(entry['value']).trim());
  }
  return outputs;
}

function template(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    templateId: 'm9j-real',
    hive: {
      bees: {
        codex: {
          kind: 'forager',
          config: {
            connection: 'codex',
            prompt:
              'Pick a random integer from 1000 through 9999. ' +
              'Do not use tools. Reply with only the integer.',
          },
          outgoing: [],
          sessionMode: 'fresh_once',
        },
        dsh: {
          kind: 'forager',
          config: {
            connection: 'dsh',
            prompt:
              'Pick a random integer from 100 through 999. ' +
              'Do not use tools. Reply with only the integer.',
          },
          outgoing: [],
          sessionMode: 'fresh_once',
        },
      },
      beelines: {},
    },
    defaults: {
      codex: { harness: 'codex' },
      dsh: { harness: 'dsh' },
    },
  };
}

function readLive(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
}

test(
  'real waxd LiveHive template/instantiate/trigger/save/unload/load/migrate/dispatch',
  integrationOptions,
  async (t) => {
    if (
      dshRoot === undefined ||
      codexExe === undefined ||
      process.env.OPENCODE_API_KEY === undefined
    ) {
      throw new Error('integration environment is missing');
    }

    const stateRoot = mkdtempSync(join(tmpdir(), 'wax-m9j-state-'));
    const daemonDir = join(stateRoot, 'waxd');
    const project: Project = {
      id: 'project-m9j-live',
      directory: mkdtempSync(join(tmpdir(), 'wax-m9j-project-')),
    };
    const controller = new AbortController();
    const started = deferred<WaxdStartedInfo>();
    const stdout: string[] = [];
    const stderr: string[] = [];
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
        onStarted: (info) => started.resolve(info),
      },
    );
    run.catch(() => undefined);
    let mainError: unknown;

    try {
      const info = await withTimeout(started.promise, 180_000, 'real waxd startup');
      const token = readFileSync(info.tokenPath, 'utf8').trim();
      assert.deepEqual(info.harnesses, ['codex', 'dsh']);
      t.diagnostic('constraints: codex 4 digits 1000..9999; dsh 3 digits 100..999');

      for (const removedPath of ['/graphs', '/catalog', '/status', '/trigger']) {
        const removed = await request(info, token, 'GET', removedPath);
        assert.equal(removed.status, 404, removedPath);
      }
      for (const removedPath of ['/graphs/load', '/graphs/trigger', '/graphs/unload']) {
        const removed = await request(info, token, 'POST', removedPath, {});
        assert.equal(removed.status, 404, `POST ${removedPath}`);
      }
      t.diagnostic('legacy graph/catalog/status/trigger routes are 404 for GET and POST');

      const composed = await request(info, token, 'POST', '/templates', {
        template: template(),
      });
      assert.equal(composed.status, 200);
      assert.equal(composed.body['templateId'], 'm9j-real');

      const instantiated = await request(info, token, 'POST', '/lives/instantiate', {
        templateId: 'm9j-real',
        liveId: 'm9j-live',
        project,
      });
      assert.equal(instantiated.status, 200);
      assert.equal(instantiated.body['liveId'], 'm9j-live');

      const firstSessions = await request(info, token, 'GET', '/sessions');
      const sessionList = firstSessions.body['sessions'] as Record<string, unknown>[];
      const sessionIds = sessionList
        .map((session) => String(session['sessionId']))
        .sort();
      const sessionByHarness = new Map(
        sessionList.map((session) => [
          String(session['harness']),
          String(session['sessionId']),
        ]),
      );
      assert.equal(sessionIds.length, 2);

      for (const beeId of ['codex', 'dsh']) {
        await triggerAndSettle(request, info, token, 'm9j-live', beeId, 'go');
      }

      const inspected = await request(
        info,
        token,
        'GET',
        '/lives/m9j-live/inspect',
      );
      assert.equal(inspected.status, 200);
      assert.equal(inspected.body['status']?.['rest'], true);
      const firstOutputs = outputsByName(inspected.body);
      const firstCodex = firstOutputs.get('codex') ?? '';
      const firstDsh = firstOutputs.get('dsh') ?? '';
      assert.match(firstCodex, /^\d{4}$/);
      assert.match(firstDsh, /^\d{3}$/);
      assert.ok(Number(firstCodex) >= 1000 && Number(firstCodex) <= 9999);
      assert.ok(Number(firstDsh) >= 100 && Number(firstDsh) <= 999);
      t.diagnostic(`observed: codex=${firstCodex} (1000..9999), dsh=${firstDsh} (100..999)`);

      const saved = await request(info, token, 'POST', '/lives/save', {
        liveId: 'm9j-live',
      });
      assert.equal(saved.status, 200);
      const livePath = join(stateRoot, 'lives', 'm9j-live', 'live.json');
      assert.equal(existsSync(livePath), true);
      const persisted = readLive(livePath);
      assert.deepEqual(Object.keys(persisted['bees'] as object).sort(), ['codex', 'dsh']);
      assert.equal(persisted['liveId'], 'm9j-live');
      const persistedBindings = persisted['bindings'] as Record<string, string>;
      assert.equal(persistedBindings['codex'], sessionByHarness.get('codex'));
      assert.equal(persistedBindings['dsh'], sessionByHarness.get('dsh'));
      assert.deepEqual(
        Object.keys(persistedBindings).filter(
          (beeId) => !Object.hasOwn(persisted['bees'] as object, beeId),
        ),
        [],
      );
      assert.equal(persisted['bees']?.['codex']?.['sessionMode'], 'fresh_once');
      const freshMappings = JSON.parse(
        readFileSync(join(daemonDir, 'graph-bindings.json'), 'utf8'),
      ) as Record<string, any>;
      assert.deepEqual(
        Object.keys(freshMappings['bindings']?.['m9j-live'] as object).sort(),
        ['codex', 'dsh'],
      );

      const unloaded = await request(info, token, 'POST', '/lives/unload', {
        liveId: 'm9j-live',
      });
      assert.equal(unloaded.status, 200);
      assert.equal(unloaded.body['unloaded'], true);
      const catalogUnloaded = await request(info, token, 'GET', '/lives');
      const unloadedEntry = (catalogUnloaded.body['lives'] as Record<string, unknown>[])
        .find((entry) => entry['liveId'] === 'm9j-live');
      assert.equal(unloadedEntry?.['state'], 'unloaded');
      const unloadedInspect = await request(
        info,
        token,
        'GET',
        '/lives/m9j-live/inspect',
      );
      assert.equal(unloadedInspect.status, 200);
      assert.equal(unloadedInspect.body['status'], undefined);
      assert.deepEqual(unloadedInspect.body['outputs'], []);

      const reloaded = await request(info, token, 'POST', '/lives/load', {
        liveId: 'm9j-live',
        project,
      });
      assert.equal(reloaded.status, 200, JSON.stringify(reloaded.body));
      assert.equal(reloaded.body['liveId'], 'm9j-live');
      const reloadSessions = await request(info, token, 'GET', '/sessions');
      const reloadIds = (reloadSessions.body['sessions'] as Record<string, unknown>[])
        .map((session) => String(session['sessionId']))
        .sort();
      assert.deepEqual(reloadIds, sessionIds);

      for (const beeId of ['codex', 'dsh']) {
        await triggerAndSettle(request, info, token, 'm9j-live', beeId, 'again');
      }
      const reloadInspect = await request(
        info,
        token,
        'GET',
        '/lives/m9j-live/inspect',
      );
      const reloadOutputs = outputsByName(reloadInspect.body);
      const reloadCodex = reloadOutputs.get('codex') ?? '';
      const reloadDsh = reloadOutputs.get('dsh') ?? '';
      assert.match(reloadCodex, /^\d{4}$/);
      assert.match(reloadDsh, /^\d{3}$/);
      t.diagnostic(
        `observed after reload: codex=${reloadCodex}, dsh=${reloadDsh}`,
      );

      const current = readLive(livePath);
      const migratedHive = {
        ...current,
        bees: {
          ...(current['bees'] as Record<string, unknown>),
          codex: {
            ...((current['bees'] as Record<string, Record<string, unknown>>)['codex'] ?? {}),
            config: {
              connection: 'codex',
              prompt:
                'Pick a random integer from 10000 through 99999. ' +
                'Do not use tools. Reply with only the integer.',
            },
          },
        },
      };
      const migrated = await request(info, token, 'POST', '/lives/migrate', {
        liveId: 'm9j-live',
        hive: migratedHive,
        project,
      });
      assert.equal(migrated.status, 200);
      for (const beeId of ['codex', 'dsh']) {
        await triggerAndSettle(request, info, token, 'm9j-live', beeId, 'migrated');
      }
      const migratedInspect = await request(
        info,
        token,
        'GET',
        '/lives/m9j-live/inspect',
      );
      const migratedOutputs = outputsByName(migratedInspect.body);
      const migratedCodex = migratedOutputs.get('codex') ?? '';
      const migratedDsh = migratedOutputs.get('dsh') ?? '';
      assert.match(migratedCodex, /^\d{5}$/);
      assert.match(migratedDsh, /^\d{3}$/);
      t.diagnostic(
        `observed after migrate: codex=${migratedCodex} (10000..99999), dsh=${migratedDsh}`,
      );

      const sessionsBeforeDispatch = new Set(sessionIds);
      const dispatched = await request(info, token, 'POST', '/dispatch', {
        input:
          'Pick a random integer from 100000 through 999999. ' +
          'Do not use tools. Reply with only the integer.',
        sessionParams: { harness: 'dsh' },
        project,
      });
      // D1: dispatch accepts a delivery; it never returns the model output.
      assert.equal(dispatched.status, 202, JSON.stringify(dispatched.body));
      assert.equal(dispatched.body['ok'], true);
      for (const removed of ['output', 'sessionId', 'runId', 'traceId']) {
        assert.equal(dispatched.body[removed], undefined, removed);
      }
      const sessionsAfterDispatch = await request(info, token, 'GET', '/sessions');
      const dispatchSession = (
        sessionsAfterDispatch.body['sessions'] as Record<string, unknown>[]
      ).find(
        (session) =>
          session['harness'] === 'dsh' &&
          !sessionsBeforeDispatch.has(String(session['sessionId'])),
      );
      assert.ok(dispatchSession !== undefined, 'dispatch did not create a dsh session');
      const dispatchSessionId = String(dispatchSession['sessionId']);
      // The temporary bee runs through the same session path; wait for it to
      // settle (its output is not exposed by design).
      await delay(1_000);
      await waitFor(async () => {
        const listed = await request(info, token, 'GET', '/sessions');
        const current = (listed.body['sessions'] as Record<string, unknown>[]).find(
          (session) => session['sessionId'] === dispatchSessionId,
        );
        return current?.['busy'] === false ? true : undefined;
      }, 180_000, 'dispatch session to become idle');
      const ephemeralEntry = (
        (await request(info, token, 'GET', '/lives')).body['lives'] as Record<string, unknown>[]
      ).find((entry) => entry['liveId'] !== 'm9j-live');
      assert.equal(ephemeralEntry, undefined, 'dispatch leaked an ephemeral LiveHive');
      t.diagnostic(
        `observed dispatch: 202 accepted, session harness=dsh, no output/sessionId returned`,
      );

      const finalUnload = await request(info, token, 'POST', '/lives/unload', {
        liveId: 'm9j-live',
      });
      assert.equal(finalUnload.status, 200);
      assert.equal(finalUnload.body['unloaded'], true);
      const finalCatalog = await request(info, token, 'GET', '/lives');
      const finalEntry = (finalCatalog.body['lives'] as Record<string, unknown>[])
        .find((entry) => entry['liveId'] === 'm9j-live');
      assert.equal(finalEntry?.['state'], 'unloaded');
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
        t.diagnostic(
          `cleanup after failure: exit=${String(code)} stderr=${JSON.stringify(stderr)}`,
        );
      }
    }
  },
);
