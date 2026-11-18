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
  foragerDefinition,
  loadBody,
  collectKeys,
  assertNoSecrets,
  hoverTokenOf,
  userAnswerComposition,
  userForagerComposition,
} from './support/control-server-fixtures.js';
import {
  authHeader,
  readResponse,
  getJson,
  postJson,
  liveFrom,
  bLoad,
  withTimeout,
  freePort,
  rawGet,
  announcedButUnsentBody,
} from './support/control-server-http.js';

test('start returns loopback info, writes a random token and keeps it out of server.json', async (t) => {
  const env = makeEnv();
  t.after(async () => {
    await env.workspace.stop();
  });
  const running = await startServer(env);
  t.after(async () => {
    await running.server.stop();
  });

  const { info, token } = running;
  assert.equal(info.host, '127.0.0.1');
  assert.equal(info.url, `http://127.0.0.1:${String(info.port)}`);
  assert.ok(info.port > 0);
  assert.equal(info.pid, process.pid);
  assert.ok(Number.isFinite(Date.parse(info.startedAt)));
  assert.equal(info.tokenPath, join(env.daemonDir, 'token'));
  assert.equal(info.infoPath, join(env.daemonDir, 'server.json'));
  assert.equal(existsSync(info.tokenPath), true);
  assert.equal(existsSync(info.infoPath), true);

  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(readFileSync(info.tokenPath, 'utf8'), token);

  const infoFileText = readFileSync(info.infoPath, 'utf8');
  const infoFile = JSON.parse(infoFileText) as Record<string, unknown>;
  assert.deepEqual(Object.keys(infoFile).sort(), [
    'host',
    'pid',
    'port',
    'startedAt',
    'tokenPath',
    'url',
  ]);
  assert.equal(infoFile['url'], info.url);
  assert.equal(infoFile['host'], info.host);
  assert.equal(infoFile['port'], info.port);
  assert.equal(infoFile['pid'], process.pid);
  assert.equal(infoFile['startedAt'], info.startedAt);
  assert.equal(infoFile['tokenPath'], info.tokenPath);
  assert.equal(Object.hasOwn(infoFile, 'token'), false);
  assert.equal(infoFileText.includes(token), false);
  assert.equal(JSON.stringify(info).includes(token), false);

  const bindAddress = (running.server as unknown as { readonly server?: Server }).server?.address();
  assert.ok(bindAddress !== null && typeof bindAddress === 'object');
  assert.equal(bindAddress.address, '127.0.0.1');

  const health = await getJson(info.url, token, '/health');
  assert.equal(health.status, 200);
  assert.equal(health.body?.['ok'], true);
  assert.deepEqual(health.body?.['harnesses'], ['codex']);
  assert.equal(health.body?.['pid'], process.pid);
  assert.equal(health.body?.['startedAt'], info.startedAt);
  assert.equal(health.headers.get('cache-control'), 'no-store');
  assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
  assert.match(health.headers.get('content-type') ?? '', /^application\/json/);

  assert.deepEqual(running.server.info(), info);
});

test('requests without a valid bearer token are rejected with 401', async (t) => {
  const env = makeEnv();
  t.after(async () => {
    await env.workspace.stop();
  });
  const running = await startServer(env);
  t.after(async () => {
    await running.server.stop();
  });
  const { info, token } = running;

  const missing = await readResponse(await fetch(`${info.url}/health`));
  assert.equal(missing.status, 401);
  assert.equal(missing.body?.['ok'], false);
  assert.equal(missing.body?.['code'], 'unauthorized');
  assert.equal(missing.text.includes(token), false);
  assert.equal(missing.headers.get('cache-control'), 'no-store');
  assert.equal(missing.headers.get('x-content-type-options'), 'nosniff');

  const wrong = await readResponse(
    await fetch(`${info.url}/health`, {
      headers: { authorization: `Bearer ${token}x` },
    }),
  );
  assert.equal(wrong.status, 401);

  const wrongScheme = await readResponse(
    await fetch(`${info.url}/health`, {
      headers: { authorization: `Basic ${token}` },
    }),
  );
  assert.equal(wrongScheme.status, 401);

  const tokenInQuery = await readResponse(
    await fetch(`${info.url}/health?token=${token}`),
  );
  assert.equal(tokenInQuery.status, 401);

  const valid = await readResponse(
    await fetch(`${info.url}/health`, { headers: authHeader(token) }),
  );
  assert.equal(valid.status, 200);
});

