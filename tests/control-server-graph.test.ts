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
import { authHeader, readResponse, getJson, postJson } from './support/control-server-http.js';

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
  const load = await postJson(info.url, token, '/graphs/load', {
    ...loadBody(definition, env.project, { only: { kind: 'fresh' } }, 0),
  });
  responses.push(load.text);
  assert.equal(load.status, 200);
  assert.equal(load.body?.['ok'], true);
  assert.equal(load.body?.['status']?.['graphId'], 'main');
  assert.equal(load.body?.['status']?.['rest'], true);
  bodies.push(load.body);

  const list = await getJson(info.url, token, '/status');
  responses.push(list.text);
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.body?.['status']));
  assert.equal(list.body?.['status']?.[0]?.['graphId'], 'main');
  bodies.push(list.body);

  const one = await getJson(info.url, token, '/status/main');
  responses.push(one.text);
  assert.equal(one.status, 200);
  assert.equal(one.body?.['status']?.['graphId'], 'main');
  bodies.push(one.body);

  const trigger = await postJson(info.url, token, '/trigger', {
    graphId: 'main',
    nodeId: 'only',
    value: { kind: 'text', text: INPUT_SECRET },
  });
  responses.push(trigger.text);
  assert.equal(trigger.status, 200);
  assert.equal(trigger.body?.['result']?.['rest'], true);
  assert.equal(trigger.body?.['result']?.['persisted'], true);
  assert.ok((trigger.body?.['result']?.['pumps'] as number) >= 1);
  bodies.push(trigger.body);

  const after = await getJson(info.url, token, '/status/main');
  responses.push(after.text);
  assert.equal(after.status, 200);
  assert.equal(after.body?.['status']?.['rest'], true);
  assert.equal(after.body?.['status']?.['nodes']?.[0]?.['queue'], 0);
  bodies.push(after.body);

  const unload = await postJson(info.url, token, '/graphs/unload', { graphId: 'main' });
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

  const gone = await getJson(info.url, token, '/status/main');
  responses.push(gone.text);
  assert.equal(gone.status, 404);
  bodies.push(gone.body);

  assert.equal(env.adapter.prompts.length, 1);
  assert.equal(env.adapter.prompts[0]?.includes(PROMPT_SECRET), true);
  assert.equal(env.adapter.prompts[0]?.includes(INPUT_SECRET), true);

  assertNoSecrets(`${responses.join('\n')}\n${logs.join('\n')}`, token);
  for (const key of collectKeys(bodies)) {
    assert.equal(
      ['prompt', 'output', 'token', 'value', 'pheromones'].includes(key),
      false,
      `response leaked key '${key}'`,
    );
  }
});

