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

test('trigger includes graphRef in the body only when it was provided', async () => {
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ ok: true, result: { graphId: 'g' } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const client = new ControlClient({
    baseUrl: 'http://127.0.0.1:4321',
    token: VALID_TOKEN,
    fetchImpl,
  });

  await client.trigger('g', 'n', { kind: 'text', text: 'x' });
  await client.trigger('g', 'n', { kind: 'text', text: 'x' }, 'C:/graphs/g.wax.json');

  assert.equal(bodies.length, 2);
  const withoutRef = bodies[0];
  const withRef = bodies[1];
  assert.ok(withoutRef !== undefined);
  assert.ok(withRef !== undefined);
  assert.equal(Object.hasOwn(withoutRef, 'graphRef'), false);
  assert.equal(withRef['graphRef'], 'C:/graphs/g.wax.json');
  assert.equal(withRef['graphId'], 'g');
  assert.equal(withRef['nodeId'], 'n');
});

test('trigger with a graphRef lazily loads the manifest graph over real HTTP', async (t) => {
  const daemon = await startDaemon(t);
  const fixture = clientManifestFixture({ graphId: 'client-lazy' });

  const result = asRecord(
    await daemon.client.trigger(
      'client-lazy',
      'only',
      { kind: 'text', text: 'client lazy input' },
      fixture.manifestPath,
    ),
  );
  assert.equal(result['graphId'], 'client-lazy');
  assert.equal(result['rest'], true);
  assert.equal(result['persisted'], true);

  const status = asRecord(await daemon.client.statusOf('client-lazy'));
  assert.equal(status['graphId'], 'client-lazy');
  assert.equal(status['rest'], true);
  assert.equal(daemon.env.registry.list().length, 1);
  assert.equal(daemon.env.adapter.prompts.length, 1);
  assert.match(daemon.env.adapter.prompts[0] ?? '', /client lazy input/);
});

test('an unloaded graph without graphRef is still a 404', async (t) => {
  const daemon = await startDaemon(t);
  await assert.rejects(
    daemon.client.trigger('missing', 'only', { kind: 'text', text: 'x' }),
    isControlError('not-found', 404),
  );
  assert.equal(daemon.env.adapter.displayNames.length, 0);
});

