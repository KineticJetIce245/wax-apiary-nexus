import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { runCli } from '../src/cli/cli.js';
import { runGuardCli } from '../src/cli/guard-cli.js';
import { ControlServer } from '../src/control/server.js';
import type { Project } from '../src/project/kernel.js';
import { SessionRegistry } from '../src/session/session-registry.js';
import { Workspace } from '../src/session/workspace.js';
import { FakeAdapter, type FakeAdapterOptions } from './support/fake-adapter.js';
import { bLoad, bWake, getJson, waitForRunTerminal } from './support/control-server-http.js';
import {
  assertNoSecret,
  invokeControl,
  singleJson,
  type Invocation,
} from './support/control-cli-fixtures.js';

interface GuardEnv {
  readonly adapter: FakeAdapter;
  readonly server: ControlServer;
  readonly url: string;
  readonly token: string;
  readonly daemonDir: string;
  readonly project: Project;
}

interface GuardEnvOptions {
  readonly guardTimeoutMs?: number;
  readonly adapter?: FakeAdapterOptions;
}

async function startGuardEnv(
  t: TestContext,
  options: GuardEnvOptions = {},
): Promise<GuardEnv> {
  const adapter = new FakeAdapter({ askApproval: true, ...options.adapter });
  const workspace = new Workspace(adapter);
  const project: Project = {
    id: 'guard-cli-project',
    directory: mkdtempSync(join(tmpdir(), 'wax-cli-guard-project-')),
  };
  const registry = new SessionRegistry({
    workspaces: new Map([['codex', workspace]]),
  });
  const stateRoot = mkdtempSync(join(tmpdir(), 'wax-cli-guard-state-'));
  const daemonDir = join(stateRoot, 'waxd');
  const server = new ControlServer({
    registry,
    stateRoot,
    apiary: 'apiary',
    daemonDir,
    liveProject: project,
    ...(options.guardTimeoutMs === undefined
      ? {}
      : { guardTimeoutMs: options.guardTimeoutMs }),
  });
  const info = await server.start();
  t.after(async () => {
    await server.stop().catch(() => undefined);
    await workspace.stop().catch(() => undefined);
  });
  return {
    adapter,
    server,
    url: info.url,
    token: readFileSync(info.tokenPath, 'utf8').trim(),
    daemonDir,
    project,
  };
}

function definition(id: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id,
    nodes: {
      only: {
        kind: 'forager',
        config: { connection: 'fake', prompt: 'run {{input}}' },
      },
    },
    edges: [],
  };
}

async function loadGuardedLive(env: GuardEnv, liveId: string): Promise<void> {
  const loaded = await bLoad(env.url, env.token, {
    definition: definition(liveId),
    bindings: { only: { kind: 'fresh' } },
    liveId,
    project: env.project,
  });
  assert.equal(loaded.status, 200, loaded.text);
}

function listCli(env: GuardEnv, extra: readonly string[] = []): Promise<Invocation> {
  return invokeControl(runGuardCli, ['guard', 'list', ...extra], {
    daemonDir: env.daemonDir,
  });
}

/** The sessions the live actually bound; the guard must name one of these. */
async function sessionIds(env: GuardEnv): Promise<string[]> {
  const response = await getJson(env.url, env.token, '/sessions');
  assert.equal(response.status, 200, response.text);
  const sessions = response.body?.['sessions'] as { sessionId: string }[] | undefined;
  assert.equal(Array.isArray(sessions), true);
  return (sessions ?? []).map((session) => session.sessionId);
}

/**
 * A full-suite run can deschedule this process past a 2 s budget, which made
 * the pending-guard wait flaky (1/6 in M15a). The wait is longer, but the
 * assertions are unchanged and the failure still names the observed state.
 */
const WAIT_TIMEOUT_MS = 10_000;

async function waitForGuard(
  env: GuardEnv,
  timeoutMs = WAIT_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let lastLength = 0;
  let lastCode: number | undefined;
  while (Date.now() < deadline) {
    const listed = await listCli(env, ['--json']);
    lastCode = listed.code;
    if (listed.code === 0 && listed.stdout.length === 1) {
      const body = JSON.parse(listed.stdout[0] as string) as {
        guards?: Record<string, unknown>[];
      };
      const guards = body.guards ?? [];
      lastLength = guards.length;
      const guard = guards[0];
      if (guard !== undefined) {
        return guard;
      }
    }
    await delay(20);
  }
  throw new Error(
    `timed out waiting for a pending guard after ${String(Date.now() - startedAt)} ms ` +
      `(last CLI list length=${String(lastLength)}, ` +
      `exit=${lastCode === undefined ? 'none' : String(lastCode)})`,
  );
}

