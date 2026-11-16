import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';

import {
  ControlClient,
  ControlClientError,
  discoverDaemon,
  type DaemonDiscovery,
} from '../src/control/client.js';
import {
  ControlServer,
  type ControlServerInfo,
  type ControlServerOptions,
} from '../src/control/server.js';
import type { Project } from '../src/project/kernel.js';
import { SessionRegistry } from '../src/session/session-registry.js';
import { Workspace } from '../src/session/workspace.js';
import { FakeAdapter, type FakeAdapterOptions } from './support/fake-adapter.js';
import {
  FIXED_NOW,
  FakeClock,
  VALID_TOKEN,
  PROMPT_MARKER,
  OUTPUT_MARKER,
  LEAK_MARKER,
  startDaemon,
  foragerDefinition,
  userForagerDefinition,
  hoverTokenOf,
  clientManifestFixture,
  asRecord,
  isControlError,
  tempDir,
  writeInfo,
  assertDiscoveryFailure,
  startRawServer,
} from './support/control-client-fixtures.js';

test('load, status, trigger, statusOf, sweep and unload round-trip over real HTTP', async (t) => {
  const daemon = await startDaemon(t, { output: OUTPUT_MARKER });
  const project = daemon.env.project;
  const bindings = { only: { kind: 'fresh' } };

  const loaded = asRecord(
    await daemon.client.load({
      definition: foragerDefinition('main', `run {{input}} ${PROMPT_MARKER}`),
      bindings,
      project,
      idleTtlMs: 60_000,
    }),
  );
  assert.equal(loaded['graphId'], 'main');
  assert.equal(loaded['rest'], true);
  assert.equal(loaded['residency']?.['idleTtlMs'], 60_000);

  const statuses = await daemon.client.status();
  assert.equal(statuses.length, 1);
  assert.equal(asRecord(statuses[0])['graphId'], 'main');

  const triggered = asRecord(
    await daemon.client.trigger('main', 'only', {
      kind: 'text',
      text: 'client input',
    }),
  );
  assert.equal(triggered['graphId'], 'main');
  assert.equal(triggered['rest'], true);
  assert.equal(triggered['persisted'], true);
  assert.ok(Number(triggered['pumps']) >= 1);

  const current = asRecord(await daemon.client.statusOf('main'));
  assert.equal(current['graphId'], 'main');
  assert.equal(current['rest'], true);
  const nodes = current['nodes'];
  assert.ok(Array.isArray(nodes));
  assert.equal(asRecord(nodes[0])['queue'], 0);

  await daemon.client.load({
    definition: foragerDefinition('sweepme', 'sweep {{input}}'),
    bindings,
    project,
    idleTtlMs: 60_000,
  });
  const report = asRecord(await daemon.client.sweep());
  assert.deepEqual(report['unloaded'], []);
  assert.deepEqual(report['skipped'], [
    { id: 'main', reason: 'not-expired' },
    { id: 'sweepme', reason: 'not-expired' },
  ]);
  assert.deepEqual(report['failed'], []);

  assert.equal(await daemon.client.unload('main'), true);
  assert.equal(await daemon.client.statusOf('main'), undefined);
  assert.equal(await daemon.client.unload('sweepme'), true);
  assert.equal((await daemon.client.status()).length, 0);
});

test('outputs round-trips over real HTTP and maps 404 to undefined', async (t) => {
  const daemon = await startDaemon(t, { output: OUTPUT_MARKER });
  const project = daemon.env.project;
  await daemon.client.load({
    definition: foragerDefinition('main', `run {{input}} ${PROMPT_MARKER}`),
    bindings: { only: { kind: 'fresh' } },
    project,
  });

  // Loaded but never executed is an empty list, distinct from "not loaded".
  assert.deepEqual(await daemon.client.outputs('main'), []);

  await daemon.client.trigger('main', 'only', { kind: 'text', text: 'client input' });
  const outputs = await daemon.client.outputs('main');
  assert.deepEqual(outputs, [
    { nodeId: 'only', value: { kind: 'text', text: OUTPUT_MARKER } },
  ]);
  const serialized = JSON.stringify(outputs);
  assert.equal(serialized.includes(PROMPT_MARKER), false);
  assert.equal(serialized.includes(daemon.discovery.token), false);

  assert.equal(await daemon.client.outputs('missing'), undefined);
  await daemon.client.unload('main');
  // Run output is durable: unload retains the latest run's readable outputs.
  assert.deepEqual(await daemon.client.outputs('main'), [
    { nodeId: 'only', value: { kind: 'text', text: OUTPUT_MARKER } },
  ]);
});

