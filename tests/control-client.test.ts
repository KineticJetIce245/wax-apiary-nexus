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
} from '../src/control/server.js';
import type { Project } from '../src/project/kernel.js';
import { SessionRegistry } from '../src/session/session-registry.js';
import { Workspace } from '../src/session/workspace.js';
import { FakeAdapter, type FakeAdapterOptions } from './support/fake-adapter.js';

const FIXED_NOW = '2026-11-06T22:00:00.000Z';
const VALID_TOKEN = 'a'.repeat(64);
const PROMPT_MARKER = 'PROMPT_MARKER_c2a1';
const OUTPUT_MARKER = 'OUTPUT_MARKER_e4b7';
const LEAK_MARKER = 'LEAK_MARKER_8d2f';

interface TestEnv {
  readonly adapter: FakeAdapter;
  readonly workspace: Workspace;
  readonly registry: SessionRegistry;
  readonly project: Project;
  readonly stateRoot: string;
  readonly daemonDir: string;
}

interface TestDaemon {
  readonly env: TestEnv;
  readonly server: ControlServer;
  readonly info: ControlServerInfo;
  readonly discovery: DaemonDiscovery;
  readonly client: ControlClient;
}

interface RawServer {
  readonly baseUrl: string;
  close(): Promise<void>;
}

let projectSeq = 0;

function makeEnv(adapterOptions: FakeAdapterOptions = {}): TestEnv {
  const adapter = new FakeAdapter(adapterOptions);
  const workspace = new Workspace(adapter);
  projectSeq += 1;
  const project: Project = {
    id: `client-project-${String(projectSeq)}`,
    directory: mkdtempSync(join(tmpdir(), 'wax-client-project-')),
  };
  const registry = new SessionRegistry({
    workspace,
    harness: 'fake-harness',
    now: () => FIXED_NOW,
  });
  const stateRoot = mkdtempSync(join(tmpdir(), 'wax-client-state-'));
  return {
    adapter,
    workspace,
    registry,
    project,
    stateRoot,
    daemonDir: join(stateRoot, 'waxd'),
  };
}

async function startDaemon(
  t: TestContext,
  adapterOptions: FakeAdapterOptions = {},
): Promise<TestDaemon> {
  const env = makeEnv(adapterOptions);
  t.after(async () => {
    await env.workspace.stop();
  });
  const server = new ControlServer({
    workspace: env.workspace,
    registry: env.registry,
    harness: 'fake-harness',
    stateRoot: env.stateRoot,
    apiary: 'apiary',
    daemonDir: env.daemonDir,
  });
  const info = await server.start();
  t.after(async () => {
    await server.stop();
  });
  const discovery = discoverDaemon({ daemonDir: env.daemonDir });
  const client = new ControlClient({
    baseUrl: discovery.baseUrl,
    token: discovery.token,
  });
  return { env, server, info, discovery, client };
}

function foragerDefinition(id: string, prompt: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id,
    nodes: {
      only: { kind: 'forager', config: { connection: 'fake', prompt } },
    },
    edges: [],
  };
}

function asRecord(value: unknown): Record<string, any> {
  assert.equal(typeof value, 'object');
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  return value as Record<string, any>;
}

function isControlError(code: string, status?: number) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof ControlClientError);
    assert.equal(error.code, code);
    if (status !== undefined) {
      assert.equal(error.status, status);
    }
    return true;
  };
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'wax-client-discovery-'));
}

function writeInfo(dir: string, info: Record<string, unknown>): string {
  mkdirSync(dir, { recursive: true });
  const infoPath = join(dir, 'server.json');
  writeFileSync(infoPath, JSON.stringify(info), 'utf8');
  return infoPath;
}

function assertDiscoveryFailure(
  run: () => unknown,
  path: string,
  forbidden?: string,
): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof ControlClientError);
    assert.equal(error.code, 'discovery');
    assert.equal(
      error.message.includes(path),
      true,
      `discovery error must name the path '${path}'`,
    );
    if (forbidden !== undefined) {
      assert.equal(
        error.message.includes(forbidden),
        false,
        'discovery error must not echo file contents',
      );
    }
    return true;
  });
}