async function settleWake(
  env: GuardEnv,
  liveId: string,
  trigger: {
    readonly status: number;
    readonly text: string;
    readonly body: Record<string, any> | undefined;
  },
): Promise<void> {
  assert.equal(trigger.status, 202, trigger.text);
  assert.equal(trigger.body?.['status'], 'accepted');
  await waitForRunTerminal(env.url, env.token, liveId, String(trigger.body?.['runId']));
}

async function waitForEmptyGuardList(
  env: GuardEnv,
  timeoutMs = WAIT_TIMEOUT_MS,
): Promise<void> {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let lastLength: number | undefined;
  let lastCode: number | undefined;
  while (Date.now() < deadline) {
    const listed = await listCli(env, ['--json']);
    lastCode = listed.code;
    if (listed.code === 0 && listed.stdout.length === 1) {
      const body = JSON.parse(listed.stdout[0] as string) as { guards?: unknown[] };
      lastLength = Array.isArray(body.guards) ? body.guards.length : undefined;
      if (Array.isArray(body.guards) && body.guards.length === 0) {
        return;
      }
    }
    await delay(20);
  }
  throw new Error(
    `timed out waiting for an empty guard list after ` +
      `${String(Date.now() - startedAt)} ms ` +
      `(last CLI list length=${String(lastLength ?? 'none')}, ` +
      `exit=${lastCode === undefined ? 'none' : String(lastCode)})`,
  );
}

function countingFetch(): { readonly fetchImpl: typeof fetch; readonly calls: () => number } {
  let calls = 0;
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    return fetch(input, init);
  }) as typeof fetch;
  return { fetchImpl, calls: () => calls };
}

test('wax guard list reports an empty pending set in text and JSON', async (t) => {
  const env = await startGuardEnv(t);

  const json = await listCli(env, ['--json']);
  assert.deepEqual(singleJson(json), { guards: [] });
  assert.equal(json.stderr.length, 0);
  assertNoSecret(json.stdout, env.token);

  const text = await listCli(env);
  assert.equal(text.code, 0);
  assert.deepEqual(text.stdout, []);
  assert.equal(text.stderr.length, 0);
});

test('wax guard list prints - and omits unknown attribution instead of inventing it', async (t) => {
  const env = await startGuardEnv(t);
  const pending = {
    requestId: 'req-no-attribution',
    executionId: 'exec-no-attribution',
    summary: 'run a command',
    options: ['allow_once', 'reject_once'],
    createdAt: '2026-11-19T00:00:00.000Z',
  };
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ ok: true, guards: [pending] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;

  const json = await invokeControl(runGuardCli, ['guard', 'list', '--json'], {
    daemonDir: env.daemonDir,
    fetchImpl,
  });
  const entry = (singleJson(json)['guards'] as Record<string, unknown>[])[0];
  assert.ok(entry !== undefined);
  assert.deepEqual(Object.keys(entry).sort(), [
    'createdAt',
    'executionId',
    'options',
    'requestId',
    'summary',
  ]);
  assert.equal('liveId' in entry, false);
  assert.equal('beeId' in entry, false);
  assert.equal('sessionId' in entry, false);

  const text = await invokeControl(runGuardCli, ['guard', 'list'], {
    daemonDir: env.daemonDir,
    fetchImpl,
  });
  assert.equal(text.code, 0);
  assert.deepEqual(text.stdout, [
    'req-no-attribution live=- bee=- session=- ' +
      'execution=exec-no-attribution created=2026-11-19T00:00:00.000Z ' +
      'options=allow_once,reject_once summary=run a command',
  ]);
});