test('outputs rejects malformed responses as protocol errors without echoing them', async (t) => {
  let calls = 0;
  let body = '';
  const raw = await startRawServer((_request, response) => {
    calls += 1;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(body);
  });
  t.after(async () => {
    await raw.close();
  });
  const client = new ControlClient({ baseUrl: raw.baseUrl, token: VALID_TOKEN });

  const malformed = [
    JSON.stringify({ ok: true, graphId: 'x', outputs: 'not-an-array' }),
    JSON.stringify({ ok: true, graphId: 'x', outputs: [{ nodeId: 'only' }] }),
    JSON.stringify({ ok: true, graphId: 'x', outputs: [{ value: 'orphan' }] }),
    JSON.stringify({ ok: true, graphId: 'x', outputs: [{ nodeId: 'only', value: 1 }, { nodeId: 'only', value: 2 }] }),
    JSON.stringify({ ok: true, graphId: 'other', outputs: [] }),
    JSON.stringify({ ok: true, graphId: 'x', outputs: [LEAK_MARKER] }),
  ];
  for (const candidate of malformed) {
    body = candidate;
    const before = calls;
    await assert.rejects(client.outputs('x'), (error: unknown) => {
      assert.ok(error instanceof ControlClientError);
      assert.equal(error.code, 'protocol');
      assert.equal(error.message.includes(LEAK_MARKER), false);
      return true;
    });
    assert.equal(calls, before + 1, 'outputs must be attempted exactly once');
  }
});

test('listSessions and closeSession round-trip and report bound/busy state', async (t) => {
  const daemon = await startDaemon(t, { output: OUTPUT_MARKER });
  assert.deepEqual(await daemon.client.listSessions(), []);

  const definition = foragerDefinition('session-client', `run {{input}} ${PROMPT_MARKER}`);
  await daemon.client.load({
    definition,
    bindings: { only: { kind: 'fresh' } },
    project: daemon.env.project,
  });
  const record = daemon.env.registry.list()[0];
  assert.ok(record !== undefined);

  const sessions = await daemon.client.listSessions();
  assert.equal(sessions.length, 1);
  assert.deepEqual(sessions[0], {
    sessionId: record.sessionId,
    harness: 'codex',
    projectId: daemon.env.project.id,
    busy: false,
    bound: true,
  });
  const serialized = JSON.stringify(sessions);
  assert.equal(serialized.includes('native-'), false);
  assert.equal(serialized.includes(daemon.env.project.directory), false);

  // Bound to a loaded graph: a typed conflict, not a close.
  await assert.rejects(
    daemon.client.closeSession(record.sessionId),
    isControlError('conflict', 409),
  );
  assert.equal(daemon.env.registry.get(record.sessionId)?.sessionId, record.sessionId);

  assert.equal(await daemon.client.unload('session-client'), true);
  const unbound = await daemon.client.listSessions();
  assert.equal(unbound.length, 1);
  assert.equal(unbound[0]?.bound, false);
  assert.equal(await daemon.client.closeSession(record.sessionId), true);
  assert.deepEqual(await daemon.client.listSessions(), []);
  assert.equal(daemon.env.registry.get(record.sessionId), undefined);
  // Closing an already-closed session is a normal false, not a retry.
  assert.equal(await daemon.client.closeSession(record.sessionId), false);
});

test('closeSession refuses a busy session while listSessions reports it', async (t) => {
  const daemon = await startDaemon(t, { askApproval: true });
  const record = await daemon.env.registry.create(daemon.env.project);
  // The fake parks on an approval request, so the execution stays active.
  await daemon.env.workspace.submit(record.sessionId, 'hold');
  assert.equal(daemon.env.workspace.isConversationBusy(record.sessionId), true);

  const sessions = await daemon.client.listSessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.busy, true);
  assert.equal(sessions[0]?.bound, false);

  await assert.rejects(daemon.client.closeSession(record.sessionId), (error: unknown) => {
    assert.ok(error instanceof ControlClientError);
    assert.equal(error.status, 409);
    assert.equal(error.code, 'conflict');
    assert.equal(error.message.includes('hold'), false);
    return true;
  });
  assert.equal(daemon.env.registry.get(record.sessionId)?.sessionId, record.sessionId);
});

