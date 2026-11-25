import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { GraphBindingStore } from '../src/graph/binding-store.js';
import type { LiveHive } from '../src/b/types.js';
import { getJson, postJson, waitForRunTerminal } from './support/control-server-http.js';
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

/** Public status must not carry internal engine identity. */
function publicStatusOf(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, 'object');
  assert.notEqual(value, null);
  const status = value as Record<string, unknown>;
  assert.equal(Object.hasOwn(status, 'graphId'), false);
  assert.equal(Object.hasOwn(status, 'graphRevision'), false);
  assert.equal(typeof status['rest'], 'boolean');
  return status;
}

async function wakeAndAssertRun(
  url: string,
  token: string,
  liveId: string,
): Promise<string> {
  const woke = await postJson(url, token, '/lives/wake', {
    liveId,
    beeId: 'draft',
    input: 'hello',
  });
  assert.equal(woke.status, 202);
  assert.equal(woke.body?.['ok'], true);
  assert.equal(woke.body?.['status'], 'accepted');
  const runId = String(woke.body?.['runId']);
  assert.ok(runId.length > 0);
  assert.ok(String(woke.body?.['traceId']).startsWith('tr_'));
  assert.equal(Object.hasOwn(woke.body ?? {}, 'result'), false);
  const finished = await waitForRunTerminal(url, token, liveId, runId);
  assert.equal(finished.body?.['run']?.['state'], 'completed');
  assert.ok(Array.isArray(finished.body?.['run']?.['outputs']));
  const unknownRun = await getJson(url, token, `/lives/${liveId}/runs/missing-run`);
  assert.equal(unknownRun.status, 404);
  const otherLiveRun = await getJson(
    url,
    token,
    `/lives/ghost/runs/${encodeURIComponent(runId)}`,
  );
  assert.equal(otherLiveRun.status, 404);
  return runId;
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
  assert.equal(publicStatusOf(created.body?.['status'])['rest'], true);
  const duplicate = await postJson(running.info.url, running.token, '/lives', { live });
  assert.equal(duplicate.status, 409);
  assert.equal(publicStatusOf(duplicate.body?.['status'])['rest'], true);
  const livePath = join(env.stateRoot, 'lives', 'demo', 'live.json');
  assert.equal(existsSync(livePath), true);
  const listedLoaded = await getJson(running.info.url, running.token, '/lives');
  assert.equal(listedLoaded.status, 200);
  assert.equal(
    (listedLoaded.body?.['lives'] as Record<string, unknown>[]).find(
      (entry) => entry['liveId'] === 'demo',
    )?.['state'],
    'loaded',
  );
  for (const entry of listedLoaded.body?.['lives'] as Record<string, unknown>[]) {
    if (entry['status'] !== undefined) {
      publicStatusOf(entry['status']);
    }
  }

  const runId = await wakeAndAssertRun(running.info.url, running.token, 'demo');

  const saved = await postJson(running.info.url, running.token, '/lives/save', {
    liveId: 'demo',
  });
  assert.equal(saved.status, 200);
  publicStatusOf(saved.body?.['status']);

  const inspect = await getJson(running.info.url, running.token, '/lives/demo/inspect');
  assert.equal(inspect.status, 200);
  assert.equal(inspect.body?.['liveId'], 'demo');
  assert.equal(publicStatusOf(inspect.body?.['status'])['rest'], true);
  assert.ok(Array.isArray(inspect.body?.['outputs']));

  const unloaded = await postJson(running.info.url, running.token, '/lives/unload', {
    liveId: 'demo',
  });
  assert.equal(unloaded.status, 200);
  assert.equal(unloaded.body?.['unloaded'], true);
  const listedUnloaded = await getJson(running.info.url, running.token, '/lives');
  assert.equal(
    (listedUnloaded.body?.['lives'] as Record<string, unknown>[]).find(
      (entry) => entry['liveId'] === 'demo',
    )?.['state'],
    'unloaded',
  );
  const outputByRun = await getJson(
    running.info.url,
    running.token,
    `/lives/demo/output?runId=${encodeURIComponent(runId)}`,
  );
  assert.equal(outputByRun.status, 200);
  assert.equal(outputByRun.body?.['runId'], runId);
  assert.equal(JSON.stringify(outputByRun.body).includes('hello'), false);
  const latestOutput = await getJson(
    running.info.url,
    running.token,
    '/lives/demo/output',
  );
  assert.equal(latestOutput.status, 200);
  assert.equal(latestOutput.body?.['runId'], runId);
  const unknownOutput = await getJson(
    running.info.url,
    running.token,
    '/lives/demo/output?runId=missing-run',
  );
  assert.equal(unknownOutput.status, 404);
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
  assert.equal(loaded.body?.['liveId'], 'demo');
  assert.equal(publicStatusOf(loaded.body?.['status'])['rest'], true);

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
  assert.equal(migrated.body?.['liveId'], 'demo');
  assert.equal(publicStatusOf(migrated.body?.['status'])['rest'], true);

  const publicPayloads = [
    created.text,
    duplicate.text,
    saved.text,
    inspect.text,
    loaded.text,
    migrated.text,
  ].join('\n');
  assert.equal(publicPayloads.includes('graphId'), false);
  assert.equal(publicPayloads.includes('graphRevision'), false);
});

async function waitForHover(
  url: string,
  token: string,
  liveId: string,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    const inspected = await getJson(
      url,
      token,
      `/lives/${encodeURIComponent(liveId)}/inspect`,
    );
    if (inspected.body?.['status']?.['hovered'] === true) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`live '${liveId}' did not open a hover`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

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
    202,
  );
  await waitForHover(running.info.url, running.token, 'ask');
  const answered = await postJson(running.info.url, running.token, '/lives/answer', {
    liveId: 'ask',
    beeId: 'ask',
    input: 'answer',
  });
  assert.equal(answered.status, 200);
  assert.equal(answered.body?.['result']?.['liveId'], 'ask');
  publicStatusOf(answered.body?.['result']?.['status']);
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
  assert.equal(publicStatusOf(instantiated.body?.['status'])['rest'], true);

  const inspect = await getJson(
    running.info.url,
    running.token,
    '/lives/from-template/inspect',
  );
  assert.equal(inspect.status, 200);
  assert.equal(inspect.body?.['liveId'], 'from-template');
  assert.equal(publicStatusOf(inspect.body?.['status'])['rest'], true);
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