test('GET /graphs/<id>/output returns sorted forager output and never logs values', async (t) => {
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
  const load = await postJson(info.url, token, '/graphs/load', {
    ...loadBody(
      definition,
      env.project,
      { zeta: { kind: 'fresh' }, alpha: { kind: 'fresh' } },
      60_000,
    ),
  });
  assert.equal(load.status, 200);

  // Loaded but no completed execution: an empty array, never a 404.
  const empty = await getJson(info.url, token, '/graphs/outputs/output');
  assert.equal(empty.status, 200);
  assert.equal(empty.body?.['ok'], true);
  assert.equal(empty.body?.['graphId'], 'outputs');
  assert.deepEqual(empty.body?.['outputs'], []);

  let latestRunId = '';
  for (const nodeId of ['zeta', 'alpha']) {
    const trigger = await postJson(info.url, token, '/trigger', {
      graphId: 'outputs',
      nodeId,
      value: { kind: 'text', text: `${nodeId}-input` },
    });
    assert.equal(trigger.status, 200);
    assert.equal(typeof trigger.body?.['result']?.['runId'], 'string');
    assert.equal(typeof trigger.body?.['result']?.['requestId'], 'string');
    latestRunId = trigger.body?.['result']?.['runId'] as string;
  }

  const response = await getJson(info.url, token, '/graphs/outputs/output');
  assert.equal(response.status, 200);
  assert.equal(response.body?.['ok'], true);
  assert.equal(response.body?.['graphId'], 'outputs');
  assert.equal(response.body?.['runId'], latestRunId);
  assert.deepEqual(response.body?.['outputs'], [
    { nodeId: 'alpha', value: { kind: 'text', text: OUTPUT_SECRET } },
    { nodeId: 'zeta', value: { kind: 'text', text: OUTPUT_SECRET } },
  ]);
  // An explicit runId reads that run; an unknown one is a 404.
  const explicitRun = await getJson(
    info.url,
    token,
    `/graphs/outputs/output?runId=${latestRunId}`,
  );
  assert.equal(explicitRun.status, 200);
  assert.deepEqual(explicitRun.body?.['outputs'], response.body?.['outputs']);
  const unknownRun = await getJson(info.url, token, '/graphs/outputs/output?runId=missing');
  assert.equal(unknownRun.status, 404);

  // The graph-scoped route is separate from the existing status route.
  const status = await getJson(info.url, token, '/status/outputs');
  assert.equal(status.status, 200);

  const unknown = await getJson(info.url, token, '/graphs/missing/output');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body?.['code'], 'not-found');

  const tooLong = await getJson(info.url, token, `/graphs/${'a'.repeat(513)}/output`);
  assert.equal(tooLong.status, 404);

  const wrongMethod = await postJson(info.url, token, '/graphs/outputs/output', {});
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.body?.['code'], 'method-not-allowed');

  // Run output survives unload; the durable run is the default after unload.
  const unload = await postJson(info.url, token, '/graphs/unload', { graphId: 'outputs' });
  assert.equal(unload.status, 200);
  const afterUnload = await getJson(info.url, token, '/graphs/outputs/output');
  assert.equal(afterUnload.status, 200);
  assert.equal(afterUnload.body?.['runId'], latestRunId);
  assert.deepEqual(afterUnload.body?.['outputs'], response.body?.['outputs']);
  const retainedRun = await getJson(
    info.url,
    token,
    `/graphs/outputs/output?runId=${latestRunId}`,
  );
  assert.equal(retainedRun.status, 200);
  assert.deepEqual(retainedRun.body?.['outputs'], response.body?.['outputs']);

  // Metadata-only logging: no output value, prompt or bearer token.
  const logText = logs.join('\n');
  assert.equal(logText.includes(OUTPUT_SECRET), false);
  assert.equal(logText.includes(PROMPT_SECRET), false);
  assert.equal(logText.includes(token), false);
  assert.match(logText, /path=\/graphs\/outputs\/output status=200/);
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

  const unknownStatus = await getJson(info.url, token, '/status/missing');
  assert.equal(unknownStatus.status, 404);
  assert.equal(unknownStatus.body?.['code'], 'not-found');

  const unknownTrigger = await postJson(info.url, token, '/trigger', {
    graphId: 'missing',
    nodeId: 'only',
    value: { kind: 'text', text: 'x' },
  });
  assert.equal(unknownTrigger.status, 404);

  const unknownUnload = await postJson(info.url, token, '/graphs/unload', {
    graphId: 'missing',
  });
  assert.equal(unknownUnload.status, 404);

  const definition = foragerDefinition('dup', 'dup {{input}}');
  const body = loadBody(definition, env.project, { only: { kind: 'fresh' } });
  const first = await postJson(info.url, token, '/graphs/load', body);
  assert.equal(first.status, 200);
  const created = env.adapter.displayNames.length;
  assert.equal(created, 1);

  const duplicate = await postJson(info.url, token, '/graphs/load', body);
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body?.['code'], 'conflict');
  assert.equal(duplicate.body?.['status']?.['graphId'], 'dup');
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
  const load = await postJson(
    info.url,
    token,
    '/graphs/load',
    loadBody(definition, env.project, {}, 0),
  );
  assert.equal(load.status, 200);
  assert.equal(load.body?.['status']?.['rest'], true);

  const trigger = await postJson(info.url, token, '/trigger', {
    graphId: 'hover',
    nodeId: 'ask',
    value: { kind: 'text', text: INPUT_SECRET },
  });
  assert.equal(trigger.status, 200);
  assert.equal(trigger.body?.['result']?.['rest'], false);
  assert.equal(trigger.body?.['result']?.['hovered'], true);

  const unload = await postJson(info.url, token, '/graphs/unload', { graphId: 'hover' });
  assert.equal(unload.status, 409);
  assert.equal(unload.body?.['code'], 'conflict');
  assert.equal(unload.body?.['status']?.['graphId'], 'hover');
  assert.equal(unload.body?.['status']?.['rest'], false);
  assert.equal(unload.body?.['status']?.['hovered'], true);

  const still = await getJson(info.url, token, '/status/hover');
  assert.equal(still.status, 200);
  assert.equal(still.body?.['status']?.['rest'], false);
});