test('listSessions rejects malformed summaries and never echoes a close failure body', async (t) => {
  const malformed: unknown[] = [
    {},
    { sessionId: '', harness: 'h', projectId: 'p', busy: false, bound: false },
    { sessionId: 's', harness: '', projectId: 'p', busy: false, bound: false },
    { sessionId: 's', harness: 'h', projectId: 'p', busy: 'false', bound: false },
    { sessionId: 's', harness: 'h', projectId: 'p', busy: false, bound: 1 },
    { sessionId: 'bad\u0000id', harness: 'h', projectId: 'p', busy: false, bound: false },
    { sessionId: 'x'.repeat(513), harness: 'h', projectId: 'p', busy: false, bound: false },
    'not-an-object',
  ];
  for (const entry of malformed) {
    const raw = await startRawServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, sessions: [entry] }));
    });
    const client = new ControlClient({ baseUrl: raw.baseUrl, token: VALID_TOKEN });
    await assert.rejects(
      client.listSessions(),
      isControlError('protocol'),
      JSON.stringify(entry).slice(0, 40),
    );
    await raw.close();
  }

  const raw = await startRawServer((_request, response) => {
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        ok: false,
        code: 'internal',
        error: `marker=${LEAK_MARKER} token=${VALID_TOKEN}`,
        nativeId: 'NATIVE_SECRET',
      }),
    );
  });
  t.after(async () => {
    await raw.close();
  });
  const client = new ControlClient({ baseUrl: raw.baseUrl, token: VALID_TOKEN });
  await assert.rejects(client.closeSession('session-1'), (error: unknown) => {
    assert.ok(error instanceof ControlClientError);
    assert.equal(error.status, 500);
    assert.equal(error.code, 'internal');
    for (const forbidden of [LEAK_MARKER, VALID_TOKEN, 'NATIVE_SECRET']) {
      assert.equal(error.message.includes(forbidden), false);
    }
    return true;
  });
});

test('listSessions keeps only the five documented fields', async (t) => {
  const raw = await startRawServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        ok: true,
        sessions: [
          {
            sessionId: 's1',
            harness: 'dsh',
            projectId: 'p1',
            busy: false,
            bound: true,
            nativeId: 'NATIVE_SECRET',
            projectDirectory: '/secret/dir',
            prompt: PROMPT_MARKER,
            output: OUTPUT_MARKER,
          },
        ],
      }),
    );
  });
  t.after(async () => {
    await raw.close();
  });
  const client = new ControlClient({ baseUrl: raw.baseUrl, token: VALID_TOKEN });
  const sessions = await client.listSessions();
  assert.deepEqual(sessions, [
    { sessionId: 's1', harness: 'dsh', projectId: 'p1', busy: false, bound: true },
  ]);
  assert.equal(JSON.stringify(sessions).includes('NATIVE_SECRET'), false);
});

test('closeSession validates its session id before any request', async () => {
  let calls = 0;
  const client = new ControlClient({
    baseUrl: 'http://127.0.0.1:1',
    token: VALID_TOKEN,
    fetchImpl: () => {
      calls += 1;
      return Promise.reject(new Error('unexpected fetch'));
    },
  });
  for (const value of ['', 'bad\u0000id', 'bad\u0007id', 'x'.repeat(513)]) {
    await assert.rejects(client.closeSession(value), TypeError);
  }
  await assert.rejects(
    client.closeSession(undefined as unknown as string),
    TypeError,
  );
  assert.equal(calls, 0);
});

test('a wrong token is a 401 without echoing the token', async (t) => {
  const daemon = await startDaemon(t);
  const wrongToken = `${daemon.discovery.token}wrong`;
  const client = new ControlClient({
    baseUrl: daemon.discovery.baseUrl,
    token: wrongToken,
  });

  await assert.rejects(client.health(), (error: unknown) => {
    assert.ok(error instanceof ControlClientError);
    assert.equal(error.code, 'unauthorized');
    assert.equal(error.status, 401);
    assert.equal(error.message.includes(daemon.discovery.token), false);
    assert.equal(error.message.includes(wrongToken), false);
    return true;
  });
});

test('statusOf 404 is undefined while other control failures throw', async (t) => {
  const daemon = await startDaemon(t);
  await daemon.client.load({
    definition: foragerDefinition('main', 'answer {{input}}'),
    bindings: { only: { kind: 'fresh' } },
    project: daemon.env.project,
  });

  assert.equal(await daemon.client.statusOf('missing'), undefined);

  await assert.rejects(
    daemon.client.trigger('missing', 'only', { kind: 'text', text: 'x' }),
    isControlError('not-found', 404),
  );
  await assert.rejects(
    daemon.client.unload('missing'),
    isControlError('not-found', 404),
  );
  await assert.rejects(
    daemon.client.trigger('main', 'missing-node', { kind: 'text', text: 'x' }),
    isControlError('bad-request', 400),
  );
});
