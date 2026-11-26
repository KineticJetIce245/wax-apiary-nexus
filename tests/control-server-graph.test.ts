import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { request as httpRequest, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { ConversationOptions } from '../src/adapters/harness.js';
import {
  ControlServer,
  type ControlServerInfo,
  type ControlServerOptions,
} from '../src/control/server.js';
import { DaemonLockError } from '../src/daemon/daemon-lock.js';
import type { Project } from '../src/project/kernel.js';
import {
  SessionRegistry,
  type SweepSessionsReport,
} from '../src/session/session-registry.js';
import { Workspace } from '../src/session/workspace.js';
import { FakeAdapter, type FakeAdapterOptions } from './support/fake-adapter.js';
import {
  FIXED_NOW,
  PROMPT_SECRET,
  INPUT_SECRET,
  OUTPUT_SECRET,
  FakeClock,
  makeEnv,
  makeEnvWithAdapter,
  makeServer,
  startServer,
  foragerDefinition,
  loadBody,
  collectKeys,
  assertNoSecrets,
  hoverTokenOf,
  userAnswerComposition,
  userForagerComposition,
} from './support/control-server-fixtures.js';
import { writeManifestFixture, writeManifestVariant, untriggerableComposition } from './support/control-server-manifests.js';
import {
  authHeader,
  assertAccepted,
  bAnswer,
  bInspect,
  bList,
  bLoad,
  bOutput,
  bUnload,
  bTrigger,
  getJson,
  postJson,
  readResponse,
  waitForRest,
} from './support/control-server-http.js';

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

async function waitForHover(url: string, token: string, liveId: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    const inspected = await bInspect(url, token, liveId);
    if (inspected.body?.['status']?.['hovered'] === true) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`live '${liveId}' did not open a hover`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

type WakeResult = Awaited<ReturnType<typeof bTrigger>>;

async function triggerAndWaitRun(
  url: string,
  token: string,
  liveId: string,
  beeId: string,
  input: string,
): Promise<{ readonly trigger: WakeResult; readonly finished: Awaited<ReturnType<typeof waitForRest>> }> {
  const trigger = await bTrigger(url, token, liveId, beeId, input);
  assertAccepted(trigger);
  const finished = await waitForRest(url, token, liveId);
  return { trigger, finished };
}

async function triggerBeeAndWait(
  url: string,
  token: string,
  liveId: string,
  beeId: string,
  input: string,
): Promise<void> {
  const { finished } = await triggerAndWaitRun(url, token, liveId, beeId, input);
  assert.equal(finished.body?.['status']?.['rest'], true);
}

test('load, status, trigger, status and unload work over real HTTP without leaking bodies', async (t) => {
  const env = makeEnv({ output: OUTPUT_SECRET });
  t.after(async () => {
    await env.workspace.stop();
  });
  const logs: string[] = [];
  const running = await startServer(env, { logger: (line) => logs.push(line) });
  t.after(async () => {
    await running.server.stop();
  });
  const { info, token } = running;
  const responses: string[] = [];
  const bodies: unknown[] = [];

  const definition = foragerDefinition('main', `run ${PROMPT_SECRET} {{input}}`);
  const load = await bLoad(info.url, token, {
    definition,
    bindings: { only: { kind: 'fresh' } },
    project: env.project,
  });
  responses.push(load.text);
  assert.equal(load.status, 200);
  assert.equal(load.body?.['ok'], true);
  assert.equal(load.body?.['liveId'], 'main');
  assert.equal(publicStatusOf(load.body?.['status'])['rest'], true);
  bodies.push(load.body);

  const list = await bList(info.url, token);
  responses.push(list.text);
  assert.equal(list.status, 200);
  const lives = list.body?.['lives'] as Record<string, any>[];
  assert.equal(lives?.[0]?.['liveId'], 'main');
  assert.equal(publicStatusOf(lives?.[0]?.['status'])['rest'], true);
  bodies.push(list.body);

  const one = await bInspect(info.url, token, 'main');
  responses.push(one.text);
  assert.equal(one.status, 200);
  assert.equal(one.body?.['liveId'], 'main');
  assert.equal(publicStatusOf(one.body?.['status'])['rest'], true);
  bodies.push(one.body);

  const { trigger, finished } = await triggerAndWaitRun(info.url, token, 'main', 'only', INPUT_SECRET);
  responses.push(trigger.text);
  assert.equal(finished.body?.['status']?.['rest'], true);
  bodies.push(trigger.body, finished.body);

  const after = await bInspect(info.url, token, 'main');
  assert.equal(after.status, 200);
  assert.equal(after.body?.['status']?.['rest'], true);
  assert.equal(after.body?.['status']?.['nodes']?.[0]?.['receptor'], 0);

  const unload = await bUnload(info.url, token, 'main');
  responses.push(unload.text);
  assert.equal(unload.status, 200);
  assert.equal(unload.body?.['unloaded'], true);
  bodies.push(unload.body);

  // The session outlives the graph: it is still listed, now unbound.
  const sessionsAfterUnload = await getJson(info.url, token, '/sessions');
  responses.push(sessionsAfterUnload.text);
  assert.equal(sessionsAfterUnload.status, 200);
  assert.equal(sessionsAfterUnload.body?.['sessions']?.length, 1);
  assert.equal(sessionsAfterUnload.body?.['sessions']?.[0]?.['bound'], false);
  bodies.push(sessionsAfterUnload.body);

  const gone = await bInspect(info.url, token, 'main');
  assert.equal(gone.status, 200);
  assert.equal(gone.body?.['status'], undefined);

  assert.equal(env.adapter.prompts.length, 1);
  assert.equal(env.adapter.prompts[0]?.includes(PROMPT_SECRET), true);
  assert.equal(env.adapter.prompts[0]?.includes(INPUT_SECRET), true);

  assertNoSecrets(`${responses.join('\n')}\n${logs.join('\n')}`, token);
  for (const key of collectKeys(bodies)) {
    assert.equal(
      // `value` is the explicit new run API output shape; status/list still
      // never carry a Value body under this key.
      ['prompt', 'output', 'token', 'pheromones'].includes(key),
      false,
      `response leaked key '${key}'`,
    );
  }
});

test('GET /lives/<id>/output returns sorted forager output and never logs values', async (t) => {
  const env = makeEnv({ output: OUTPUT_SECRET });
  t.after(async () => {
    await env.workspace.stop();
  });
  const logs: string[] = [];
  const running = await startServer(env, { logger: (line) => logs.push(line) });
  t.after(async () => {
    await running.server.stop();
  });
  const { info, token } = running;

  const definition = {
    schemaVersion: 1,
    id: 'outputs',
    nodes: {
      zeta: {
        kind: 'forager',
        config: { connection: 'fake', prompt: `zeta ${PROMPT_SECRET} {{input}}` },
      },
      alpha: {
        kind: 'forager',
        config: { connection: 'fake', prompt: `alpha ${PROMPT_SECRET} {{input}}` },
      },
    },
    edges: [],
  };
  const load = await bLoad(info.url, token, {
    definition,
    bindings: { zeta: { kind: 'fresh' }, alpha: { kind: 'fresh' } },
    project: env.project,
  });
  assert.equal(load.status, 200);

  // Loaded but no completed execution: inspect is the empty output view.
  const empty = await bInspect(info.url, token, 'outputs');
  assert.equal(empty.status, 200);
  assert.equal(empty.body?.['liveId'], 'outputs');
  assert.deepEqual(empty.body?.['outputs'], []);
  for (const nodeId of ['zeta', 'alpha']) {
    await triggerBeeAndWait(info.url, token, 'outputs', nodeId, `${nodeId}-input`);
  }
  const response = await bOutput(info.url, token, 'outputs');
  assert.equal(response.status, 200);
  assert.equal(response.body?.['ok'], true);
  assert.equal(response.body?.['liveId'], 'outputs');
  assert.equal(response.body?.['runId'], undefined);
  // Outputs are field-owned per-bee caches: both bees' last outputs are visible,
  // and there is no run/history identity in the response.
  assert.deepEqual(response.body?.['outputs'], [
    { nodeId: 'alpha', value: { message: OUTPUT_SECRET } },
    { nodeId: 'zeta', value: { message: OUTPUT_SECRET } },
  ]);
  const status = await bInspect(info.url, token, 'outputs');
  assert.equal(status.status, 200);
  const unknown = await bOutput(info.url, token, 'missing');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body?.['code'], 'not-found');
  const tooLong = await bOutput(info.url, token, 'a'.repeat(513));
  assert.equal(tooLong.status, 404);
  const wrongMethod = await postJson(info.url, token, '/lives/outputs/output', {});
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.body?.['code'], 'method-not-allowed');

  // Unload releases the field, so its memory-only outputs are unreadable.
  const unload = await bUnload(info.url, token, 'outputs');
  assert.equal(unload.status, 200);
  const afterUnload = await bOutput(info.url, token, 'outputs');
  assert.equal(afterUnload.status, 404);
  assert.equal(afterUnload.body?.['code'], 'not-found');
  // Metadata-only logging: no output value, prompt or bearer token.
  const logText = logs.join('\n');
  assert.equal(logText.includes(OUTPUT_SECRET), false);
  assert.equal(logText.includes(PROMPT_SECRET), false);
  assert.equal(logText.includes(token), false);
  assert.match(logText, /path=\/lives\/outputs\/output status=200/);
  for (const line of logs) {
    assert.match(
      line,
      /^control method=[A-Z]+ path=\S+ status=[0-9]+ durationMs=[0-9]+ code=[a-z-]+$/,
    );
  }
});