async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolvePromise, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => resolvePromise());
  });
  const address = probe.address();
  assert.ok(address !== null && typeof address === 'object');
  const port = address.port;
  await new Promise<void>((resolvePromise) => probe.close(() => resolvePromise()));
  return port;
}

async function startRawServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<RawServer> {
  const server = createHttpServer((request, response) => {
    response.on('error', () => undefined);
    handler(request, response);
  });
  server.on('clientError', (_error, socket) => {
    socket.destroy();
  });

  await new Promise<void>((resolvePromise, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolvePromise();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });

  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');

  let closed = false;
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      server.closeAllConnections?.();
      await new Promise<void>((resolvePromise) => {
        server.close(() => resolvePromise());
      });
    },
  };
}

test('discovery finds a running daemon and the client reaches health', async (t) => {
  const daemon = await startDaemon(t);
  const { discovery, info } = daemon;

  assert.equal(discovery.baseUrl, info.url);
  assert.equal(discovery.infoPath, info.infoPath);
  assert.equal(discovery.tokenPath, info.tokenPath);
  assert.equal(discovery.token, readFileSync(info.tokenPath, 'utf8'));

  const infoText = readFileSync(discovery.infoPath, 'utf8');
  const infoJson = JSON.parse(infoText) as Record<string, unknown>;
  assert.equal(Object.hasOwn(infoJson, 'token'), false);
  assert.equal(infoText.includes(discovery.token), false);

  const health = await daemon.client.health();
  assert.equal(health['ok'], true);
  assert.equal(health['harness'], 'fake-harness');
  assert.equal(health['pid'], process.pid);
  assert.equal(health['startedAt'], info.startedAt);
});

test('discovery resolves ~/.wax/waxd from the supplied home environment', () => {
  const home = mkdtempSync(join(tmpdir(), 'wax-client-home-'));
  const daemonDir = join(home, '.wax', 'waxd');
  mkdirSync(daemonDir, { recursive: true });
  const tokenPath = join(daemonDir, 'token');
  writeFileSync(tokenPath, 'home-token', 'utf8');
  writeInfo(daemonDir, {
    url: 'http://127.0.0.1:43123',
    host: '127.0.0.1',
    port: 43123,
    tokenPath,
  });

  const discovery = discoverDaemon({ env: { HOME: home, USERPROFILE: home } });
  assert.equal(discovery.infoPath, join(resolve(daemonDir), 'server.json'));
  assert.equal(discovery.tokenPath, resolve(tokenPath));
  assert.equal(discovery.token, 'home-token');
});

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

test('discovery rejects a missing server.json and names the path', () => {
  const dir = tempDir();
  assertDiscoveryFailure(
    () => discoverDaemon({ daemonDir: dir }),
    join(dir, 'server.json'),
  );
});

test('discovery rejects corrupt server.json without echoing file contents', () => {
  const dir = tempDir();
  const infoPath = join(dir, 'server.json');
  writeFileSync(
    infoPath,
    `{"host":"127.0.0.1","leak":"${LEAK_MARKER}"`,
    'utf8',
  );
  assertDiscoveryFailure(
    () => discoverDaemon({ daemonDir: dir }),
    infoPath,
    LEAK_MARKER,
  );
});

test('discovery rejects non-loopback, https, pathed and mismatched endpoints', () => {
  const cases: readonly Record<string, unknown>[] = [
    {
      url: 'http://0.0.0.0:4321',
      host: '0.0.0.0',
      port: 4321,
    },
    {
      url: 'http://192.168.1.10:4321',
      host: '127.0.0.1',
      port: 4321,
    },
    {
      url: 'http://localhost:4321',
      host: '127.0.0.1',
      port: 4321,
    },
    {
      url: 'https://127.0.0.1:4321',
      host: '127.0.0.1',
      port: 4321,
    },
    {
      url: 'http://127.0.0.1:4321/status',
      host: '127.0.0.1',
      port: 4321,
    },
    {
      url: 'http://127.0.0.1:4321?token=leak',
      host: '127.0.0.1',
      port: 4321,
    },
    {
      url: 'http://127.0.0.1:4321',
      host: '127.0.0.1',
      port: 4322,
    },
  ];

  for (const candidate of cases) {
    const dir = tempDir();
    const tokenPath = join(dir, 'token');
    writeFileSync(tokenPath, VALID_TOKEN, 'utf8');
    const infoPath = writeInfo(dir, { ...candidate, tokenPath });
    assertDiscoveryFailure(() => discoverDaemon({ daemonDir: dir }), infoPath);
  }
});