test('wax guard list shows pending metadata only and allows it once', async (t) => {
  const promptMarker = `PROMPT-SECRET-${String(Date.now())}`;
  const outputMarker = `OUTPUT-SECRET-${String(Date.now())}`;
  const env = await startGuardEnv(t, {
    adapter: { askApproval: true, output: outputMarker },
  });
  await loadGuardedLive(env, 'guarded-list');

  const triggerPromise = bWake(env.url, env.token, 'guarded-list', 'only', promptMarker);
  const guard = await waitForGuard(env);
  assert.equal(typeof guard['requestId'], 'string');
  assert.equal(typeof guard['executionId'], 'string');
  assert.equal(guard['summary'], 'run a command');
  assert.deepEqual(guard['options'], ['allow_once', 'reject_once']);
  assert.equal(typeof guard['createdAt'], 'string');
  assert.equal(Number.isNaN(Date.parse(String(guard['createdAt']))), false);
  assert.equal(guard['liveId'], 'guarded-list');
  assert.equal(guard['beeId'], 'only');
  assert.equal(typeof guard['sessionId'], 'string');
  const sessions = await sessionIds(env);
  assert.deepEqual(sessions, [guard['sessionId']]);

  const listed = await listCli(env, ['--json']);
  const body = singleJson(listed);
  assert.deepEqual(Object.keys(body).sort(), ['guards']);
  const guards = body['guards'] as Record<string, unknown>[];
  assert.equal(guards.length, 1);
  const entry = guards[0];
  assert.ok(entry !== undefined);
  assert.deepEqual(Object.keys(entry).sort(), [
    'beeId',
    'createdAt',
    'executionId',
    'liveId',
    'options',
    'requestId',
    'sessionId',
    'summary',
  ]);
  assert.equal(entry['requestId'], guard['requestId']);
  assert.equal(entry['executionId'], guard['executionId']);
  assert.equal(entry['liveId'], 'guarded-list');
  assert.equal(entry['beeId'], 'only');
  assert.equal(entry['sessionId'], sessions[0]);
  const listedText = JSON.stringify(body);
  assert.equal(listedText.includes(promptMarker), false, 'listing leaked the prompt');
  assert.equal(listedText.includes(outputMarker), false, 'listing leaked the output');
  assert.equal(listedText.includes(env.token), false, 'listing leaked the token');
  assertNoSecret(listed.stderr, env.token);

  const human = await listCli(env);
  assert.equal(human.code, 0);
  assert.deepEqual(human.stdout, [
    `${String(entry['requestId'])} live=guarded-list bee=only ` +
      `session=${String(sessions[0])} execution=${String(entry['executionId'])} ` +
      `created=${String(entry['createdAt'])} options=allow_once,reject_once ` +
      'summary=run a command',
  ]);
  assert.equal((human.stdout[0] as string).includes(promptMarker), false);
  assertNoSecret(human.stdout, env.token);

  const requestId = String(entry['requestId']);
  const decided = await invokeControl(
    runGuardCli,
    ['guard', 'decide', requestId, '--decision', 'allow_once', '--json'],
    { daemonDir: env.daemonDir },
  );
  assert.equal(decided.code, 0, decided.stderr.join(' | '));
  assert.deepEqual(singleJson(decided), { requestId, decision: 'allow_once' });
  assertNoSecret(decided.stdout, env.token);

  const trigger = await triggerPromise;
  await settleWake(env, 'guarded-list', trigger);
  assert.deepEqual(
    env.adapter.approvals.map((approval) => approval.kind),
    ['allow_once'],
  );
  await waitForEmptyGuardList(env);
});

test('wax guard decide maps reject_once to the native decision', async (t) => {
  const env = await startGuardEnv(t);
  await loadGuardedLive(env, 'guarded-reject');

  const triggerPromise = bWake(env.url, env.token, 'guarded-reject', 'only', 'go');
  const guard = await waitForGuard(env);
  const requestId = String(guard['requestId']);

  const decided = await invokeControl(
    runGuardCli,
    ['guard', 'decide', requestId, '--decision', 'reject_once'],
    { daemonDir: env.daemonDir },
  );
  assert.equal(decided.code, 0, decided.stderr.join(' | '));
  assert.deepEqual(decided.stdout, [`decided ${requestId} reject_once`]);

  const trigger = await triggerPromise;
  await settleWake(env, 'guarded-reject', trigger);
  assert.deepEqual(
    env.adapter.approvals.map((approval) => approval.kind),
    ['reject_once'],
  );
  await waitForEmptyGuardList(env);
});