test('sweep reports skips and unloads expired graphs', async (t) => {
  const clock = new FakeClock(1_000);
  const env = makeEnv();
  t.after(async () => {
    await env.workspace.stop();
  });
  const running = await startServer(env, { now: clock.now });
  t.after(async () => {
    await running.server.stop();
  });
  const { info, token } = running;

  const definition = foragerDefinition('sweepme', 'sweep {{input}}');
  const load = await postJson(
    info.url,
    token,
    '/graphs/load',
    loadBody(definition, env.project, { only: { kind: 'fresh' } }, 100),
  );
  assert.equal(load.status, 200);
  assert.equal(load.body?.['status']?.['residency']?.['idleTtlMs'], 100);
  assert.equal(load.body?.['status']?.['residency']?.['nextEvictionAt'], 1_100);
  assert.equal(env.registry.list().length, 1);

  clock.advance(50);
  const early = await postJson(info.url, token, '/sweep', {});
  assert.equal(early.status, 200);
  assert.deepEqual(early.body?.['report']?.['unloaded'], []);
  assert.deepEqual(early.body?.['report']?.['skipped'], [
    { id: 'sweepme', reason: 'not-expired' },
  ]);
  assert.equal(env.registry.list().length, 1);

  clock.advance(50);
  const expired = await postJson(info.url, token, '/sweep', {});
  assert.equal(expired.status, 200);
  assert.deepEqual(expired.body?.['report']?.['unloaded'], ['sweepme']);
  // A sweep releases the graph but retains the sessions it created.
  assert.equal(env.registry.list().length, 1);

  const gone = await getJson(info.url, token, '/status/sweepme');
  assert.equal(gone.status, 404);
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
  const load = await postJson(
    info.url,
    token,
    '/graphs/load',
    loadBody(definition, env.project, {}, 0),
  );
  responses.push(load.text);
  assert.equal(load.status, 200);

  const trigger = await postJson(info.url, token, '/trigger', {
    graphId: 'answer-memory',
    nodeId: 'ask',
    value: { kind: 'text', text: INPUT_SECRET },
  });
  responses.push(trigger.text);
  assert.equal(trigger.status, 200);
  assert.equal(trigger.body?.['result']?.['hovered'], true);
  const hoverToken = hoverTokenOf(running.server, 'answer-memory', 'ask');

  const wrongToken = await postJson(info.url, token, '/answer', {
    graphId: 'answer-memory',
    nodeId: 'ask',
    value: { kind: 'text', text: INPUT_SECRET },
    token: 'hv_wrong',
  });
  responses.push(wrongToken.text);
  assert.equal(wrongToken.status, 409);
  assert.equal(wrongToken.body?.['code'], 'conflict');
  assert.match(wrongToken.body?.['error'] ?? '', /hover is not open/);
  assert.equal(wrongToken.text.includes('hv_wrong'), false);
  assert.equal(wrongToken.text.includes(hoverToken), false);

  for (const badToken of ['', `bad\u0000token`, `bad\u0007token`, 'x'.repeat(4_097)]) {
    const rejected = await postJson(info.url, token, '/answer', {
      graphId: 'answer-memory',
      nodeId: 'ask',
      value: { kind: 'text', text: 'x' },
      token: badToken,
    });
    responses.push(rejected.text);
    assert.equal(rejected.status, 400, JSON.stringify(badToken.slice(0, 8)));
    assert.equal(rejected.body?.['code'], 'bad-request');
  }
  for (const badGraphRef of ['', '   ', `bad\u0000path`, `bad\u0007path`, 'x'.repeat(4_097)]) {
    const rejected = await postJson(info.url, token, '/answer', {
      graphId: 'answer-memory',
      nodeId: 'ask',
      value: { kind: 'text', text: 'x' },
      graphRef: badGraphRef,
    });
    responses.push(rejected.text);
    assert.equal(rejected.status, 400, JSON.stringify(badGraphRef.slice(0, 8)));
    assert.equal(rejected.body?.['code'], 'bad-request');
  }

  const answered = await postJson(info.url, token, '/answer', {
    graphId: 'answer-memory',
    nodeId: 'ask',
    value: { kind: 'text', text: INPUT_SECRET },
    token: hoverToken,
  });
  responses.push(answered.text);
  assert.equal(answered.status, 200);
  assert.equal(answered.body?.['result']?.['rest'], true);
  assert.equal(answered.body?.['result']?.['hovered'], false);
  assert.equal(answered.body?.['result']?.['persisted'], true);
  assert.equal(typeof answered.body?.['result']?.['runId'], 'string');
  assert.equal(typeof answered.body?.['result']?.['requestId'], 'string');
  assert.equal(answered.body?.['result']?.['status']?.['rest'], true);

  const again = await postJson(info.url, token, '/answer', {
    graphId: 'answer-memory',
    nodeId: 'ask',
    value: { kind: 'text', text: 'again' },
  });
  responses.push(again.text);
  assert.equal(again.status, 409);
  assert.equal(again.body?.['code'], 'conflict');

  const unknownGraph = await postJson(info.url, token, '/answer', {
    graphId: 'missing',
    nodeId: 'ask',
    value: { kind: 'text', text: 'x' },
  });
  responses.push(unknownGraph.text);
  assert.equal(unknownGraph.status, 404);

  const unknownNode = await postJson(info.url, token, '/answer', {
    graphId: 'answer-memory',
    nodeId: 'absent',
    value: { kind: 'text', text: 'x' },
  });
  responses.push(unknownNode.text);
  assert.equal(unknownNode.status, 400);

  const foragerDefinitionBody = foragerDefinition('answer-forager', 'run {{input}}');
  const foragerLoad = await postJson(
    info.url,
    token,
    '/graphs/load',
    loadBody(foragerDefinitionBody, env.project, { only: { kind: 'fresh' } }, 0),
  );
  responses.push(foragerLoad.text);
  assert.equal(foragerLoad.status, 200);
  const nonUser = await postJson(info.url, token, '/answer', {
    graphId: 'answer-forager',
    nodeId: 'only',
    value: { kind: 'text', text: 'x' },
  });
  responses.push(nonUser.text);
  assert.equal(nonUser.status, 400);
  assert.equal(nonUser.body?.['code'], 'bad-request');

  const getAnswer = await getJson(info.url, token, '/answer');
  responses.push(getAnswer.text);
  assert.equal(getAnswer.status, 405);
  assert.match(getAnswer.headers.get('allow') ?? '', /POST/);

  assertNoSecrets(`${responses.join('\n')}\n${logs.join('\n')}`, token);
});

