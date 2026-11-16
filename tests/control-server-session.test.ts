import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { request as httpRequest, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { ConversationOptions } from '../src/adapters/harness.js';
import {
  ControlServer,
  type ControlServerInfo,
  type ControlServerOptions,
} from '../src/control/server.js';
import { DaemonLockError } from '../src/daemon/daemon-lock.js';
import type { Project } from '../src/project/kernel.js';
import {
  SessionRegistry,
  type SweepSessionsReport,
} from '../src/session/session-registry.js';
import { Workspace } from '../src/session/workspace.js';
import { FakeAdapter, type FakeAdapterOptions } from './support/fake-adapter.js';
import {
  FIXED_NOW,
  PROMPT_SECRET,
  INPUT_SECRET,
  OUTPUT_SECRET,
  FakeClock,
  makeEnv,
  makeEnvWithAdapter,
  makeServer,
  startServer,
  type TestEnv,
  foragerDefinition,
  loadBody,
  collectKeys,
  assertNoSecrets,
  hoverTokenOf,
  userAnswerComposition,
  userForagerComposition,
} from './support/control-server-fixtures.js';
import {
  GatedFakeAdapter,
  TrackingFakeAdapter,
  HoldingFakeAdapter,
  FailingCloseFakeAdapter,
  ThrowingSweepRegistry,
} from './support/control-server-adapters.js';
import { authHeader, readResponse, getJson, postJson } from './support/control-server-http.js';

test('session list exposes routing metadata and close refuses busy or bound sessions', async (t) => {
  const adapter = new HoldingFakeAdapter();
  const env = makeEnvWithAdapter(adapter);
  t.after(async () => {
    await env.workspace.stop();
  });
  const running = await startServer(env);
  t.after(async () => {
    await running.server.stop();
  });
  const { info, token } = running;

  const empty = await getJson(info.url, token, '/sessions');
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body?.['sessions'], []);

  const idle = await env.registry.create(env.project, { displayName: 'idle' });
  const busy = await env.registry.create(env.project, { displayName: 'busy' });
  // The holding fake never emits a terminal event, so the execution stays active.
  await env.workspace.submit(busy.sessionId, 'hold');
  assert.equal(env.workspace.isConversationBusy(busy.sessionId), true);

  const definition = foragerDefinition('sessions-graph', 'run {{input}}');
  const loaded = await postJson(
    info.url,
    token,
    '/graphs/load',
    loadBody(definition, env.project, { only: { kind: 'fresh' } }),
  );
  assert.equal(loaded.status, 200);
  const boundRecord = env.registry.list().find((record) => record.nativeId === 'native-3');
  assert.ok(boundRecord !== undefined);

  const list = await getJson(info.url, token, '/sessions');
  assert.equal(list.status, 200);
  const sessions = list.body?.['sessions'] as Record<string, unknown>[];
  assert.equal(sessions.length, 3);
  // Registry insertion order is preserved.
  assert.deepEqual(
    sessions.map((session) => session['sessionId']),
    [idle.sessionId, busy.sessionId, boundRecord.sessionId],
  );
  const idleSummary = sessions[0];
  assert.ok(idleSummary !== undefined);
  assert.deepEqual(Object.keys(idleSummary).sort(), [
    'bound',
    'busy',
    'harness',
    'projectId',
    'sessionId',
  ]);
  assert.deepEqual(idleSummary, {
    sessionId: idle.sessionId,
    harness: 'codex',
    projectId: env.project.id,
    busy: false,
    bound: false,
  });
  assert.equal(sessions[1]?.['busy'], true);
  assert.equal(sessions[1]?.['bound'], false);
  assert.equal(sessions[2]?.['busy'], false);
  assert.equal(sessions[2]?.['bound'], true);
  // No native id, project directory or prompt reaches the session list.
  assert.equal(list.text.includes('native-'), false);
  assert.equal(list.text.includes(env.project.directory), false);
  assert.equal(list.text.includes('projectDirectory'), false);
  assertNoSecrets(list.text, token);

  // A busy session is refused and stays registered.
  assert.equal(env.registry.isBusy(busy.sessionId), true, 'busy session lost its state');
  const busyClose = await postJson(info.url, token, '/sessions/close', {
    sessionId: busy.sessionId,
  });
  assert.equal(busyClose.status, 409, 'busy close');
  assert.equal(busyClose.body?.['code'], 'conflict');
  assert.equal(env.registry.get(busy.sessionId)?.sessionId, busy.sessionId);

  // A session bound to a loaded graph is refused and the graph stays routed.
  const boundClose = await postJson(info.url, token, '/sessions/close', {
    sessionId: boundRecord.sessionId,
  });
  assert.equal(boundClose.status, 409, 'bound close');
  assert.equal(boundClose.body?.['code'], 'conflict');
  assert.equal(env.registry.get(boundRecord.sessionId)?.sessionId, boundRecord.sessionId);
  assert.equal((await getJson(info.url, token, '/status/sessions-graph')).status, 200);

  // An idle, unbound session closes for real and disappears from the list.
  const closed = await postJson(info.url, token, '/sessions/close', {
    sessionId: idle.sessionId,
  });
  assert.equal(closed.status, 200);
  assert.equal(closed.body?.['closed'], true);
  assert.deepEqual(adapter.closedNativeIds, ['native-1']);
  assert.equal(env.registry.get(idle.sessionId), undefined);
  const afterClose = await getJson(info.url, token, '/sessions');
  const remaining = afterClose.body?.['sessions'] as Record<string, unknown>[];
  assert.equal(remaining.length, 2);
  assert.equal(
    remaining.some((session) => session['sessionId'] === idle.sessionId),
    false,
  );

  // Unknown and malformed close requests never touch a session.
  const unknown = await postJson(info.url, token, '/sessions/close', {
    sessionId: 'missing',
  });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body?.['code'], 'not-found');
  const badBodies: Record<string, unknown>[] = [
    {},
    { sessionId: '' },
    { sessionId: 'bad\u0000id' },
    { sessionId: 'bad\u0007id' },
    { sessionId: 'x'.repeat(513) },
    { sessionId: 7 },
    { sessionId: 'x', extra: true },
  ];
  for (const body of badBodies) {
    const bad = await postJson(info.url, token, '/sessions/close', body);
    assert.equal(bad.status, 400, JSON.stringify(body).slice(0, 40));
    assert.equal(bad.body?.['code'], 'bad-request');
  }
  assert.equal(env.registry.get(busy.sessionId)?.sessionId, busy.sessionId);
  assert.equal(env.registry.get(boundRecord.sessionId)?.sessionId, boundRecord.sessionId);

  const getClose = await getJson(info.url, token, '/sessions/close');
  assert.equal(getClose.status, 405);
  assert.match(getClose.headers.get('allow') ?? '', /POST/);
  const postSessions = await postJson(info.url, token, '/sessions', {});
  assert.equal(postSessions.status, 405);
  assert.match(postSessions.headers.get('allow') ?? '', /GET/);

  assertNoSecrets(
    `${busyClose.text}\n${boundClose.text}\n${closed.text}\n${unknown.text}`,
    token,
  );
  assert.equal(adapter.closedNativeIds.length, 1);
});

