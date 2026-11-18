import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ControlServer } from '../src/control/server.js';
import type { Project } from '../src/project/kernel.js';
import { SessionRegistry } from '../src/session/session-registry.js';
import { Workspace } from '../src/session/workspace.js';
import { FakeAdapter } from './support/fake-adapter.js';
import { liveFrom } from './support/control-server-http.js';

const PROMPT_SECRET = 'M9E-HTTP-PROMPT-SECRET';

function definition(id: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id,
    nodes: {
      only: {
        kind: 'forager',
        config: { connection: 'fake', prompt: `${PROMPT_SECRET} {{input}}` },
      },
    },
    edges: [],
  };
}

test('a second loaded graph with the same session returns 409 session-busy', async (t) => {
  const adapter = new FakeAdapter({ output: 'secret-output' });
  const workspace = new Workspace(adapter);
  const registry = new SessionRegistry({
    workspaces: new Map([['fake', workspace]]),
  });
  const project: Project = {
    id: 'project-http-session-busy',
    directory: mkdtempSync(join(tmpdir(), 'wax-m9e-http-busy-')),
  };
  const stateRoot = mkdtempSync(join(tmpdir(), 'wax-m9e-http-state-'));
  const session = await registry.create(project);
  const server = new ControlServer({
    registry,
    stateRoot,
    apiary: 'apiary',
    daemonDir: join(stateRoot, 'waxd'),
    liveProject: project,
  });

  try {
    const info = await server.start();
    const token = readFileSync(info.tokenPath, 'utf8').trim();
    const post = async (
      path: string,
      body: unknown,
    ): Promise<{ readonly status: number; readonly body: Record<string, any> }> => {
      const response = await fetch(`${info.url}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      return {
        status: response.status,
        body: (await response.json()) as Record<string, any>,
      };
    };
    const load = (id: string): ReturnType<typeof post> =>
      post('/lives', {
        live: liveFrom(definition(id), {
          only: { kind: 'session', sessionId: session.sessionId },
        }),
        project,
      });

    const first = await load('first');
    assert.equal(first.status, 200);

    const second = await load('second');
    assert.equal(second.status, 409);
    assert.equal(second.body['code'], 'session-busy');
    assert.equal(JSON.stringify(second.body).includes(PROMPT_SECRET), false);
    assert.equal(JSON.stringify(second.body).includes('secret-output'), false);
    assert.equal(second.body['error'], 'session is busy');

    const unload = await post('/lives/unload', { liveId: 'first' });
    assert.equal(unload.status, 200);
    const reload = await load('second');
    assert.equal(reload.status, 200);
    assert.equal(reload.body['status']?.['graphId'], 'second');
  } finally {
    await server.stop().catch(() => undefined);
    await workspace.stop().catch(() => undefined);
  }
});