test('answer with a graphRef loads the manifest, restores a flushed hover and answers it', async (t) => {
  const clock = new FakeClock(1_000);
  const env = makeEnv();
  t.after(async () => {
    await env.workspace.stop();
  });
  const running = await startServer(env, {
    allowHoverUnload: true,
    now: clock.now,
  });
  t.after(async () => {
    await running.server.stop();
  });
  const { info, token } = running;

  const composition = userForagerComposition('answer-lazy');
  const bindings = { idle: { kind: 'fresh' } };
  const fixture = writeManifestFixture(env, {
    graphId: 'answer-lazy',
    composition,
    bindings,
  });

  const load = await postJson(
    info.url,
    token,
    '/graphs/load',
    loadBody(composition, env.project, bindings, 0),
  );
  assert.equal(load.status, 200);
  assert.equal(env.adapter.displayNames.length, 1);

  const trigger = await postJson(info.url, token, '/trigger', {
    graphId: 'answer-lazy',
    nodeId: 'ask',
    value: { kind: 'text', text: 'waiting' },
  });
  assert.equal(trigger.status, 200);
  assert.equal(trigger.body?.['result']?.['hovered'], true);

  // waxd-style hover unload: the hover is flushed to Honey before release.
  const unload = await postJson(info.url, token, '/graphs/unload', {
    graphId: 'answer-lazy',
  });
  assert.equal(unload.status, 200);
  assert.equal(unload.body?.['unloaded'], true);
  // The flushed hover's session is retained by the unload.
  assert.equal(env.registry.list().length, 1);
  assert.equal(env.adapter.displayNames.length, 1);

  const answered = await postJson(info.url, token, '/answer', {
    graphId: 'answer-lazy',
    nodeId: 'ask',
    value: { kind: 'text', text: 'answered' },
    graphRef: fixture.manifestPath,
  });
  assert.equal(answered.status, 200);
  assert.equal(answered.body?.['result']?.['rest'], true);
  assert.equal(answered.body?.['result']?.['hovered'], false);
  assert.equal(answered.body?.['result']?.['persisted'], true);
  // The lazy load created a replacement fresh session; the retained one stays
  // registered and the hover was restored.
  assert.equal(env.adapter.displayNames.length, 2);
  assert.equal(env.adapter.prompts.length, 0);
  assert.equal(env.registry.list().length, 2);

  const status = await getJson(info.url, token, '/status/answer-lazy');
  assert.equal(status.status, 200);
  assert.equal(status.body?.['status']?.['rest'], true);

  // A loaded graph always wins over graphRef, even a broken one.
  // The restored ask node was last activated at the frozen clock time, so let
  // its 1000ms pacing elapse before triggering it again.
  clock.advance(1_000);
  const parkAgain = await postJson(info.url, token, '/trigger', {
    graphId: 'answer-lazy',
    nodeId: 'ask',
    value: { kind: 'text', text: 'waiting again' },
  });
  assert.equal(parkAgain.body?.['result']?.['hovered'], true);
  const memoryWins = await postJson(info.url, token, '/answer', {
    graphId: 'answer-lazy',
    nodeId: 'ask',
    value: { kind: 'text', text: 'answered from memory' },
    graphRef: join(fixture.root, 'absent.wax.json'),
  });
  assert.equal(memoryWins.status, 200);
  assert.equal(memoryWins.body?.['result']?.['rest'], true);
  assert.equal(env.adapter.displayNames.length, 2);
});