test('discovery rejects missing, blank and malformed token files', () => {
  const missingDir = tempDir();
  writeInfo(missingDir, {
    url: 'http://127.0.0.1:4321',
    host: '127.0.0.1',
    port: 4321,
    tokenPath: join(missingDir, 'token'),
  });
  assertDiscoveryFailure(
    () => discoverDaemon({ daemonDir: missingDir }),
    join(missingDir, 'token'),
  );

  for (const contents of ['', '   \n\t ', 'two words', `${LEAK_MARKER}\nsecond`]) {
    const dir = tempDir();
    const tokenPath = join(dir, 'token');
    writeFileSync(tokenPath, contents, 'utf8');
    writeInfo(dir, {
      url: 'http://127.0.0.1:4321',
      host: '127.0.0.1',
      port: 4321,
      tokenPath,
    });
    assertDiscoveryFailure(
      () => discoverDaemon({ daemonDir: dir }),
      tokenPath,
      LEAK_MARKER,
    );
  }
});

test('the ControlClient constructor refuses non-loopback and malformed base urls', () => {
  const invalid = [
    'http://0.0.0.0:4321',
    'http://192.168.1.10:4321',
    'http://localhost:4321',
    'https://127.0.0.1:4321',
    'http://127.0.0.1:4321/status',
    'http://127.0.0.1:4321?token=x',
    'http://127.0.0.1',
  ];
  for (const baseUrl of invalid) {
    assert.throws(
      () => new ControlClient({ baseUrl, token: VALID_TOKEN }),
      isControlError('discovery'),
    );
  }

  assert.doesNotThrow(
    () => new ControlClient({ baseUrl: 'http://127.0.0.1:4321', token: VALID_TOKEN }),
  );
  assert.throws(
    () => new ControlClient({ baseUrl: 'http://127.0.0.1:4321', token: '' }),
    isControlError('discovery'),
  );
  assert.throws(
    () =>
      new ControlClient({
        baseUrl: 'http://127.0.0.1:4321',
        token: VALID_TOKEN,
        timeoutMs: 0,
      }),
    isControlError('discovery'),
  );
});

test('a hung fetch becomes code timeout without waiting for the default timeout', async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return await new Promise<Response>(() => {});
  };
  const client = new ControlClient({
    baseUrl: 'http://127.0.0.1:4321',
    token: VALID_TOKEN,
    fetchImpl,
    timeoutMs: 25,
  });

  const started = Date.now();
  await assert.rejects(client.health(), isControlError('timeout'));
  const elapsed = Date.now() - started;
  assert.equal(calls, 1);
  assert.ok(elapsed >= 10, `timeout fired too early: ${String(elapsed)} ms`);
  assert.ok(elapsed < 2_000, `timeout took too long: ${String(elapsed)} ms`);
});

test('a response body that stalls after headers becomes code timeout', async (t) => {
  const raw = await startRawServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{"ok":true');
    // Deliberately never end the response.
  });
  t.after(async () => {
    await raw.close();
  });

  const client = new ControlClient({
    baseUrl: raw.baseUrl,
    token: VALID_TOKEN,
    timeoutMs: 50,
  });
  const started = Date.now();
  await assert.rejects(client.health(), isControlError('timeout'));
  assert.ok(Date.now() - started < 2_000);
});

test('a non-2xx server body never reaches the error message', async (t) => {
  const raw = await startRawServer((_request, response) => {
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        ok: false,
        code: 'server-error',
        error: `token=${VALID_TOKEN} marker=${LEAK_MARKER} prompt=${PROMPT_MARKER}`,
        output: OUTPUT_MARKER,
      }),
    );
  });
  t.after(async () => {
    await raw.close();
  });

  const client = new ControlClient({ baseUrl: raw.baseUrl, token: VALID_TOKEN });
  await assert.rejects(client.health(), (error: unknown) => {
    assert.ok(error instanceof ControlClientError);
    assert.equal(error.status, 500);
    assert.equal(error.code, 'server-error');
    for (const forbidden of [VALID_TOKEN, LEAK_MARKER, PROMPT_MARKER, OUTPUT_MARKER]) {
      assert.equal(error.message.includes(forbidden), false);
    }
    return true;
  });
});

