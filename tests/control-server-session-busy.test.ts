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
import { liveFrom, waitForRest } from './support/control-server-http.js';

const PROMPT_SECRET = 'M9E-HTTP-PROMPT-SECRET';

function definition(id: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id,
    nodes: {
      only: {
        kind: 'forager',
        config: { connection: 'fake', prompt: `${PROMPT_SECRET} {{message}}` },
      },
    },
    edges: [],
  };
}

async function wakeSecondLive(
  url: string,
  token: string,
  post: (path: string, body: unknown) => Promise<{ status: number; body: Record<string, any> }>,
): Promise<void> {
  const wake = await post('/lives/trigger', {
    liveId: 'second',
    beeId: 'only',
    input: 'still here',
  });
  assert.equal(wake.status, 202, JSON.stringify(wake.body));
  assert.deepEqual(wake.body, { ok: true });
  const finished = await waitForRest(
    url,
    token,
    'second',
  );
  assert.equal(finished.body?.['status']?.['rest'], true);
}

test('a second loaded graph may share the same session; unload is refcounted', async (t) => {
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

    // Both loaded LiveHives now hold the same explicit session; sharing is
    // allowed and each wake is admitted by the harness adapter.
    const first = await load('first');
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const second = await load('second');
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.equal(second.body['liveId'], 'second');
    assert.equal(Object.hasOwn(second.body['status'] ?? {}, 'graphId'), false);
    assert.equal(JSON.stringify(first.body).includes(PROMPT_SECRET), false);
    assert.equal(JSON.stringify(second.body).includes(PROMPT_SECRET), false);
    assert.equal(JSON.stringify(second.body).includes('secret-output'), false);

    // Unloading one sharer leaves the other loaded and executable.
    const unload = await post('/lives/unload', { liveId: 'first' });
    assert.equal(unload.status, 200);
    await wakeSecondLive(info.url, token, post);

    const reload = await load('first');
    assert.equal(reload.status, 200);
    assert.equal(reload.body['liveId'], 'first');

    assert.equal((await post('/lives/unload', { liveId: 'second' })).status, 200);
    assert.equal((await post('/lives/unload', { liveId: 'first' })).status, 200);
  } finally {
    await server.stop().catch(() => undefined);
    await workspace.stop().catch(() => undefined);
  }
});