test('answer includes token and graphRef only when provided and is attempted exactly once', async () => {
  const bodies: Record<string, unknown>[] = [];
  let calls = 0;
  const fetchImpl: typeof fetch = async (_input, init) => {
    calls += 1;
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ ok: true, result: { graphId: 'g', rest: true } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const client = new ControlClient({
    baseUrl: 'http://127.0.0.1:4321',
    token: VALID_TOKEN,
    fetchImpl,
  });

  await client.answer({ graphId: 'g', nodeId: 'n', value: { kind: 'text', text: 'x' } });
  await client.answer({
    graphId: 'g',
    nodeId: 'n',
    value: { kind: 'text', text: 'x' },
    token: 'hv_test',
    graphRef: 'C:/graphs/g.wax.json',
  });

  assert.equal(calls, 2);
  const withoutOptional = bodies[0];
  const withOptional = bodies[1];
  assert.ok(withoutOptional !== undefined);
  assert.ok(withOptional !== undefined);
  assert.equal(Object.hasOwn(withoutOptional, 'token'), false);
  assert.equal(Object.hasOwn(withoutOptional, 'graphRef'), false);
  assert.equal(withOptional['token'], 'hv_test');
  assert.equal(withOptional['graphRef'], 'C:/graphs/g.wax.json');
  assert.equal(withOptional['graphId'], 'g');
  assert.equal(withOptional['nodeId'], 'n');

  // A network failure is reported, not retried: an answer can resolve a hover.
  let attempts = 0;
  const failing: typeof fetch = async () => {
    attempts += 1;
    throw new Error('network down');
  };
  const failingClient = new ControlClient({
    baseUrl: 'http://127.0.0.1:4321',
    token: VALID_TOKEN,
    fetchImpl: failing,
  });
  await assert.rejects(
    failingClient.answer({
      graphId: 'g',
      nodeId: 'n',
      value: { kind: 'text', text: 'x' },
    }),
    isControlError('network'),
  );
  assert.equal(attempts, 1);
});

test('answer answers an open hover over real HTTP and maps a closed hover to conflict', async (t) => {
  const daemon = await startDaemon(t);
  await daemon.client.load({
    definition: userForagerDefinition('answer-client'),
    bindings: { idle: { kind: 'fresh' } },
    project: daemon.env.project,
  });
  const trigger = asRecord(
    await daemon.client.trigger('answer-client', 'ask', { kind: 'text', text: 'waiting' }),
  );
  assert.equal(trigger['hovered'], true);
  const token = hoverTokenOf(daemon, 'answer-client', 'ask');

  await assert.rejects(
    daemon.client.answer({
      graphId: 'answer-client',
      nodeId: 'ask',
      value: { kind: 'text', text: 'wrong token body' },
      token: 'hv_wrong_token',
    }),
    (error: unknown) => {
      assert.equal(isControlError('conflict', 409)(error), true);
      const message = (error as ControlClientError).message;
      assert.equal(message.includes('hv_wrong_token'), false);
      assert.equal(message.includes(token), false);
      assert.equal(message.includes('wrong token body'), false);
      return true;
    },
  );

  const answered = asRecord(
    await daemon.client.answer({
      graphId: 'answer-client',
      nodeId: 'ask',
      value: { kind: 'text', text: 'answered' },
      token,
    }),
  );
  assert.equal(answered['graphId'], 'answer-client');
  assert.equal(answered['rest'], true);
  assert.equal(answered['hovered'], false);
  assert.equal(answered['persisted'], true);

  // The hover is gone, so a second answer is a state conflict, not a queue.
  await assert.rejects(
    daemon.client.answer({
      graphId: 'answer-client',
      nodeId: 'ask',
      value: { kind: 'text', text: 'again' },
    }),
    isControlError('conflict', 409),
  );
  assert.equal(daemon.env.adapter.displayNames.length, 1);
});

test('answer with a graphRef lazily loads the manifest and restores a flushed hover', async (t) => {
  const daemon = await startDaemon(t, {}, { allowHoverUnload: true });
  const composition = userForagerDefinition('answer-lazy-client');
  const bindings = { idle: { kind: 'fresh' } };
  const fixture = clientManifestFixture({
    graphId: 'answer-lazy-client',
    composition,
    bindings,
  });

  await daemon.client.load({
    definition: composition,
    bindings,
    project: daemon.env.project,
  });
  await daemon.client.trigger('answer-lazy-client', 'ask', {
    kind: 'text',
    text: 'waiting',
  });
  assert.equal(await daemon.client.unload('answer-lazy-client'), true);
  // The unload retains the session; the list still shows it, unbound.
  assert.equal(daemon.env.registry.list().length, 1);
  assert.equal(daemon.env.adapter.displayNames.length, 1);

  const answered = asRecord(
    await daemon.client.answer({
      graphId: 'answer-lazy-client',
      nodeId: 'ask',
      value: { kind: 'text', text: 'answered' },
      graphRef: fixture.manifestPath,
    }),
  );
  assert.equal(answered['graphId'], 'answer-lazy-client');
  assert.equal(answered['rest'], true);
  assert.equal(answered['hovered'], false);
  assert.equal(answered['persisted'], true);
  assert.equal(daemon.env.adapter.displayNames.length, 2);
  assert.equal(daemon.env.adapter.prompts.length, 0);
  // The retained session and the reload's replacement are both registered.
  assert.equal(daemon.env.registry.list().length, 2);
});

test('sweepSessions closes orphan sessions over real HTTP and skips bound ones', async (t) => {
  const clock = new FakeClock(1_000);
  const daemon = await startDaemon(
    t,
    {},
    { sessionIdleTtlMs: 1_000 },
    () => new Date(clock.time).toISOString(),
  );

  const definition = foragerDefinition('client-sweep', `run {{input}} ${PROMPT_MARKER}`);
  await daemon.client.load({
    definition,
    bindings: { only: { kind: 'fresh' } },
    project: daemon.env.project,
  });
  const record = daemon.env.registry.list()[0];
  assert.ok(record !== undefined);
  assert.equal(record.lastAccessAt, new Date(1_000).toISOString());

  // Bound to a loaded graph: excluded, never closed.
  clock.advance(1_500);
  assert.deepEqual(await daemon.client.sweepSessions(), {
    closed: [],
    skipped: [record.sessionId],
    failed: [],
  });
  assert.ok(daemon.env.registry.get(record.sessionId) !== undefined);

  // Unloading makes it an orphan; the next sweep closes it.
  assert.equal(await daemon.client.unload('client-sweep'), true);
  assert.deepEqual(await daemon.client.sweepSessions(), {
    closed: [record.sessionId],
    skipped: [],
    failed: [],
  });
  assert.equal(daemon.env.registry.get(record.sessionId), undefined);
  assert.deepEqual(await daemon.client.listSessions(), []);
  // Nothing left: a repeated sweep is an empty report, never a retry/error.
  assert.deepEqual(await daemon.client.sweepSessions(), {
    closed: [],
    skipped: [],
    failed: [],
  });
});

test('sweepSessions is one POST with an empty object and no retry', async (t) => {
  let calls = 0;
  let method: string | undefined;
  let url: string | undefined;
  let body = '';
  const raw = await startRawServer((request, response) => {
    calls += 1;
    method = request.method;
    url = request.url;
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      body = Buffer.concat(chunks).toString('utf8');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          ok: true,
          report: { closed: ['a'], skipped: ['b'], failed: [{ sessionId: 'c', error: 'close failed' }] },
        }),
      );
    });
  });
  t.after(async () => {
    await raw.close();
  });

  const client = new ControlClient({ baseUrl: raw.baseUrl, token: VALID_TOKEN });
  assert.deepEqual(await client.sweepSessions(), {
    closed: ['a'],
    skipped: ['b'],
    failed: [{ sessionId: 'c', error: 'close failed' }],
  });
  assert.equal(calls, 1);
  assert.equal(method, 'POST');
  assert.equal(url, '/sessions/sweep');
  assert.deepEqual(JSON.parse(body), {});
});

test('sweepSessions rejects malformed reports as protocol errors', async (t) => {
  const malformed: unknown[] = [
    undefined,
    {},
    { closed: [], skipped: [] },
    { closed: [], skipped: [], failed: 'nope' },
    { closed: [1], skipped: [], failed: [] },
    { closed: [], skipped: [''], failed: [] },
    { closed: [], skipped: [], failed: [{}] },
    { closed: [], skipped: [], failed: [{ sessionId: 's', error: 1 }] },
    { closed: [], skipped: [], failed: [{ sessionId: 's', error: 'x'.repeat(201) }] },
  ];
  for (const report of malformed) {
    const raw = await startRawServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, report }));
    });
    try {
      const client = new ControlClient({ baseUrl: raw.baseUrl, token: VALID_TOKEN });
      await assert.rejects(client.sweepSessions(), isControlError('protocol'));
    } finally {
      // Close even when an assertion fails, so a failed case cannot leave the
      // test process alive on an open listener.
      await raw.close();
    }
  }
});