test('answer with a graphRef rejects bad manifests, nodes and bindings with 0 sessions', async (t) => {
  const env = makeEnv();
  t.after(async () => {
    await env.workspace.stop();
  });
  const running = await startServer(env);
  t.after(async () => {
    await running.server.stop();
  });
  const { info, token } = running;

  const notLoaded = await postJson(info.url, token, '/answer', {
    graphId: 'not-loaded',
    nodeId: 'ask',
    value: { kind: 'text', text: 'x' },
  });
  assert.equal(notLoaded.status, 404);
  assert.equal(notLoaded.body?.['code'], 'not-found');

  const foragerOnly = writeManifestFixture(env, { graphId: 'forager-only' });
  for (const nodeId of ['only', 'absent']) {
    const rejected = await postJson(info.url, token, '/answer', {
      graphId: 'forager-only',
      nodeId,
      value: { kind: 'text', text: 'x' },
      graphRef: foragerOnly.manifestPath,
    });
    assert.equal(rejected.status, 400, nodeId);
    assert.equal(rejected.body?.['code'], 'bad-request');
  }

  const missingManifest = await postJson(info.url, token, '/answer', {
    graphId: 'missing-manifest',
    nodeId: 'ask',
    value: { kind: 'text', text: 'x' },
    graphRef: join(foragerOnly.root, 'absent.wax.json'),
  });
  assert.equal(missingManifest.status, 400);

  // A user+forager composition with no forager binding fails semantic binding
  // validation before any session exists.
  const badBindings = writeManifestFixture(env, {
    graphId: 'bad-bindings-answer',
    composition: userForagerComposition('bad-bindings-answer'),
    bindings: {},
  });
  const bindings = await postJson(info.url, token, '/answer', {
    graphId: 'bad-bindings-answer',
    nodeId: 'ask',
    value: { kind: 'text', text: 'x' },
    graphRef: badBindings.manifestPath,
  });
  assert.equal(bindings.status, 400);
  assert.equal(bindings.body?.['code'], 'bad-request');

  assert.equal(env.adapter.displayNames.length, 0);
  assert.equal(env.adapter.prompts.length, 0);
  assert.equal(env.registry.list().length, 0);
});
