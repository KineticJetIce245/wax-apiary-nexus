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
import { bLoad, bUnload } from './support/control-server-http.js';
import {
  FIXED_NOW,
  FakeClock,
  VALID_TOKEN,
  foragerDefinition,
  PROMPT_MARKER,
  OUTPUT_MARKER,
  LEAK_MARKER,
  startDaemon,
  hoverTokenOf,
  asRecord,
  isControlError,
  tempDir,
  writeInfo,
  assertDiscoveryFailure,
  startRawServer,
} from './support/control-client-fixtures.js';

test('listSessions and closeSession round-trip and report bound/busy state', async (t) => {
  const daemon = await startDaemon(t, { output: OUTPUT_MARKER });
  assert.deepEqual(await daemon.client.listSessions(), []);

  const definition = foragerDefinition('session-client', `run {{input}} ${PROMPT_MARKER}`);
  const token = readFileSync(daemon.info.tokenPath, 'utf8').trim();
  assert.equal(
    (await bLoad(daemon.info.url, token, {
      definition,
      bindings: { only: { kind: 'fresh' } },
      project: daemon.env.project,
    })).status,
    200,
  );
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

  assert.equal((await bUnload(daemon.info.url, token, 'session-client')).status, 200);
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