test('invalid live objects and projects are rejected without creating sessions', async (t) => {
  const env = makeEnv();
  t.after(async () => {
    await env.workspace.stop();
  });
  const running = await startServer(env);
  t.after(async () => {
    await running.server.stop();
  });
  const { info, token } = running;

  const badDefinition = await postJson(info.url, token, '/lives', {
    live: {
      schemaVersion: 1,
      liveId: 'bad-definition',
      bees: { only: { kind: 'bogus', config: {}, outgoing: [] } },
      beelines: {},
      bindings: {},
    },
    project: env.project,
  });
  assert.equal(badDefinition.status, 400);
  assert.equal(badDefinition.body?.['code'], 'bad-request');
  assert.equal(env.registry.list().length, 0);
  assert.equal(env.adapter.displayNames.length, 0);

  const missingProjectDirectory = await bLoad(info.url, token, {
    definition: foragerDefinition('bad-project', 'bad {{input}}'),
    bindings: { only: { kind: 'fresh' } },
    project: {
      id: 'missing-project',
      directory: join(env.stateRoot, 'does-not-exist'),
    },
  });
  assert.equal(missingProjectDirectory.status, 400);
  assert.equal(env.registry.list().length, 0);
  assert.equal(env.adapter.displayNames.length, 0);
});

test('unsupported media types, malformed JSON and unknown fields are rejected', async (t) => {
  const env = makeEnv();
  t.after(async () => {
    await env.workspace.stop();
  });
  const running = await startServer(env);
  t.after(async () => {
    await running.server.stop();
  });
  const { info, token } = running;

  const wrongType = await readResponse(
    await fetch(info.url + '/lives', {
      method: 'POST',
      headers: { ...authHeader(token), 'content-type': 'text/plain' },
      body: '{}',
    }),
  );
  assert.equal(wrongType.status, 415);
  assert.equal(wrongType.body?.['code'], 'unsupported-media-type');

  const badJson = await readResponse(
    await fetch(info.url + '/lives', {
      method: 'POST',
      headers: { ...authHeader(token), 'content-type': 'application/json' },
      body: '{',
    }),
  );
  assert.equal(badJson.status, 400);
  assert.equal(badJson.body?.['code'], 'bad-request');

  const emptyBody = await readResponse(
    await fetch(info.url + '/lives', {
      method: 'POST',
      headers: { ...authHeader(token), 'content-type': 'application/json' },
    }),
  );
  assert.equal(emptyBody.status, 400);

  const topLevelArray = await readResponse(
    await fetch(info.url + '/lives', {
      method: 'POST',
      headers: { ...authHeader(token), 'content-type': 'application/json' },
      body: '[]',
    }),
  );
  assert.equal(topLevelArray.status, 400);

  const unknownLiveField = await postJson(info.url, token, '/lives', { unexpected: true });
  assert.equal(unknownLiveField.status, 400);

  const unknownTriggerField = await postJson(info.url, token, '/lives/wake', {
    liveId: 'x',
    beeId: 'y',
    input: 'z',
    extra: true,
  });
  assert.equal(unknownTriggerField.status, 400);

  const definition = foragerDefinition('unknown-fields', 'run {{input}}');
  const unknownProjectField = await postJson(info.url, token, '/lives', {
    live: liveFrom(definition, { only: { kind: 'fresh' } }),
    project: { ...env.project, extra: true },
  });
  assert.equal(unknownProjectField.status, 400);

  for (const result of [
    wrongType,
    badJson,
    emptyBody,
    topLevelArray,
    unknownLiveField,
    unknownTriggerField,
    unknownProjectField,
  ]) {
    assert.equal(Object.hasOwn(result.body ?? {}, 'stack'), false);
    assert.equal(result.text.includes(token), false);
  }
  assert.equal(env.registry.list().length, 0);
  assert.equal(env.adapter.displayNames.length, 0);
});