test('a native close failure is a static 500 and keeps the session', async (t) => {
  const adapter = new FailingCloseFakeAdapter();
  const env = makeEnvWithAdapter(adapter);
  t.after(async () => {
    await env.workspace.stop();
  });
  const running = await startServer(env);
  t.after(async () => {
    await running.server.stop();
  });
  const { info, token } = running;

  const session = await env.registry.create(env.project);
  const close = await postJson(info.url, token, '/sessions/close', {
    sessionId: session.sessionId,
  });
  assert.equal(close.status, 500);
  assert.equal(close.body?.['code'], 'internal');
  assert.equal(close.text.includes('NATIVE_CLOSE_SECRET'), false);
  assert.equal(close.body?.['error'], 'internal error');
  assert.equal(env.registry.get(session.sessionId)?.sessionId, session.sessionId);
  const list = await getJson(info.url, token, '/sessions');
  assert.equal((list.body?.['sessions'] as unknown[]).length, 1);
});

test('an unloaded graph leaves its session listable and closable', async (t) => {
  const adapter = new TrackingFakeAdapter();
  const env = makeEnvWithAdapter(adapter);
  t.after(async () => {
    await env.workspace.stop();
  });
  const running = await startServer(env);
  t.after(async () => {
    await running.server.stop();
  });
  const { info, token } = running;

  const definition = foragerDefinition('retained-session', 'run {{input}}');
  const load = await postJson(
    info.url,
    token,
    '/graphs/load',
    loadBody(definition, env.project, { only: { kind: 'fresh' } }),
  );
  assert.equal(load.status, 200);
  const session = env.registry.list()[0];
  assert.ok(session !== undefined);
  assert.equal(adapter.closedNativeIds.length, 0);

  const unload = await postJson(info.url, token, '/graphs/unload', {
    graphId: 'retained-session',
  });
  assert.equal(unload.status, 200);
  assert.deepEqual(adapter.closedNativeIds, []);

  const listed = await getJson(info.url, token, '/sessions');
  const summaries = listed.body?.['sessions'] as Record<string, unknown>[];
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0]?.['sessionId'], session.sessionId);
  assert.equal(summaries[0]?.['bound'], false);

  const closed = await postJson(info.url, token, '/sessions/close', {
    sessionId: session.sessionId,
  });
  assert.equal(closed.status, 200);
  assert.equal(closed.body?.['closed'], true);
  assert.deepEqual(adapter.closedNativeIds, ['native-1']);
  const after = await getJson(info.url, token, '/sessions');
  assert.deepEqual(after.body?.['sessions'], []);
});