test('unknown graphs return 404 and a duplicate load returns 409 with current status', async (t) => {
  const env = makeEnv();
  t.after(async () => {
    await env.workspace.stop();
  });
  const running = await startServer(env);
  t.after(async () => {
    await running.server.stop();
  });
  const { info, token } = running;

  const unknownStatus = await bInspect(info.url, token, 'missing');
  assert.equal(unknownStatus.status, 404);
  assert.equal(unknownStatus.body?.['code'], 'not-found');

  const unknownTrigger = await bTrigger(info.url, token, 'missing', 'only', 'x');
  assert.equal(unknownTrigger.status, 404);

  const unknownUnload = await bUnload(info.url, token, 'missing');
  assert.equal(unknownUnload.status, 404);

  const definition = foragerDefinition('dup', 'dup {{input}}');
  const body = {
    definition,
    bindings: { only: { kind: 'fresh' } },
    project: env.project,
  };
  const first = await bLoad(info.url, token, body);
  assert.equal(first.status, 200);
  const created = env.adapter.displayNames.length;
  assert.equal(created, 1);

  const duplicate = await bLoad(info.url, token, body);
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body?.['code'], 'conflict');
  assert.equal(publicStatusOf(duplicate.body?.['status'])['rest'], true);
  assert.equal(env.adapter.displayNames.length, created);
  assert.equal(env.registry.list().length, 1);
});

