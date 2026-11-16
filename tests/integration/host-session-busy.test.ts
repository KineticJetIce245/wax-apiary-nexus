import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DshAcpAdapter } from '../../src/adapters/dsh-acp/adapter.js';
import { ControlServer } from '../../src/control/server.js';
import type { Project } from '../../src/project/kernel.js';
import { SessionRegistry } from '../../src/session/session-registry.js';
import { Workspace } from '../../src/session/workspace.js';

const dshRoot = process.env.DSH_ROOT;
const builtCli =
  dshRoot === undefined ? undefined : join(dshRoot, 'apps', 'cli', 'lib', 'bin.js');
const hasKey =
  process.env.DEEPSEEK_API_KEY !== undefined &&
  process.env.DEEPSEEK_API_KEY.trim() !== '';
const integrationOptions = {
  skip:
    dshRoot === undefined || builtCli === undefined || !existsSync(builtCli) || !hasKey
      ? 'Real session-busy test needs DSH_ROOT (built CLI) and DEEPSEEK_API_KEY'
      : false,
  timeout: 180_000,
};

function definition(id: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id,
    nodes: {
      only: {
        kind: 'forager',
        config: {
          connection: 'dsh',
          prompt:
            'Pick a random integer from 100 through 999. ' +
            'Do not use tools. Reply with only the integer.',
        },
      },
    },
    edges: [],
  };
}

test(
  'real DSH session is refused by a second graph and becomes loadable after unload',
  integrationOptions,
  async (t) => {
    if (dshRoot === undefined) {
      throw new Error('DSH_ROOT is missing');
    }
    const adapter = new DshAcpAdapter({ dshRoot });
    await adapter.start();
    const workspace = new Workspace(adapter);
    const registry = new SessionRegistry({
      workspaces: new Map([['dsh', workspace]]),
    });
    const project: Project = {
      id: 'project-real-session-busy',
      directory: mkdtempSync(join(tmpdir(), 'wax-m9e-real-project-')),
    };
    const session = await registry.create(project);
    const stateRoot = mkdtempSync(join(tmpdir(), 'wax-m9e-real-state-'));
    const server = new ControlServer({
      registry,
      stateRoot,
      apiary: 'apiary',
      daemonDir: join(stateRoot, 'waxd'),
      sessionIdleTtlMs: 0,
    });

    try {
      const info = await server.start();
      const token = readFileSync(info.tokenPath, 'utf8').trim();
      const request = async (
        method: 'GET' | 'POST',
        path: string,
        body?: unknown,
      ): Promise<{ readonly status: number; readonly body: Record<string, any> }> => {
        const response = await fetch(`${info.url}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(150_000),
        });
        return {
          status: response.status,
          body: (await response.json()) as Record<string, any>,
        };
      };
      const load = (id: string): ReturnType<typeof request> =>
        request('POST', '/graphs/load', {
          definition: definition(id),
          bindings: { only: { kind: 'session', sessionId: session.sessionId } },
          project,
        });

      assert.equal((await load('first')).status, 200);
      const busy = await load('second');
      assert.equal(busy.status, 409);
      assert.equal(busy.body['code'], 'session-busy');
      assert.equal(busy.body['error'], 'session is busy');
      assert.equal(JSON.stringify(busy.body).includes(session.sessionId), false);
      assert.equal(JSON.stringify(busy.body).includes('random request'), false);

      assert.equal(
        (await request('POST', '/graphs/unload', { graphId: 'first' })).status,
        200,
      );
      const reload = await load('second');
      assert.equal(reload.status, 200);

      const trigger = await request('POST', '/trigger', {
        graphId: 'second',
        nodeId: 'only',
        value: { kind: 'text', text: 'random request' },
      });
      assert.equal(trigger.status, 200);
      const output = await request('GET', '/graphs/second/output');
      assert.equal(output.status, 200);
      const entries = output.body['outputs'] as Record<string, unknown>[];
      const value = entries[0]?.['value'] as Record<string, unknown> | undefined;
      const text = typeof value?.['text'] === 'string' ? value['text'].trim() : '';
      assert.match(text, /^\d{3}$/);
      const numeric = Number(text);
      assert.ok(numeric >= 100 && numeric <= 999);
      t.diagnostic(`observed: real DSH session rejected by second graph, then answered ${text}`);
    } finally {
      await server.stop().catch(() => undefined);
      await workspace.stop().catch(() => undefined);
    }
  },
);