test('session TTL options are validated and disabled by default', async (t) => {
  const env = makeEnv();
  t.after(async () => {
    await env.workspace.stop();
  });

  assert.throws(() => makeServer(env, { sessionIdleTtlMs: -1 }), TypeError);
  assert.throws(() => makeServer(env, { sessionIdleTtlMs: 1.5 }), TypeError);
  assert.throws(() => makeServer(env, { sessionIdleTtlMs: Number.NaN }), TypeError);
  assert.throws(() => makeServer(env, { sessionSweepIntervalMs: -1 }), TypeError);
  assert.throws(
    () => makeServer(env, { sessionIdleTtlMs: 10, sessionSweepIntervalMs: 0 }),
    TypeError,
  );
  // A zero interval is accepted when the TTL itself is disabled.
  const disabled = makeServer(env, { sessionIdleTtlMs: 0, sessionSweepIntervalMs: 0 });
  assert.equal(disabled instanceof ControlServer, true);
});

test('POST /sessions/sweep closes orphan idle sessions but never bound or busy ones', async (t) => {
  const clock = new FakeClock(1_000);
  const adapter = new HoldingFakeAdapter();
  const env = makeEnvWithAdapter(adapter, () => new Date(clock.time).toISOString());
  t.after(async () => {
    await env.workspace.stop();
  });
  const running = await startServer(env, { sessionIdleTtlMs: 1_000 });
  t.after(async () => {
    await running.server.stop();
  });
  const { info, token } = running;

  const busy = await env.registry.create(env.project);
  // The holding fake never emits a terminal event, so this stays busy.
  await env.workspace.submit(busy.sessionId, 'hold');
  const idle = await env.registry.create(env.project);

  const definition = foragerDefinition('session-sweep-graph', 'run {{input}}');
  const loaded = await postJson(
    info.url,
    token,
    '/graphs/load',
    loadBody(definition, env.project, { only: { kind: 'fresh' } }),
  );
  assert.equal(loaded.status, 200);
  const bound = env.registry.list().find((record) => record.nativeId === 'native-3');
  assert.ok(bound !== undefined);

  // Nothing is idle long enough yet: every session is skipped.
  clock.advance(500);
  const early = await postJson(info.url, token, '/sessions/sweep', {});
  assert.equal(early.status, 200);
  assert.deepEqual(early.body?.['report'], {
    closed: [],
    skipped: [busy.sessionId, idle.sessionId, bound.sessionId],
    failed: [],
  });

  clock.advance(600);
  const expired = await postJson(info.url, token, '/sessions/sweep', {});
  assert.equal(expired.status, 200);
  assert.deepEqual(expired.body?.['report'], {
    closed: [idle.sessionId],
    skipped: [busy.sessionId, bound.sessionId],
    failed: [],
  });
  // The orphan closed; the busy and graph-bound sessions survive.
  assert.equal(env.registry.get(idle.sessionId), undefined);
  assert.ok(env.registry.get(busy.sessionId) !== undefined);
  assert.ok(env.registry.get(bound.sessionId) !== undefined);
  assert.deepEqual(adapter.closedNativeIds, ['native-2']);
  // The loaded graph is untouched and its session still bound.
  assert.equal((await getJson(info.url, token, '/status/session-sweep-graph')).status, 200);

  // The explicit session list still exposes only the five documented fields.
  const list = await getJson(info.url, token, '/sessions');
  const summaries = list.body?.['sessions'] as Record<string, unknown>[];
  assert.deepEqual(Object.keys(summaries[0] ?? {}).sort(), [
    'bound',
    'busy',
    'harness',
    'projectId',
    'sessionId',
  ]);
  assert.equal(list.text.includes('lastAccessAt'), false);
  assertNoSecrets(`${early.text}\n${expired.text}`, token);

  // Malformed sweeps never reach the registry.
  const getSweep = await getJson(info.url, token, '/sessions/sweep');
  assert.equal(getSweep.status, 405);
  assert.match(getSweep.headers.get('allow') ?? '', /POST/);
  const unknownField = await postJson(info.url, token, '/sessions/sweep', { extra: true });
  assert.equal(unknownField.status, 400);
  assert.equal(unknownField.body?.['code'], 'bad-request');
});

