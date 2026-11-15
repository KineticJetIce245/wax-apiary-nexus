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

const FIXED_NOW = '2026-11-06T22:00:00.000Z';

class FakeClock {
  time: number;

  constructor(time = 1_000) {
    this.time = time;
  }

  readonly now = (): number => this.time;

  advance(ms: number): void {
    this.time += ms;
  }
}
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

function makeEnv(
  adapterOptions: FakeAdapterOptions = {},
  registryNow: () => string = () => FIXED_NOW,
): TestEnv {
  const adapter = new FakeAdapter(adapterOptions);
  const workspace = new Workspace(adapter);
  projectSeq += 1;
  const project: Project = {
    id: `client-project-${String(projectSeq)}`,
    directory: mkdtempSync(join(tmpdir(), 'wax-client-project-')),
  };
  const registry = new SessionRegistry({ workspaces: new Map([['codex', workspace]]),
    now: registryNow,
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
  overrides: Partial<ControlServerOptions> = {},
  registryNow: () => string = () => FIXED_NOW,
): Promise<TestDaemon> {
  const env = makeEnv(adapterOptions, registryNow);
  t.after(async () => {
    await env.workspace.stop();
  });
  const server = new ControlServer({
    registry: env.registry,
    stateRoot: env.stateRoot,
    apiary: 'apiary',
    daemonDir: env.daemonDir,
    ...overrides,
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

function userForagerDefinition(id: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id,
    nodes: {
      idle: { kind: 'forager', config: { connection: 'fake', prompt: 'idle {{input}}' } },
      ask: { kind: 'user', config: { modality: 'text', prompt: 'say something' } },
    },
    edges: [],
  };
}

interface ClientHoverAccess {
  readonly graphHost?: {
    readonly graphs: {
      peek(id: string):
        | {
            readonly value: {
              readonly runtime: {
                snapshot(): {
                  readonly nodes: Readonly<
                    Record<
                      string,
                      { readonly hover?: { readonly token: string; readonly kind: string } }
                    >
                  >;
                };
              };
            };
          }
        | undefined;
    };
  };
}

/** Test-only read of the parked hover token; status deliberately never has it. */
function hoverTokenOf(daemon: TestDaemon, graphId: string, nodeId: string): string {
  const host = (daemon.server as unknown as ClientHoverAccess).graphHost;
  assert.ok(host !== undefined, 'daemon has no graph host');
  const entry = host.graphs.peek(graphId);
  assert.ok(entry !== undefined, `graph '${graphId}' is not loaded`);
  const hover = entry.value.runtime.snapshot().nodes[nodeId]?.hover;
  assert.ok(hover !== undefined, `node '${nodeId}' has no open hover`);
  return hover.token;
}

interface ClientManifestFixture {
  readonly root: string;
  readonly manifestPath: string;
  readonly compositionPath: string;
}

/** A real manifest for exercising the client's optional graphRef end to end. */
function clientManifestFixture(
  options: {
    readonly graphId?: string;
    readonly harness?: 'codex' | 'dsh';
    readonly composition?: Record<string, unknown>;
    readonly bindings?: Record<string, unknown>;
  } = {},
): ClientManifestFixture {
  const root = mkdtempSync(join(tmpdir(), 'wax-client-manifest-'));
  const projectDirectory = join(root, 'project');
  mkdirSync(projectDirectory, { recursive: true });
  const compositionPath = join(root, 'composition.json');
  writeFileSync(
    compositionPath,
    JSON.stringify(
      options.composition ?? foragerDefinition(options.graphId ?? 'client-manifest', 'run {{input}}'),
    ),
  );
  const manifestPath = join(root, 'graph.wax.json');
  writeFileSync(
    manifestPath,
    JSON.stringify({
      schemaVersion: 1,
      composition: 'composition.json',
      project: { id: 'client-manifest-project', directory: 'project' },
      harness: options.harness ?? 'codex',
      bindings: options.bindings ?? { only: { kind: 'fresh' } },
    }),
  );
  return { root, manifestPath, compositionPath };
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
  assert.deepEqual(health['harnesses'], ['codex']);
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
  assert.equal(await daemon.client.outputs('main'), undefined);
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