test('unloading a non-Rest graph returns 409 with its current status', async (t) => {
  const env = makeEnv();
  t.after(async () => {
    await env.workspace.stop();
  });
  const running = await startServer(env);
  t.after(async () => {
    await running.server.stop();
  });
  const { info, token } = running;

  const definition = {
    schemaVersion: 1,
    id: 'hover',
    nodes: {
      ask: { kind: 'user', config: { modality: 'text', prompt: 'say something' } },
    },
    edges: [],
  };
  const load = await bLoad(info.url, token, {
    definition,
    bindings: {},
    project: env.project,
  });
  assert.equal(load.status, 200);
  assert.equal(load.body?.['status']?.['rest'], true);

  const trigger = await bTrigger(info.url, token, 'hover', 'ask', INPUT_SECRET);
  assert.equal(trigger.status, 202);
  await waitForHover(info.url, token, 'hover');

  const unload = await bUnload(info.url, token, 'hover');
  assert.equal(unload.status, 409);
  assert.equal(unload.body?.['code'], 'conflict');
  assert.equal(publicStatusOf(unload.body?.['status'])['rest'], false);
  assert.equal(unload.body?.['status']?.['hovered'], true);

  const still = await bInspect(info.url, token, 'hover');
  assert.equal(still.status, 200);
  assert.equal(still.body?.['status']?.['rest'], false);
});

