import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
export const PROMPT_SECRET = 'PROMPT_SECRET_9f3c';
export const INPUT_SECRET = 'INPUT_SECRET_7a2e';
export const OUTPUT_SECRET = 'OUTPUT_SECRET_4d81';

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

export interface TestEnv {
  readonly adapter: FakeAdapter;
  readonly workspace: Workspace;
  readonly registry: SessionRegistry;
  readonly project: Project;
  readonly stateRoot: string;
  readonly daemonDir: string;
}

interface RunningServer {
  readonly server: ControlServer;
  readonly info: ControlServerInfo;
  readonly token: string;
}

let projectSeq = 0;

export function makeEnv(adapterOptions: FakeAdapterOptions = {}): TestEnv {
  return makeEnvWithAdapter(new FakeAdapter(adapterOptions));
}

export function makeEnvWithAdapter(
  adapter: FakeAdapter,
  registryNow: () => string = () => FIXED_NOW,
): TestEnv {
  const workspace = new Workspace(adapter);
  projectSeq += 1;
  const project: Project = {
    id: `project-${String(projectSeq)}`,
    directory: mkdtempSync(join(tmpdir(), 'wax-control-project-')),
  };
  const registry = new SessionRegistry({ workspaces: new Map([['codex', workspace]]),
    now: registryNow,
  });
  const stateRoot = mkdtempSync(join(tmpdir(), 'wax-control-state-'));
  return {
    adapter,
    workspace,
    registry,
    project,
    stateRoot,
    daemonDir: join(stateRoot, 'waxd'),
  };
}

export function makeServer(
  env: TestEnv,
  overrides: Partial<ControlServerOptions> = {},
): ControlServer {
  return new ControlServer({
    registry: env.registry,
    stateRoot: env.stateRoot,
    apiary: 'apiary',
    daemonDir: env.daemonDir,
    ...overrides,
  });
}

export async function startServer(
  env: TestEnv,
  overrides: Partial<ControlServerOptions> = {},
): Promise<RunningServer> {
  const server = makeServer(env, overrides);
  const info = await server.start();
  return { server, info, token: readFileSync(info.tokenPath, 'utf8') };
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

export function loadBody(
  definition: Record<string, unknown>,
  project: Project,
  bindings: Record<string, unknown>,
  idleTtlMs?: number,
): Record<string, unknown> {
  return {
    definition,
    bindings,
    project,
    ...(idleTtlMs === undefined ? {} : { idleTtlMs }),
  };
}

export function collectKeys(value: unknown, keys: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectKeys(item, keys);
    }
    return keys;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      keys.push(key);
      collectKeys(child, keys);
    }
  }
  return keys;
}

export function assertNoSecrets(haystack: string, token: string): void {
  for (const secret of [token, PROMPT_SECRET, INPUT_SECRET, OUTPUT_SECRET]) {
    assert.equal(
      haystack.includes(secret),
      false,
      `leaked secret '${secret.slice(0, 8)}...'`,
    );
  }
}

interface ServerHoverAccess {
  readonly graphHost?: {
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
export function hoverTokenOf(server: ControlServer, graphId: string, nodeId: string): string {
  const host = (server as unknown as ServerHoverAccess).graphHost;
  assert.ok(host !== undefined, 'control server has no graph host');
  const entry = host.context.graphs.peek(graphId);
  assert.ok(entry !== undefined, `graph '${graphId}' is not loaded`);
  const hover = entry.value.runtime.snapshot().nodes[nodeId]?.hover;
  assert.ok(hover !== undefined, `node '${nodeId}' has no open hover`);
  return hover.token;
}

export function userAnswerComposition(id: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id,
    nodes: {
      ask: { kind: 'user', config: { modality: 'text', prompt: 'say something' } },
    },
    edges: [],
  };
}

export function userForagerComposition(id: string): Record<string, unknown> {
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
