import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ControlServer } from '../src/control/server.js';
import type { Project } from '../src/project/kernel.js';
import { SessionRegistry } from '../src/session/session-registry.js';
import { Workspace } from '../src/session/workspace.js';
import { FakeAdapter } from './support/fake-adapter.js';
import { bOutput, bWake, liveFrom } from './support/control-server-http.js';

interface Env {
  readonly adapter: FakeAdapter;
  readonly workspace: Workspace;
  readonly registry: SessionRegistry;
  readonly project: Project;
  readonly stateRoot: string;
  readonly daemonDir: string;
}

function makeEnv(adapter: FakeAdapter): Env {
  const workspace = new Workspace(adapter);
  const project: Project = {
    id: `guard-project-${String(Date.now())}`,
    directory: mkdtempSync(join(tmpdir(), 'wax-m9d-guard-project-')),
  };
  const registry = new SessionRegistry({
    workspaces: new Map([['codex', workspace]]),
  });
  const stateRoot = mkdtempSync(join(tmpdir(), 'wax-m9d-guard-state-'));
  return {
    adapter,
    workspace,
    registry,
    project,
    stateRoot,
    daemonDir: join(stateRoot, 'waxd'),
  };
}

interface Running {
  readonly server: ControlServer;
  readonly url: string;
  readonly token: string;
}

async function start(env: Env, guardTimeoutMs?: number): Promise<Running> {
  const server = new ControlServer({
    registry: env.registry,
    stateRoot: env.stateRoot,
    apiary: 'apiary',
    daemonDir: env.daemonDir,
    liveProject: env.project,
    ...(guardTimeoutMs === undefined ? {} : { guardTimeoutMs }),
  });
  const info = await server.start();
  return { server, url: info.url, token: readFileSync(info.tokenPath, 'utf8').trim() };
}

function headers(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

async function get(running: Running, path: string): Promise<Record<string, any>> {
  const response = await fetch(`${running.url}${path}`, { headers: headers(running.token) });
  return { ...(await response.json()) as Record<string, any>, status: response.status };
}

async function post(
  running: Running,
  path: string,
  body: unknown,
): Promise<Record<string, any>> {
  const response = await fetch(`${running.url}${path}`, {
    method: 'POST',
    headers: headers(running.token),
    body: JSON.stringify(body),
  });
  return { ...(await response.json()) as Record<string, any>, status: response.status };
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

async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for guard state');
}

async function waitForGuard(
  running: Running,
  timeoutMs = 2_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const guards = (await get(running, '/guards'))['guards'] as
      | Record<string, unknown>[]
      | undefined;
    const guard = guards?.[0];
    if (guard !== undefined) {
      return guard;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for a guard');
}

test('guard decision rejects invalid, missing and unauthenticated requests', async (t) => {
  const env = makeEnv(new FakeAdapter());
  const running = await start(env);
  t.after(async () => {
    await running.server.stop();
    await env.workspace.stop();
  });

  const unauthenticated = await fetch(`${running.url}/guard/decide`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: 'missing', decision: 'allow_once' }),
  });
  assert.equal(unauthenticated.status, 401);

  assert.equal(
    (
      await post(running, '/guard/decide', {
        requestId: 'missing',
        decision: 'maybe',
      })
    ).status,
    400,
  );
  assert.equal((await post(running, '/guard/decide', [])).status, 400);
  assert.equal(
    (await post(running, '/guard/decide', { decision: 'allow_once' })).status,
    400,
  );
  assert.equal(
    (await post(running, '/guard/decide', { requestId: 'missing' })).status,
    400,
  );
  assert.equal(
    (
      await post(running, '/guard/decide', {
        requestId: 7,
        decision: 'allow_once',
      })
    ).status,
    400,
  );

  const malformed = await fetch(`${running.url}/guard/decide`, {
    method: 'POST',
    headers: headers(running.token),
    body: '{"requestId":',
  });
  assert.equal(malformed.status, 400);
});

