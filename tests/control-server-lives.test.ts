import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { GraphBindingStore } from '../src/graph/binding-store.js';
import type { LiveHive } from '../src/b/types.js';
import { DEFAULT_QUEUE_MAX } from '../src/runtime/definition-constants.js';
import { getJson, postJson, waitForRest } from './support/control-server-http.js';
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

async function triggerAndAssertRest(
  url: string,
  token: string,
  liveId: string,
): Promise<void> {
  const woke = await postJson(url, token, '/lives/trigger', {
    liveId,
    beeId: 'draft',
    input: 'hello',
  });
  assert.equal(woke.status, 202);
  assert.deepEqual(woke.body, { ok: true });
  const finished = await waitForRest(url, token, liveId);
  assert.equal(finished.status, 200);
  assert.equal(finished.body?.['status']?.['rest'], true);
  // The removed run route stays absent; only the field is the read model.
  const removedRunRoute = await getJson(url, token, `/lives/${liveId}/runs/missing-run`);
  assert.equal(removedRunRoute.status, 404);
}

test('B routes create, trigger, save, inspect, unload and load a live hive', async (t) => {
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

  await triggerAndAssertRest(running.info.url, running.token, 'demo');

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

  const fieldOutput = await getJson(
    running.info.url,
    running.token,
    '/lives/demo/output',
  );
  assert.equal(fieldOutput.status, 200);
  assert.equal(fieldOutput.body?.['runId'], undefined);
  assert.deepEqual(fieldOutput.body?.['outputs'], [
    { nodeId: 'done', value: { kind: 'text', text: 'b-route-output' } },
    { nodeId: 'draft', value: { kind: 'text', text: 'b-route-output' } },
    { nodeId: 'review', value: { kind: 'text', text: 'b-route-output' } },
  ]);
  assert.equal(JSON.stringify(fieldOutput.body).includes('hello'), false);
  const unknownOutput = await getJson(
    running.info.url,
    running.token,
    '/lives/ghost/output',
  );
  assert.equal(unknownOutput.status, 404);

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
  const unloadedInspect = await getJson(
    running.info.url,
    running.token,
    '/lives/demo/inspect',
  );
  assert.equal(unloadedInspect.status, 200);
  assert.deepEqual(unloadedInspect.body?.['outputs'], []);
  const releasedOutput = await getJson(
    running.info.url,
    running.token,
    '/lives/demo/output',
  );
  assert.equal(releasedOutput.status, 404);
  assert.equal(releasedOutput.body?.['code'], 'not-found');

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

interface InspectedBee {
  readonly nodeId: string;
  readonly hovered: boolean;
  readonly receptor: number;
}

/** Poll one bee's public field state through `inspect` (there is no run id). */
async function waitForBee(
  url: string,
  token: string,
  liveId: string,
  beeId: string,
  predicate: (bee: InspectedBee) => boolean,
): Promise<void> {
  const deadline = Date.now() + 3_000;
  for (;;) {
    const inspected = await getJson(
      url,
      token,
      `/lives/${encodeURIComponent(liveId)}/inspect`,
    );
    const nodes = inspected.body?.['status']?.['nodes'];
    const bee = Array.isArray(nodes)
      ? (nodes as InspectedBee[]).find((node) => node.nodeId === beeId)
      : undefined;
    if (bee !== undefined && predicate(bee)) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`bee '${beeId}' of live '${liveId}' did not reach the expected state`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('B answer binds a user hover', async (t) => {
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
      await postJson(running.info.url, running.token, '/lives/trigger', {
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
  assert.equal(answered.status, 202);
  assert.deepEqual(answered.body, { ok: true });
  await waitForRest(running.info.url, running.token, 'ask');
});

/**
 * `seed` moves into a fork that fills `done`'s receptor to the configured
 * capacity, while `ask` can only answer into the same `done`.
 */
function answerOverflowLive(liveId: string): LiveHive {
  const branches = Array.from({ length: DEFAULT_QUEUE_MAX }, (_, index) => ({
    id: `b${String(index)}`,
    to: 'done',
  }));
  return {
    schemaVersion: 1,
    liveId,
    bees: {
      ask: {
        kind: 'user',
        config: { modality: 'text', prompt: 'ask' },
        outgoing: ['ask-done'],
      },
      seed: {
        kind: 'user',
        config: { modality: 'text', prompt: 'seed' },
        outgoing: ['seed-fill'],
      },
      fill: { kind: 'fork', config: { branches }, outgoing: [] },
      done: {
        kind: 'user',
        config: { modality: 'text', prompt: 'done' },
        outgoing: [],
      },
    },
    beelines: {
      'ask-done': { fromBee: 'ask', toBee: 'done' },
      'seed-fill': { fromBee: 'seed', toBee: 'fill' },
    },
    bindings: {},
  };
}

async function triggerAndHover(
  url: string,
  token: string,
  liveId: string,
  beeId: string,
): Promise<void> {
  const triggered = await postJson(url, token, '/lives/trigger', {
    liveId,
    beeId,
    input: 'open',
  });
  assert.equal(triggered.status, 202, triggered.text);
  await waitForBee(url, token, liveId, beeId, (bee) => bee.hovered);
}

/** Answer the seed: the fork fills `done`'s receptor to capacity. */
async function fillDoneReceptor(
  url: string,
  token: string,
  liveId: string,
): Promise<void> {
  const answered = await postJson(url, token, '/lives/answer', {
    liveId,
    beeId: 'seed',
    input: 'fill',
  });
  assert.equal(answered.status, 202, answered.text);
  await waitForBee(
    url,
    token,
    liveId,
    'done',
    (bee) => bee.receptor === DEFAULT_QUEUE_MAX,
  );
}

/** One answer refused by `done`'s full receptor; the hover must stay open. */
async function assertAnswerRefused(
  url: string,
  token: string,
  liveId: string,
  beeId: string,
): Promise<void> {
  const refused = await postJson(url, token, '/lives/answer', {
    liveId,
    beeId,
    input: 'too-early',
  });
  assert.equal(refused.status, 429, refused.text);
  assert.equal(refused.body?.['code'], 'bee-receptor-full');
  assert.equal(refused.body?.['beeId'], 'done');
  assert.equal(refused.body?.['pending'], DEFAULT_QUEUE_MAX);
  assert.equal(refused.body?.['limit'], DEFAULT_QUEUE_MAX);
  assert.equal(refused.body?.['policy'], 'reject');
}

test('B answer refuses a full downstream receptor without consuming the hover', async (t) => {
  const env = makeEnv();
  const running = await startServer(env, { liveProject: env.project });
  t.after(async () => {
    await running.server.stop();
    await env.workspace.stop();
  });
  const url = running.info.url;
  const token = running.token;
  const liveId = 'answer-full';
  assert.equal(
    (await postJson(url, token, '/lives', { live: answerOverflowLive(liveId) })).status,
    200,
  );
  for (const beeId of ['ask', 'done', 'seed']) {
    await triggerAndHover(url, token, liveId, beeId);
  }
  await fillDoneReceptor(url, token, liveId);

  await assertAnswerRefused(url, token, liveId, 'ask');
  // The hover survived: a second attempt hits the same overflow refusal
  // instead of reporting a missing hover or a stale token.
  await assertAnswerRefused(url, token, liveId, 'ask');
  await waitForBee(url, token, liveId, 'ask', (bee) => bee.hovered);
  await waitForBee(
    url,
    token,
    liveId,
    'done',
    (bee) => bee.hovered && bee.receptor === DEFAULT_QUEUE_MAX,
  );
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

test('dispatch route accepts a temporary session and rejects bad bodies', async (t) => {
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
  assert.equal(dispatched.status, 202);
  assert.deepEqual(dispatched.body, { ok: true });
  assert.equal(dispatched.text.includes('dispatch-route-output'), false);

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

  const unknownWake = await postJson(running.info.url, running.token, '/lives/trigger', {
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