test('oversized bodies are rejected before the request body is sent or completed', async (t) => {
  const env = makeEnv();
  t.after(async () => {
    await env.workspace.stop();
  });
  const running = await startServer(env, { maxBodyBytes: 64 });
  t.after(async () => {
    await running.server.stop();
  });
  const { info, token } = running;

  // Content-Length alone is enough to reject. The body is never sent at all.
  const announced = await announcedButUnsentBody(info, token, 100);
  assert.equal(announced, 413);

  // A chunked streaming body has no Content-Length. The limit must be enforced
  // while reading, not after `end`.
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
      streamController.enqueue(new TextEncoder().encode('x'.repeat(256)));
    },
  });
  const init = {
    method: 'POST',
    headers: {
      ...authHeader(token),
      'content-type': 'application/json',
    },
    body: stream,
    duplex: 'half',
    signal: AbortSignal.timeout(3_000),
  } as unknown as RequestInit & { readonly duplex: 'half' };

  try {
    const response = await fetch(`${info.url}/lives/wake`, init);
    assert.equal(response.status, 413);
    const result = await readResponse(response);
    assert.equal(result.body?.['code'], 'too-large');
  } finally {
    try {
      controller?.close();
    } catch {
      // The server may already have aborted the request.
    }
  }
});

test('wrong methods return 405 and unknown or traversing paths return 404', async (t) => {
  const env = makeEnv();
  t.after(async () => {
    await env.workspace.stop();
  });
  const running = await startServer(env);
  t.after(async () => {
    await running.server.stop();
  });
  const { info, token } = running;

  const getWake = await getJson(info.url, token, '/lives/wake');
  assert.equal(getWake.status, 405);
  assert.equal(getWake.body?.['code'], 'method-not-allowed');
  assert.match(getWake.headers.get('allow') ?? '', /POST/);

  const postInspect = await postJson(info.url, token, '/lives/x/inspect', {});
  assert.equal(postInspect.status, 405);
  assert.match(postInspect.headers.get('allow') ?? '', /GET/);

  const unknown = await getJson(info.url, token, '/not-a-route');
  assert.equal(unknown.status, 404);

  const removedGraphRoute = await getJson(info.url, token, ['', 'graphs', 'load'].join('/'));
  assert.equal(removedGraphRoute.status, 404);
  const removedCatalogRoute = await getJson(info.url, token, ['', 'catalog'].join('/'));
  assert.equal(removedCatalogRoute.status, 404);

  const nested = await getJson(info.url, token, '/lives/a/b/inspect');
  assert.equal(nested.status, 404);

  const encodedTraversal = await getJson(
    info.url,
    token,
    '/lives/%2e%2e%2fhealth/inspect',
  );
  assert.equal(encodedTraversal.status, 404);

  // fetch normalizes literal `..` in a URL, so send this target over the raw
  // HTTP request to prove the server itself does not normalize it.
  const traversal = await rawGet(info, token, '/lives/../health');
  assert.equal(traversal.status, 404);
  assert.equal(traversal.text.includes('"harness"'), false);

  const health = await getJson(info.url, token, '/health');
  assert.equal(health.status, 200);
});

test('a second server on the same daemon directory is refused without touching the token', async (t) => {
  const envA = makeEnv();
  const envB = makeEnv();
  t.after(async () => {
    await envA.workspace.stop();
    await envB.workspace.stop();
  });

  const a = await startServer(envA);
  t.after(async () => {
    await a.server.stop();
  });
  const tokenBefore = a.token;
  const infoBefore = readFileSync(a.info.infoPath, 'utf8');

  const b = makeServer(envB, { daemonDir: envA.daemonDir });
  t.after(async () => {
    await b.stop();
  });
  await assert.rejects(
    b.start(),
    (error: unknown) => error instanceof DaemonLockError,
  );
  assert.equal(readFileSync(a.info.tokenPath, 'utf8'), tokenBefore);
  assert.equal(readFileSync(a.info.infoPath, 'utf8'), infoBefore);

  const stillRunning = await getJson(a.info.url, tokenBefore, '/health');
  assert.equal(stillRunning.status, 200);

  await a.server.stop();

  const bInfo = await b.start();
  assert.ok(bInfo.port > 0);
  const bToken = readFileSync(bInfo.tokenPath, 'utf8');
  const started = await getJson(bInfo.url, bToken, '/health');
  assert.equal(started.status, 200);
});