test('the automatic session sweep closes idle sessions, is unrefed and stops with the server', async (t) => {
  const clock = new FakeClock(1_000);
  const env = makeEnvWithAdapter(new FakeAdapter(), () => new Date(clock.time).toISOString());
  t.after(async () => {
    await env.workspace.stop();
  });
  const running = await startServer(env, {
    sessionIdleTtlMs: 100,
    sessionSweepIntervalMs: 10,
  });
  t.after(async () => {
    await running.server.stop();
  });

  const timer = (running.server as unknown as { sweepTimer?: NodeJS.Timeout }).sweepTimer;
  assert.ok(timer !== undefined, 'enabled TTL must start a sweep timer');
  // Cleanup must never keep the daemon process alive.
  assert.equal(timer.hasRef(), false);

  const idle = await env.registry.create(env.project);
  clock.advance(1_000);
  const deadline = Date.now() + 2_000;
  while (env.registry.get(idle.sessionId) !== undefined && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(env.registry.get(idle.sessionId), undefined);

  await running.server.stop();
  const afterStop = (running.server as unknown as { sweepTimer?: NodeJS.Timeout }).sweepTimer;
  assert.equal(afterStop, undefined, 'stop must clear the sweep timer');
});

test('session sweep is disabled by default: no timer and a no-op manual sweep', async (t) => {
  const env = makeEnv();
  t.after(async () => {
    await env.workspace.stop();
  });
  const running = await startServer(env);
  t.after(async () => {
    await running.server.stop();
  });

  assert.equal(
    (running.server as unknown as { sweepTimer?: NodeJS.Timeout }).sweepTimer,
    undefined,
  );
  const idle = await env.registry.create(env.project);
  const sweep = await postJson(running.info.url, running.token, '/sessions/sweep', {});
  assert.equal(sweep.status, 200);
  assert.deepEqual(sweep.body?.['report'], { closed: [], skipped: [], failed: [] });
  assert.ok(env.registry.get(idle.sessionId) !== undefined);
});

test('an automatic sweep failure is metadata-only and does not crash the server', async (t) => {
  const adapter = new FakeAdapter();
  const workspace = new Workspace(adapter);
  const clock = new FakeClock(1_000);
  const registry = new ThrowingSweepRegistry({
    workspaces: new Map([['codex', workspace]]),
    now: () => new Date(clock.time).toISOString(),
  });
  const stateRoot = mkdtempSync(join(tmpdir(), 'wax-control-sweep-failure-'));
  const env: TestEnv = {
    adapter,
    workspace,
    registry,
    project: {
      id: 'project-sweep-failure',
      directory: mkdtempSync(join(tmpdir(), 'wax-control-project-')),
    },
    stateRoot,
    daemonDir: join(stateRoot, 'waxd'),
  };
  t.after(async () => {
    await workspace.stop();
  });
  const logs: string[] = [];
  const running = await startServer(env, {
    sessionIdleTtlMs: 100,
    sessionSweepIntervalMs: 10,
    logger: (line) => logs.push(line),
  });
  t.after(async () => {
    await running.server.stop();
  });

  const deadline = Date.now() + 2_000;
  while (registry.sweepCalls === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(registry.sweepCalls > 0, 'the automatic sweep never ran');

  const health = await getJson(running.info.url, running.token, '/health');
  assert.equal(health.status, 200);
  const sweepLog = logs.find((line) => line.includes('event=session-sweep-failed'));
  assert.ok(sweepLog !== undefined, `no failure metadata was logged: ${logs.join(' | ')}`);
  // Only the error name is logged; a message could carry sensitive text.
  assert.equal(sweepLog.includes('SWEEP_SECRET'), false);
  assert.match(sweepLog, /error=Error/);
});
