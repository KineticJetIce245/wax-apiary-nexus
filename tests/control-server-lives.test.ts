import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { GraphBindingStore } from '../src/graph/binding-store.js';
import type { LiveHive } from '../src/b/types.js';
import { getJson, postJson } from './support/control-server-http.js';
import {
  makeEnv,
  startServer,
  type TestEnv,
} from './support/control-server-fixtures.js';
import { simpleLiveHive, simpleTemplate } from './support/b-object-fixtures.js';

async function boundLive(env: TestEnv): Promise<LiveHive> {
  const live = simpleLiveHive();
  const draft = await env.registry.create(env.project, { harness: 'codex' });
  const review = await env.registry.create(env.project, { harness: 'codex' });
  const done = await env.registry.create(env.project, { harness: 'codex' });
  return {
    ...live,
    bindings: {
      draft: draft.sessionId,
      review: review.sessionId,
      done: done.sessionId,
    },
  };
}

test('B routes create, wake, save, inspect, unload and load a live hive', async (t) => {
  const env = makeEnv({ output: 'b-route-output' });
  const running = await startServer(env, { liveProject: env.project });
  t.after(async () => {
    await running.server.stop();
    await env.workspace.stop();
  });
  const live = await boundLive(env);
  const created = await postJson(running.info.url, running.token, '/lives', { live });
  assert.equal(created.status, 200);
  assert.equal(created.body?.['liveId'], 'demo');
  assert.equal(created.body?.['status']?.['graphId'], 'demo');
  const livePath = join(env.stateRoot, 'lives', 'demo', 'live.json');
  assert.equal(existsSync(livePath), true);

  const woke = await postJson(running.info.url, running.token, '/lives/wake', {
    liveId: 'demo',
    beeId: 'draft',
    input: 'hello',
  });
  assert.equal(woke.status, 200);
  assert.equal(woke.body?.['result']?.['graphId'], 'demo');

  const saved = await postJson(running.info.url, running.token, '/lives/save', {
    liveId: 'demo',
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body?.['status']?.['graphId'], 'demo');

  const inspect = await getJson(running.info.url, running.token, '/lives/demo/inspect');
  assert.equal(inspect.status, 200);
  assert.equal(inspect.body?.['liveId'], 'demo');
  assert.equal(inspect.body?.['status']?.['rest'], true);
  assert.ok(Array.isArray(inspect.body?.['outputs']));

  const unloaded = await postJson(running.info.url, running.token, '/lives/unload', {
    liveId: 'demo',
  });
  assert.equal(unloaded.status, 200);
  assert.equal(unloaded.body?.['unloaded'], true);
  const unloadedInspect = await getJson(
    running.info.url,
    running.token,
    '/lives/demo/inspect',
  );
  assert.equal(unloadedInspect.status, 200);
  assert.deepEqual(unloadedInspect.body?.['outputs'], []);

  const loaded = await postJson(running.info.url, running.token, '/lives/load', {
    liveId: 'demo',
  });
  assert.equal(loaded.status, 200);
  assert.equal(loaded.body?.['status']?.['graphId'], 'demo');

  const next: LiveHive = {
    ...live,
    bees: {
      ...live.bees,
      draft: { ...live.bees['draft']!, config: { connection: 'codex', prompt: 'changed' } },
    },
  };
  const migrated = await postJson(running.info.url, running.token, '/lives/migrate', {
    liveId: 'demo',
    hive: next,
  });
  assert.equal(migrated.status, 200);
  assert.equal(migrated.body?.['status']?.['graphId'], 'demo');
});

test('B answer resolves a user hover', async (t) => {
  const env = makeEnv();
  const running = await startServer(env, { liveProject: env.project });
  t.after(async () => {
    await running.server.stop();
    await env.workspace.stop();
  });
  const live: LiveHive = {
    schemaVersion: 1,
    liveId: 'ask',
    bees: {
      ask: { kind: 'user', config: { modality: 'text', prompt: 'say something' }, outgoing: [] },
    },
    beelines: {},
    bindings: {},
  };
  assert.equal(
    (await postJson(running.info.url, running.token, '/lives', { live })).status,
    200,
  );
  assert.equal(
    (
      await postJson(running.info.url, running.token, '/lives/wake', {
        liveId: 'ask',
        beeId: 'ask',
        input: 'open',
      })
    ).status,
    200,
  );
  const answered = await postJson(running.info.url, running.token, '/lives/answer', {
    liveId: 'ask',
    beeId: 'ask',
    input: 'answer',
  });
  assert.equal(answered.status, 200);
  assert.equal(answered.body?.['result']?.['graphId'], 'ask');
});

test('templates compose/list and instantiate routes materialize a live', async (t) => {
  const env = makeEnv({ output: 'template-output' });
  const running = await startServer(env, {
    liveProject: env.project,
    bindingStore: new GraphBindingStore(join(env.daemonDir, 'bindings.json')),
  });
  t.after(async () => {
    await running.server.stop();
    await env.workspace.stop();
  });
  const template = simpleTemplate();
  const composed = await postJson(running.info.url, running.token, '/templates', {
    template,
  });
  assert.equal(composed.status, 200);
  assert.equal(composed.body?.['templateId'], 'starter');

  const listed = await getJson(running.info.url, running.token, '/templates');
  assert.equal(listed.status, 200);
  assert.equal(listed.body?.['templates']?.[0]?.['templateId'], 'starter');

  const instantiated = await postJson(
    running.info.url,
    running.token,
    '/lives/instantiate',
    {
      templateId: 'starter',
      liveId: 'from-template',
      overrides: {
        review: { harness: 'codex' },
        done: { harness: 'codex' },
      },
    },
  );
  assert.equal(instantiated.status, 200);
  assert.equal(instantiated.body?.['liveId'], 'from-template');
  assert.equal(instantiated.body?.['status']?.['graphId'], 'from-template');

  const inspect = await getJson(
    running.info.url,
    running.token,
    '/lives/from-template/inspect',
  );
  assert.equal(inspect.status, 200);
  assert.equal(inspect.body?.['status']?.['graphId'], 'from-template');
});

test('dispatch route runs a temporary session and rejects bad bodies', async (t) => {
  const env = makeEnv({ output: 'dispatch-route-output' });
  const running = await startServer(env, { liveProject: env.project });
  t.after(async () => {
    await running.server.stop();
    await env.workspace.stop();
  });
  const dispatched = await postJson(running.info.url, running.token, '/dispatch', {
    input: 'summarize',
    sessionParams: { harness: 'codex', model: 'm1' },
  });
  assert.equal(dispatched.status, 200);
  assert.equal(dispatched.body?.['output'], 'dispatch-route-output');
  assert.equal(typeof dispatched.body?.['sessionId'], 'string');

  const bad = await postJson(running.info.url, running.token, '/dispatch', {});
  assert.equal(bad.status, 400);
  assert.equal(bad.body?.['ok'], false);
});

test('B routes reject bad bodies and unknown live ids with stable errors', async (t) => {
  const env = makeEnv();
  const running = await startServer(env, { liveProject: env.project });
  t.after(async () => {
    await running.server.stop();
    await env.workspace.stop();
  });

  const badCreate = await postJson(running.info.url, running.token, '/lives', {});
  assert.equal(badCreate.status, 400);
  assert.equal(badCreate.body?.['ok'], false);

  const unknownInspect = await getJson(
    running.info.url,
    running.token,
    '/lives/ghost/inspect',
  );
  assert.equal(unknownInspect.status, 404);

  const unknownWake = await postJson(running.info.url, running.token, '/lives/wake', {
    liveId: 'ghost',
    beeId: 'draft',
    input: 'x',
  });
  assert.equal(unknownWake.status, 404);

  const unknownSave = await postJson(running.info.url, running.token, '/lives/save', {
    liveId: 'ghost',
  });
  assert.equal(unknownSave.status, 404);

  const badTemplate = await postJson(running.info.url, running.token, '/templates', {});
  assert.equal(badTemplate.status, 400);

  const unknownTemplate = await postJson(
    running.info.url,
    running.token,
    '/lives/instantiate',
    { templateId: 'ghost', liveId: 'x' },
  );
  assert.equal(unknownTemplate.status, 404);
});
