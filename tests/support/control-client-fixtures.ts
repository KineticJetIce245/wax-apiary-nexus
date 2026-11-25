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
import type { TestContext } from 'node:test';

import {
  ControlClient,
  ControlClientError,
  discoverDaemon,
  type DaemonDiscovery,
} from '../../src/control/client.js';
import {
  ControlServer,
  type ControlServerInfo,
  type ControlServerOptions,
} from '../../src/control/server.js';
import type { Project } from '../../src/project/kernel.js';
import { SessionRegistry } from '../../src/session/session-registry.js';
import { Workspace } from '../../src/session/workspace.js';
import { FakeAdapter, type FakeAdapterOptions } from './fake-adapter.js';

export const FIXED_NOW = '2026-11-06T22:00:00.000Z';

export class FakeClock {
  time: number;

  constructor(time = 1_000) {
    this.time = time;
  }

  readonly now = (): number => this.time;

  advance(ms: number): void {
    this.time += ms;
  }
}
export const VALID_TOKEN = 'a'.repeat(64);
export const PROMPT_MARKER = 'PROMPT_MARKER_c2a1';
export const OUTPUT_MARKER = 'OUTPUT_MARKER_e4b7';
export const LEAK_MARKER = 'LEAK_MARKER_8d2f';

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

export async function startDaemon(
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

export function foragerDefinition(id: string, prompt: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id,
    nodes: {
      only: { kind: 'forager', config: { connection: 'fake', prompt } },
    },
    edges: [],
  };
}

export function userForagerDefinition(id: string): Record<string, unknown> {
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
  readonly liveHiveHost?: {
    readonly context: {
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
  };
}

/** Test-only read of the parked hover token; status deliberately never has it. */
export function hoverTokenOf(daemon: TestDaemon, graphId: string, nodeId: string): string {
  const host = (daemon.server as unknown as ClientHoverAccess).liveHiveHost;
  assert.ok(host !== undefined, 'daemon has no graph host');
  const entry = host.context.graphs.peek(graphId);
  assert.ok(entry !== undefined, `graph '${graphId}' is not loaded`);
  const hover = entry.value.runtime.snapshot().nodes[nodeId]?.hover;
  assert.ok(hover !== undefined, `node '${nodeId}' has no open hover`);
  return hover.token;
}

export function asRecord(value: unknown): Record<string, any> {
  assert.equal(typeof value, 'object');
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  return value as Record<string, any>;
}

export function isControlError(code: string, status?: number) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof ControlClientError);
    assert.equal(error.code, code);
    if (status !== undefined) {
      assert.equal(error.status, status);
    }
    return true;
  };
}

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'wax-client-discovery-'));
}

export function writeInfo(dir: string, info: Record<string, unknown>): string {
  mkdirSync(dir, { recursive: true });
  const infoPath = join(dir, 'server.json');
  writeFileSync(infoPath, JSON.stringify(info), 'utf8');
  return infoPath;
}

export function assertDiscoveryFailure(
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

export async function freePort(): Promise<number> {
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

export async function startRawServer(
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