test('answer resolves an open user hover over real HTTP and rejects invalid targets and tokens', async (t) => {
  const env = makeEnv({ output: OUTPUT_SECRET });
  t.after(async () => {
    await env.workspace.stop();
  });
  const logs: string[] = [];
  const running = await startServer(env, { logger: (line) => logs.push(line) });
  t.after(async () => {
    await running.server.stop();
  });
  const { info, token } = running;
  const responses: string[] = [];

  const definition = userAnswerComposition('answer-memory');
  const load = await bLoad(info.url, token, {
    definition,
    bindings: {},
    project: env.project,
  });
  responses.push(load.text);
  assert.equal(load.status, 200);

  const trigger = await bTrigger(info.url, token, 'answer-memory', 'ask', INPUT_SECRET);
  responses.push(trigger.text);
  assert.equal(trigger.status, 202);
  await waitForHover(info.url, token, 'answer-memory');
  const hoverToken = hoverTokenOf(running.server, 'answer-memory', 'ask');

  const wrongToken = await bAnswer(
    info.url,
    token,
    'answer-memory',
    'ask',
    INPUT_SECRET,
    'hv_wrong',
  );
  responses.push(wrongToken.text);
  assert.equal(wrongToken.status, 409);
  assert.equal(wrongToken.body?.['code'], 'conflict');
  assert.match(wrongToken.body?.['error'] ?? '', /hover is not open/);
  assert.equal(wrongToken.text.includes('hv_wrong'), false);
  assert.equal(wrongToken.text.includes(hoverToken), false);

  for (const badToken of ['', `bad\u0000token`, `bad\u0007token`, 'x'.repeat(4_097)]) {
    const rejected = await bAnswer(
      info.url,
      token,
      'answer-memory',
      'ask',
      'x',
      badToken,
    );
    responses.push(rejected.text);
    assert.equal(rejected.status, 400, JSON.stringify(badToken.slice(0, 8)));
    assert.equal(rejected.body?.['code'], 'bad-request');
  }
  const answered = await bAnswer(
    info.url,
    token,
    'answer-memory',
    'ask',
    INPUT_SECRET,
    hoverToken,
  );
  responses.push(answered.text);
  assert.equal(answered.status, 202);
  assert.deepEqual(answered.body, { ok: true });

  const again = await bAnswer(info.url, token, 'answer-memory', 'ask', 'again');
  responses.push(again.text);
  assert.equal(again.status, 409);
  assert.equal(again.body?.['code'], 'conflict', again.text);

  const unknownGraph = await bAnswer(info.url, token, 'missing', 'ask', 'x');
  responses.push(unknownGraph.text);
  assert.equal(unknownGraph.status, 404);

  const unknownNode = await bAnswer(info.url, token, 'answer-memory', 'absent', 'x');
  responses.push(unknownNode.text);
  assert.equal(unknownNode.status, 400);

  const foragerDefinitionBody = foragerDefinition('answer-forager', 'run {{input}}');
  const foragerLoad = await bLoad(info.url, token, {
    definition: foragerDefinitionBody,
    bindings: { only: { kind: 'fresh' } },
    project: env.project,
  });
  responses.push(foragerLoad.text);
  assert.equal(foragerLoad.status, 200);
  const nonUser = await bAnswer(info.url, token, 'answer-forager', 'only', 'x');
  responses.push(nonUser.text);
  assert.equal(nonUser.status, 400);
  assert.equal(nonUser.body?.['code'], 'bad-request');


  assertNoSecrets(`${responses.join('\n')}\n${logs.join('\n')}`, token);
});
