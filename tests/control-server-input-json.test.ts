import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import test from 'node:test';

import type { LiveHive } from '../src/b/types.js';
import { HoneyStore } from '../src/storage/honey.js';
import { getJson, postJson, waitForRest } from './support/control-server-http.js';
import { makeEnv, startServer } from './support/control-server-fixtures.js';

function askLive(liveId: string): LiveHive {
  return {
    schemaVersion: 1,
    liveId,
    bees: {
      ask: {
        kind: 'user',
        config: { modality: 'text', prompt: 'say something' },
        outgoing: [],
      },
    },
    beelines: {},
    bindings: {},
  };
}

async function waitForHover(url: string, token: string, liveId: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    const inspected = await getJson(url, token, `/lives/${encodeURIComponent(liveId)}/inspect`);
    if (inspected.body?.['status']?.['hovered'] === true) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`live '${liveId}' did not open a hover`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForPrompt(
  prompts: readonly string[],
  expected: string,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!prompts.includes(expected)) {
    if (Date.now() >= deadline) {
      throw new Error(`dispatch prompt '${expected}' did not reach the adapter`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('trigger and answer accept a JSON object Value as-is', async (t) => {
  const env = makeEnv();
  const running = await startServer(env, { liveProject: env.project });
  t.after(async () => {
    await running.server.stop();
    await env.workspace.stop();
  });
  const url = running.info.url;
  const token = running.token;
  assert.equal((await postJson(url, token, '/lives', { live: askLive('json-input') })).status, 200);

  const triggered = await postJson(url, token, '/lives/trigger', {
    liveId: 'json-input',
    beeId: 'ask',
    input: { message: 'open', meta: { round: 1 } },
  });
  assert.equal(triggered.status, 202, triggered.text);
  assert.deepEqual(triggered.body, { ok: true });
  await waitForHover(url, token, 'json-input');

  const answered = await postJson(url, token, '/lives/answer', {
    liveId: 'json-input',
    beeId: 'ask',
    input: { message: 'answer', meta: { score: 2 }, items: [1, 2] },
  });
  assert.equal(answered.status, 202, answered.text);
  await waitForRest(url, token, 'json-input');

  const output = await getJson(url, token, '/lives/json-input/output');
  assert.equal(output.status, 200);
  const ask = (output.body?.['outputs'] as { nodeId: string; value: unknown }[]).find(
    (entry) => entry.nodeId === 'ask',
  );
  assert.deepEqual(ask?.value, {
    message: 'answer',
    meta: { score: 2 },
    items: [1, 2],
  });
});

test('trigger/answer/dispatch reject non-object, non-string input', async (t) => {
  const env = makeEnv();
  const running = await startServer(env, { liveProject: env.project });
  t.after(async () => {
    await running.server.stop();
    await env.workspace.stop();
  });
  const url = running.info.url;
  const token = running.token;
  await postJson(url, token, '/lives', { live: askLive('bad-input') });

  for (const input of [[1, 2], 42, null, true]) {
    const trigger = await postJson(url, token, '/lives/trigger', {
      liveId: 'bad-input',
      beeId: 'ask',
      input,
    });
    assert.equal(trigger.status, 400, trigger.text);
    assert.equal(trigger.body?.['code'], 'bad-request');
    const dispatch = await postJson(url, token, '/dispatch', {
      input,
      sessionParams: { harness: 'codex' },
    });
    assert.equal(dispatch.status, 400, dispatch.text);
  }
});

test('dispatch accepts a JSON object and uses its message field', async (t) => {
  const env = makeEnv({ output: 'dispatch-json-output' });
  const running = await startServer(env, { liveProject: env.project });
  t.after(async () => {
    await running.server.stop();
    await env.workspace.stop();
  });
  const dispatched = await postJson(running.info.url, running.token, '/dispatch', {
    input: { message: 'summarize', extra: { nested: true } },
    sessionParams: { harness: 'codex' },
  });
  assert.equal(dispatched.status, 202, dispatched.text);
  assert.deepEqual(dispatched.body, { ok: true });

  await waitForPrompt(env.adapter.prompts, 'summarize');
  assert.equal(env.adapter.prompts.includes('{"message":"summarize"}'), false);
});

test('an old Honey snapshot maps to 409 honey-incompatible without a path', async (t) => {
  const env = makeEnv();
  const running = await startServer(env, { liveProject: env.project });
  t.after(async () => {
    await running.server.stop();
    await env.workspace.stop();
  });
  const liveId = 'legacy-honey';
  const fieldPath = HoneyStore.forComposition(
    env.stateRoot,
    'apiary',
    liveId,
  ).paths.field;
  mkdirSync(dirname(fieldPath), { recursive: true });
  writeFileSync(
    fieldPath,
    JSON.stringify({
      schemaVersion: 1,
      compositionId: liveId,
      graphRevision: 'old',
      rest: true,
      nodes: {},
    }),
    'utf8',
  );

  const created = await postJson(running.info.url, running.token, '/lives', {
    live: askLive(liveId),
  });
  assert.equal(created.status, 409, created.text);
  assert.equal(created.body?.['ok'], false);
  assert.equal(created.body?.['code'], 'honey-incompatible');
  assert.equal(created.text.includes(env.stateRoot), false);
  assert.equal(created.text.includes(fieldPath), false);
});

test('an old live.json spread/gather shape is rejected by the new schema', async (t) => {
  const env = makeEnv();
  const running = await startServer(env, { liveProject: env.project });
  t.after(async () => {
    await running.server.stop();
    await env.workspace.stop();
  });
  const url = running.info.url;
  const token = running.token;

  const oldSpread: LiveHive = {
    schemaVersion: 1,
    liveId: 'old-spread',
    bees: {
      start: {
        kind: 'forager',
        config: { connection: 'codex', prompt: 'start' },
        outgoing: ['to-spread'],
      },
      spread: {
        kind: 'spread',
        config: { branches: [{ id: 'a', to: 'done' }] },
        outgoing: [],
      },
      done: { kind: 'user', config: { modality: 'text', prompt: 'done' }, outgoing: [] },
    },
    beelines: { 'to-spread': { fromBee: 'start', toBee: 'spread' } },
    bindings: {},
  };
  const spread = await postJson(url, token, '/lives', { live: oldSpread });
  assert.equal(spread.status, 400, spread.text);
  assert.equal(spread.body?.['code'], 'bad-request');

  const oldGather: LiveHive = {
    schemaVersion: 1,
    liveId: 'old-gather',
    bees: {
      gather: {
        kind: 'gather',
        config: { required: ['a'], combine: 'text' },
        outgoing: [],
      },
    },
    beelines: {},
    bindings: {},
  };
  const gather = await postJson(url, token, '/lives', { live: oldGather });
  assert.equal(gather.status, 400, gather.text);
  assert.equal(gather.body?.['code'], 'bad-request');
});