test('a pending native approval is listed and allowed through the broker', async (t) => {
  const adapter = new FakeAdapter({ askApproval: true, output: 'approved' });
  const env = makeEnv(adapter);
  const running = await start(env);
  t.after(async () => {
    await running.server.stop();
    await env.workspace.stop();
  });

  assert.equal(
    (
      await post(running, '/lives', {
        live: liveFrom(definition('guarded'), { only: { kind: 'fresh' } }),
        project: env.project,
      })
    ).status,
    200,
  );

  const triggerPromise = bWake(running.url, running.token, 'guarded', 'only', 'go');
  await waitFor(async () => (await get(running, '/guards'))['guards'].length === 1);

  const pending = await get(running, '/guards');
  const guard = (pending['guards'] as Record<string, unknown>[])[0];
  assert.ok(guard !== undefined);
  assert.equal(typeof guard['requestId'], 'string');
  assert.equal(typeof guard['executionId'], 'string');
  assert.deepEqual(guard['options'], ['allow_once', 'reject_once']);
  assert.equal(JSON.stringify(pending).includes('run {{input}}'), false);

  const decided = await post(running, '/guard/decide', {
    requestId: guard['requestId'],
    decision: 'allow_once',
  });
  assert.equal(decided.status, 200);
  assert.equal(decided['decision'], 'allow_once');

  const trigger = await triggerPromise;
  assert.equal(trigger.status, 200);
  assert.equal(trigger.body?.['result']?.['rest'], true);
  assert.deepEqual(adapter.approvals.map((item) => item.kind), ['allow_once']);
  assert.equal((await get(running, '/guards'))['guards'].length, 0);

  // Guard is a wake modifier, not a separate RunOperation: the guarded wake
  // must still leave a durable trigger run with the output.
  const run = await bOutput(running.url, running.token, 'guarded');
  assert.equal(run.status, 200);
  assert.equal(run.body?.['operation'], 'trigger');
  assert.equal(typeof run.body?.['runId'], 'string');
  assert.deepEqual(run.body?.['outputs'], [
    { nodeId: 'only', value: { kind: 'text', text: 'approved' } },
  ]);

  // A second decision for the same request is a conflict, not a re-open.
  const duplicate = await post(running, '/guard/decide', {
    requestId: guard['requestId'],
    decision: 'reject_once',
  });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate['code'], 'conflict');
  const unknown = await post(running, '/guard/decide', {
    requestId: 'missing',
    decision: 'allow_once',
  });
  assert.equal(unknown.status, 404);
  assert.equal(unknown['code'], 'not-found');
});

test('an expired guard decision is rejected without auto-allow', async (t) => {
  const adapter = new FakeAdapter({ askApproval: true });
  const env = makeEnv(adapter);
  const running = await start(env, 500);
  t.after(async () => {
    await running.server.stop();
    await env.workspace.stop();
  });

  const loaded = await post(running, '/lives', {
    live: liveFrom(definition('expired'), { only: { kind: 'fresh' } }),
    project: env.project,
  });
  assert.equal(loaded.status, 200);

  const startedAt = Date.now();
  const wakePromise = bWake(running.url, running.token, 'expired', 'only', 'go');
  const guard = await waitForGuard(running);
  // An empty guard list means the broker already settled the request at its
  // deadline. The runtime timer fires first and notifies the broker.
  await waitFor(async () => (await get(running, '/guards'))['guards'].length === 0);
  const expiredAt = Date.now();

  const late = await post(running, '/guard/decide', {
    requestId: guard['requestId'],
    decision: 'allow_once',
  });
  assert.equal(late.status, 409);
  assert.equal(late['code'], 'guard-expired');
  assert.equal(late['ok'], false);
  t.diagnostic(
    `observed: requestId=${String(guard['requestId'])} phase=expired ` +
      `elapsedMs=${String(expiredAt - startedAt)} errorClass=${String(late['code'])}`,
  );

  const wake = await wakePromise;
  assert.equal(wake.status, 200);
  assert.deepEqual(adapter.approvals.map((item) => item.kind), ['cancelled']);
});

test('reject and timeout never auto-allow', async (t) => {
  const adapter = new FakeAdapter({ askApproval: true });
  const env = makeEnv(adapter);
  const running = await start(env, 1_000);
  t.after(async () => {
    await running.server.stop();
    await env.workspace.stop();
  });
  await post(running, '/lives', {
    live: liveFrom(definition('guarded'), { only: { kind: 'fresh' } }),
    project: env.project,
  });

  const rejectedPromise = bWake(running.url, running.token, 'guarded', 'only', 'reject');
  const rejectedGuard = await waitForGuard(running);
  assert.ok(rejectedGuard !== undefined);
  assert.equal(
    (
      await post(running, '/guard/decide', {
        requestId: rejectedGuard['requestId'],
        decision: 'reject_once',
      })
    ).status,
    200,
  );
  assert.equal((await rejectedPromise).status, 200);
  assert.deepEqual(adapter.approvals.map((item) => item.kind), ['reject_once']);

  const timedOutPromise = bWake(running.url, running.token, 'guarded', 'only', 'timeout');
  await waitFor(async () => (await get(running, '/guards'))['guards'].length === 1);
  await waitFor(async () => (await get(running, '/guards'))['guards'].length === 0);
  assert.equal((await timedOutPromise).status, 200);
  assert.deepEqual(
    adapter.approvals.map((item) => item.kind),
    ['reject_once', 'cancelled'],
  );
});