test('an unreachable loopback port becomes code network', async () => {
  const port = await freePort();
  const client = new ControlClient({
    baseUrl: `http://127.0.0.1:${String(port)}`,
    token: VALID_TOKEN,
    timeoutMs: 2_000,
  });
  await assert.rejects(client.health(), (error: unknown) => {
    assert.ok(error instanceof ControlClientError);
    assert.equal(error.code, 'network');
    assert.equal(error.status, undefined);
    assert.equal(error.message.includes(VALID_TOKEN), false);
    return true;
  });
});

test('2xx responses without ok:true or JSON are protocol errors', async (t) => {
  const raw = await startRawServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    if (request.url === '/health') {
      response.end(JSON.stringify({ ok: false, code: 'nope' }));
      return;
    }
    response.end('this is not json');
  });
  t.after(async () => {
    await raw.close();
  });

  const client = new ControlClient({ baseUrl: raw.baseUrl, token: VALID_TOKEN });
  await assert.rejects(client.health(), isControlError('protocol'));
  await assert.rejects(client.status(), isControlError('protocol'));
});

test('trigger is attempted exactly once after a network failure', async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    throw new TypeError('simulated network failure');
  };
  const client = new ControlClient({
    baseUrl: 'http://127.0.0.1:4321',
    token: VALID_TOKEN,
    fetchImpl,
    timeoutMs: 1_000,
  });

  await assert.rejects(
    client.trigger('main', 'only', { kind: 'text', text: 'x' }),
    isControlError('network'),
  );
  assert.equal(calls, 1);
  await new Promise<void>((resolvePromise) => {
    setTimeout(resolvePromise, 25);
  });
  assert.equal(calls, 1, 'trigger must not be retried');
});

test('an oversized response is rejected by the 2 MiB limit', async (t) => {
  const body = 'x'.repeat(2 * 1024 * 1024 + 128);
  const raw = await startRawServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write(body);
    response.end();
  });
  t.after(async () => {
    await raw.close();
  });

  const client = new ControlClient({ baseUrl: raw.baseUrl, token: VALID_TOKEN });
  await assert.rejects(client.health(), (error: unknown) => {
    assert.ok(error instanceof ControlClientError);
    assert.equal(error.code, 'protocol');
    assert.equal(error.message.includes('size limit'), true);
    return true;
  });
});

test('a redirect is refused and the token is never sent to the new target', async (t) => {
  let targetHits = 0;
  const target = await startRawServer((_request, response) => {
    targetHits += 1;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true }));
  });
  t.after(async () => {
    await target.close();
  });
  const redirector = await startRawServer((_request, response) => {
    response.writeHead(302, { location: `${target.baseUrl}/health` });
    response.end();
  });
  t.after(async () => {
    await redirector.close();
  });

  const client = new ControlClient({
    baseUrl: redirector.baseUrl,
    token: VALID_TOKEN,
    timeoutMs: 1_000,
  });
  await assert.rejects(client.health(), isControlError('network'));
  await new Promise<void>((resolvePromise) => {
    setTimeout(resolvePromise, 20);
  });
  assert.equal(targetHits, 0);
});

test('requests carry bearer auth, stay on the base url and refuse redirects', async () => {
  const token = 'token-with-no-whitespace';
  const seen: { url: string; init: RequestInit | undefined }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    seen.push({ url: String(input), init });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const client = new ControlClient({
    baseUrl: 'http://127.0.0.1:4321',
    token,
    fetchImpl,
  });

  await client.health();

  assert.equal(seen.length, 1);
  const first = seen[0];
  assert.ok(first !== undefined);
  assert.equal(first.url, 'http://127.0.0.1:4321/health');
  assert.equal(first.url.includes(token), false);
  const headers = new Headers(first.init?.headers);
  assert.equal(headers.get('authorization'), `Bearer ${token}`);
  assert.equal(first.init?.redirect, 'error');
});