test('stop closes the port, releases the lock and removes token and info; it is idempotent', async (t) => {
  const env = makeEnv();
  t.after(async () => {
    await env.workspace.stop();
  });
  const running = await startServer(env);
  t.after(async () => {
    await running.server.stop();
  });
  const { info, token } = running;
  const lockPath = join(env.daemonDir, 'daemon.lock');

  assert.equal(existsSync(info.tokenPath), true);
  assert.equal(existsSync(info.infoPath), true);
  assert.equal(existsSync(lockPath), true);

  await running.server.stop();
  assert.equal(existsSync(info.tokenPath), false);
  assert.equal(existsSync(info.infoPath), false);
  assert.equal(existsSync(lockPath), false);
  assert.throws(() => running.server.info(), /not running/);
  await assert.rejects(fetch(`${info.url}/health`, { headers: authHeader(token) }));

  await running.server.stop();

  const env2 = makeEnv();
  t.after(async () => {
    await env2.workspace.stop();
  });
  const replacement = await startServer(env2, { daemonDir: env.daemonDir });
  t.after(async () => {
    await replacement.server.stop();
  });
  const health = await getJson(replacement.info.url, replacement.token, '/health');
  assert.equal(health.status, 200);
});

test('a failed start closes the listener, releases the lock and removes the token', async (t) => {
  const env = makeEnv();
  t.after(async () => {
    await env.workspace.stop();
  });
  const port = await freePort();
  const daemonDir = env.daemonDir;
  mkdirSync(daemonDir, { recursive: true });
  const badInfoPath = join(daemonDir, 'info-is-a-directory');
  mkdirSync(badInfoPath);

  const failing = makeServer(env, {
    daemonDir,
    port,
    infoPath: badInfoPath,
  });
  t.after(async () => {
    await failing.stop();
  });
  await assert.rejects(failing.start());
  assert.equal(existsSync(join(daemonDir, 'daemon.lock')), false);
  assert.equal(existsSync(join(daemonDir, 'token')), false);
  assert.equal(statSync(badInfoPath).isDirectory(), true);
  await failing.stop();

  const replacement = await startServer(env, { daemonDir, port });
  t.after(async () => {
    await replacement.server.stop();
  });
  const health = await getJson(replacement.info.url, replacement.token, '/health');
  assert.equal(health.status, 200);
});

test('non-loopback hosts are rejected before any file or socket exists', async (t) => {
  const env = makeEnv();
  t.after(async () => {
    await env.workspace.stop();
  });

  for (const host of ['0.0.0.0', 'localhost', '::1', '192.168.1.10']) {
    assert.throws(
      () => makeServer(env, { host: host as unknown as '127.0.0.1' }),
      /loopback|127\.0\.0\.1/i,
    );
  }
  assert.equal(existsSync(env.daemonDir), false);
});

test('the logger records only request metadata', async (t) => {
  const env = makeEnv();
  t.after(async () => {
    await env.workspace.stop();
  });
  const logs: string[] = [];
  const running = await startServer(env, { logger: (line) => logs.push(line) });
  t.after(async () => {
    await running.server.stop();
  });
  const { info, token } = running;

  const health = await getJson(info.url, token, `/health?token=${token}`);
  assert.equal(health.status, 200);

  const missing = await postJson(info.url, token, '/lives/wake', {
    liveId: 'missing',
    beeId: 'missing',
    input: INPUT_SECRET,
  });
  assert.equal(missing.status, 404);

  const unknownPath = await getJson(info.url, token, '/not-a-route');
  assert.equal(unknownPath.status, 404);

  assert.ok(logs.length >= 3);
  for (const line of logs) {
    assert.match(
      line,
      /^control method=(GET|POST) path=\S+ status=\d{3} durationMs=\d+ code=[a-z-]+$/,
    );
  }
  const joined = logs.join('\n');
  assert.equal(joined.includes(token), false);
  assert.equal(joined.includes(INPUT_SECRET), false);
  assert.equal(joined.includes('/health?token='), false);
  assert.match(joined, /method=GET path=\/health status=200/);
  assert.match(joined, /method=POST path=\/lives\/wake status=404/);
});

test('token and info files are 0600 and the daemon directory is 0700 on POSIX', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX mode bits are not meaningful on Windows');
    return;
  }
  const env = makeEnv();
  t.after(async () => {
    await env.workspace.stop();
  });
  const running = await startServer(env);
  t.after(async () => {
    await running.server.stop();
  });
  const { info } = running;

  assert.equal(statSync(info.tokenPath).mode & 0o777, 0o600);
  assert.equal(statSync(info.infoPath).mode & 0o777, 0o600);
  assert.equal(statSync(env.daemonDir).mode & 0o777, 0o700);
});
