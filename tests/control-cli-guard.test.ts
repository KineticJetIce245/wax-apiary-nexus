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
import { bLoad, bWake } from './support/control-server-http.js';
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

async function waitForGuard(
  env: GuardEnv,
  timeoutMs = 2_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const listed = await listCli(env, ['--json']);
    if (listed.code === 0 && listed.stdout.length === 1) {
      const body = JSON.parse(listed.stdout[0] as string) as {
        guards?: Record<string, unknown>[];
      };
      const guard = body.guards?.[0];
      if (guard !== undefined) {
        return guard;
      }
    }
    await delay(20);
  }
  throw new Error('timed out waiting for a pending guard');
}

async function waitForEmptyGuardList(env: GuardEnv, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const listed = await listCli(env, ['--json']);
    if (listed.code === 0 && listed.stdout.length === 1) {
      const body = JSON.parse(listed.stdout[0] as string) as { guards?: unknown[] };
      if (Array.isArray(body.guards) && body.guards.length === 0) {
        return;
      }
    }
    await delay(20);
  }
  throw new Error('timed out waiting for an empty guard list');
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

  const listed = await listCli(env, ['--json']);
  const body = singleJson(listed);
  assert.deepEqual(Object.keys(body).sort(), ['guards']);
  const guards = body['guards'] as Record<string, unknown>[];
  assert.equal(guards.length, 1);
  const entry = guards[0];
  assert.ok(entry !== undefined);
  assert.deepEqual(Object.keys(entry).sort(), [
    'createdAt',
    'executionId',
    'options',
    'requestId',
    'summary',
  ]);
  assert.equal(entry['requestId'], guard['requestId']);
  assert.equal(entry['executionId'], guard['executionId']);
  const listedText = JSON.stringify(body);
  assert.equal(listedText.includes(promptMarker), false, 'listing leaked the prompt');
  assert.equal(listedText.includes(outputMarker), false, 'listing leaked the output');
  assert.equal(listedText.includes(env.token), false, 'listing leaked the token');
  assertNoSecret(listed.stderr, env.token);

  const human = await listCli(env);
  assert.equal(human.code, 0);
  assert.deepEqual(human.stdout, [
    `${String(entry['requestId'])} execution=${String(entry['executionId'])} ` +
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
  assert.equal(trigger.status, 200, trigger.text);
  assert.equal(trigger.body?.['result']?.['rest'], true);
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
  assert.equal(trigger.status, 200, trigger.text);
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
  await triggerPromise;

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
  assert.equal(trigger.status, 200, trigger.text);
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