test('wax guard decide maps unknown and already-settled requests without retrying', async (t) => {
  const env = await startGuardEnv(t);
  const counting = countingFetch();

  const unknown = await invokeControl(
    runGuardCli,
    ['guard', 'decide', 'missing-request', '--decision', 'allow_once'],
    { daemonDir: env.daemonDir, fetchImpl: counting.fetchImpl },
  );
  assert.equal(unknown.code, 1);
  assert.equal(unknown.stdout.length, 0);
  assert.equal(unknown.stderr.length, 1);
  assert.match(unknown.stderr[0] as string, /guard request 'missing-request' is unknown/);
  assert.equal(counting.calls(), 1, 'an unknown decision must not be retried');

  await loadGuardedLive(env, 'guarded-settled');
  const triggerPromise = bWake(env.url, env.token, 'guarded-settled', 'only', 'go');
  const guard = await waitForGuard(env);
  const requestId = String(guard['requestId']);
  const first = await invokeControl(
    runGuardCli,
    ['guard', 'decide', requestId, '--decision', 'allow_once'],
    { daemonDir: env.daemonDir },
  );
  assert.equal(first.code, 0, first.stderr.join(' | '));
  await settleWake(env, 'guarded-settled', await triggerPromise);

  const settledCount = countingFetch();
  const settled = await invokeControl(
    runGuardCli,
    ['guard', 'decide', requestId, '--decision', 'reject_once'],
    { daemonDir: env.daemonDir, fetchImpl: settledCount.fetchImpl },
  );
  assert.equal(settled.code, 1);
  assert.equal(settled.stdout.length, 0);
  assert.match(settled.stderr[0] as string, /already been settled/);
  assert.equal(settledCount.calls(), 1, 'a settled decision must not be retried');
});

test('wax guard decide explains an expired guard and never overrides it', async (t) => {
  const env = await startGuardEnv(t, { guardTimeoutMs: 500 });
  await loadGuardedLive(env, 'guarded-expired');

  const triggerPromise = bWake(env.url, env.token, 'guarded-expired', 'only', 'go');
  const guard = await waitForGuard(env);
  const requestId = String(guard['requestId']);
  await waitForEmptyGuardList(env, 10_000);

  const counting = countingFetch();
  const late = await invokeControl(
    runGuardCli,
    ['guard', 'decide', requestId, '--decision', 'allow_once'],
    { daemonDir: env.daemonDir, fetchImpl: counting.fetchImpl },
  );
  assert.equal(late.code, 1);
  assert.equal(late.stdout.length, 0);
  assert.match(late.stderr[0] as string, /guard request '.*' has expired/);
  assert.equal(counting.calls(), 1, 'an expired decision must not be retried');

  const trigger = await triggerPromise;
  await settleWake(env, 'guarded-expired', trigger);
  assert.deepEqual(
    env.adapter.approvals.map((approval) => approval.kind),
    ['cancelled'],
  );
});

test('wax guard usage errors exit 2 before discovery and --help advertises guard', async () => {
  const counting = countingFetch();
  const cases: (readonly string[])[] = [
    ['guard'],
    ['guard', 'bogus'],
    ['guard', 'list', 'extra'],
    ['guard', 'list', '--wat'],
    ['guard', 'list', '--decision', 'allow_once'],
    ['guard', 'list', '--json', '--json'],
    ['guard', 'decide'],
    ['guard', 'decide', 'request-1'],
    ['guard', 'decide', 'request-1', '--decision'],
    ['guard', 'decide', 'request-1', '--decision', 'maybe'],
    ['guard', 'decide', 'a', 'b', '--decision', 'allow_once'],
    ['guard', 'decide', 'bad\u0000id', '--decision', 'allow_once'],
    ['guard', 'decide', `${'x'.repeat(513)}`, '--decision', 'allow_once'],
  ];
  for (const argv of cases) {
    const invocation = await invokeControl(runGuardCli, argv, {
      daemonDir: join(tmpdir(), 'wax-cli-guard-missing-daemon'),
      fetchImpl: counting.fetchImpl,
    });
    assert.equal(invocation.code, 2, argv.join(' '));
    assert.equal(invocation.stdout.length, 0, argv.join(' '));
    assert.equal(invocation.stderr.length, 1, argv.join(' '));
  }
  assert.equal(counting.calls(), 0, 'usage errors must not contact a daemon');

  const helpStderr: string[] = [];
  const helpCode = await runCli(['--help'], {
    stdout: () => undefined,
    stderr: (line) => helpStderr.push(line),
    env: {},
  });
  assert.equal(helpCode, 2);
  assert.match(helpStderr[0] as string, /usage: wax <waxd\|session\|live\|wake/);
  assert.match(helpStderr[0] as string, /\|guard>/);

  const unroutedStderr: string[] = [];
  const unroutedCode = await runCli(['guard'], {
    stdout: () => undefined,
    stderr: (line) => unroutedStderr.push(line),
    env: {},
  });
  assert.equal(unroutedCode, 2);
  assert.match(unroutedStderr[0] as string, /usage: wax guard/);
});
