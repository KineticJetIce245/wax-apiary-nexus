import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { SteppedFakeAdapter } from './support/control-server-adapters.js';
import {
  makeEnvWithAdapter,
  startServer,
  type RunningServer,
  type TestEnv,
} from './support/control-server-fixtures.js';
import { getJson, liveFrom, postJson, readResponse } from './support/control-server-http.js';

const PROMPT_SECRET = 'M16B-PROMPT-SECRET';
const INPUT_A = 'alpha';
const INPUT_B = 'beta';

function definition(id: string, prompt: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id,
    nodes: {
      only: { kind: 'forager', config: { connection: 'fake', prompt } },
    },
    edges: [],
  };
}

interface QueueEnv {
  readonly adapter: SteppedFakeAdapter;
  readonly env: TestEnv;
  readonly running: RunningServer;
  readonly sessionId: string;
  wake(liveId: string, input: string): ReturnType<typeof postJson>;
  queue(queueId: string): ReturnType<typeof getJson>;
  createSession(): Promise<string>;
  loadWithSession(liveId: string, prompt: string, sessionId: string): Promise<void>;
}

interface QueueEnvOptions {
  readonly promptA?: string;
  readonly promptB?: string;
}

async function setup(options: QueueEnvOptions = {}): Promise<QueueEnv> {
  const adapter = new SteppedFakeAdapter({ outputPrefix: 'echo:' });
  const env = makeEnvWithAdapter(adapter);
  const running = await startServer(env, { liveProject: env.project });
  const session = await env.registry.create(env.project, { harness: 'codex' });
  const loadWithSession = async (
    liveId: string,
    prompt: string,
    sessionId: string,
  ): Promise<void> => {
    const bindings = { only: { kind: 'session', sessionId } };
    const live = liveFrom(definition(liveId, prompt), bindings, liveId);
    const response = await postJson(running.info.url, running.token, '/lives', { live });
    assert.equal(response.status, 200, response.text);
  };
  await loadWithSession('first', options.promptA ?? `${PROMPT_SECRET} A:{{input}}`, session.sessionId);
  await loadWithSession('second', options.promptB ?? `${PROMPT_SECRET} B:{{input}}`, session.sessionId);
  return {
    adapter,
    env,
    running,
    sessionId: session.sessionId,
    createSession: async () =>
      (await env.registry.create(env.project, { harness: 'codex' })).sessionId,
    loadWithSession,
    wake: (liveId, input) =>
      postJson(running.info.url, running.token, '/lives/wake', {
        liveId,
        beeId: 'only',
        input,
      }),
    queue: (queueId) =>
      getJson(running.info.url, running.token, `/queues/${encodeURIComponent(queueId)}`),
  };
}

function stopCleanly(context: QueueEnv): () => Promise<void> {
  return async () => {
    context.adapter.finishAll();
    await context.running.server.stop().catch(() => undefined);
    await context.env.workspace.stop().catch(() => undefined);
  };
}

async function waitHeld(adapter: SteppedFakeAdapter, count: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (adapter.heldCount < count) {
    if (Date.now() > deadline) {
      assert.fail(`timed out waiting for ${String(count)} held submission(s)`);
    }
    await delay(5);
  }
}

async function until(
  check: () => Promise<boolean> | boolean,
  label: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) {
      assert.fail(`timed out waiting for ${label}`);
    }
    await delay(5);
  }
}

async function waitQueueStatus(
  context: QueueEnv,
  queueId: string,
  status: string,
): Promise<Record<string, any>> {
  await until(async () => {
    const response = await context.queue(queueId);
    return response.body?.['queue']?.['status'] === status;
  }, `queue '${queueId}' status '${status}'`);
  const response = await context.queue(queueId);
  assert.equal(response.status, 200, response.text);
  return response.body?.['queue'] as Record<string, any>;
}

test('an idle session keeps the synchronous 200 result', async (t) => {
  const context = await setup();
  t.after(stopCleanly(context));

  const wake = context.wake('first', INPUT_A);
  await waitHeld(context.adapter, 1);
  context.adapter.finishNext();
  const response = await wake;

  assert.equal(response.status, 200, response.text);
  assert.equal(response.body?.['ok'], true);
  assert.equal(response.body?.['status'], undefined);
  assert.equal(response.body?.['result']?.['liveId'], 'first');
  assert.equal(
    Object.hasOwn(response.body?.['result']?.['status'] ?? {}, 'graphId'),
    false,
  );
  assert.equal(typeof response.body?.['result']?.['runId'], 'string');
});

test('a busy shared session answers 200 queued and both output records stay separate', async (t) => {
  const context = await setup();
  t.after(stopCleanly(context));

  const firstWake = context.wake('first', INPUT_A);
  await waitHeld(context.adapter, 1);

  const queuedWake = await context.wake('second', INPUT_B);
  assert.equal(queuedWake.status, 200, queuedWake.text);
  assert.equal(queuedWake.body?.['ok'], true);
  assert.equal(queuedWake.body?.['status'], 'queued');
  assert.equal(queuedWake.body?.['result'], undefined);
  assert.equal(typeof queuedWake.body?.['queueId'], 'string');
  assert.equal(queuedWake.body?.['position'], 1);
  const queueId = String(queuedWake.body?.['queueId']);

  const view = await waitQueueStatus(context, queueId, 'queued');
  assert.equal(view['liveId'], 'second');
  assert.equal(view['beeId'], 'only');
  assert.equal(view['sessionId'], context.sessionId);
  assert.equal(view['position'], 1);
  assert.equal(view['runId'], undefined);
  assert.equal(JSON.stringify(view).includes(PROMPT_SECRET), false);

  // Finish the first live's run; the queue then promotes the second live.
  context.adapter.finishNext();
  const firstDone = await firstWake;
  assert.equal(firstDone.status, 200, firstDone.text);
  const firstRunId = String(firstDone.body?.['result']?.['runId']);
  await waitHeld(context.adapter, 1);
  await waitQueueStatus(context, queueId, 'running');

  context.adapter.finishNext();
  const completed = await waitQueueStatus(context, queueId, 'completed');
  const secondRunId = String(completed['runId']);
  assert.notEqual(secondRunId, firstRunId);

  const firstOutput = await getJson(
    context.running.info.url,
    context.running.token,
    `/lives/first/output?runId=${encodeURIComponent(firstRunId)}`,
  );
  assert.equal(firstOutput.status, 200, firstOutput.text);
  assert.equal(firstOutput.body?.['liveId'], 'first');
  assert.equal(firstOutput.body?.['outputs']?.[0]?.value?.text, `echo:${PROMPT_SECRET} A:${INPUT_A}`);

  const secondOutput = await getJson(
    context.running.info.url,
    context.running.token,
    `/lives/second/output?runId=${encodeURIComponent(secondRunId)}`,
  );
  assert.equal(secondOutput.status, 200, secondOutput.text);
  assert.equal(secondOutput.body?.['liveId'], 'second');
  assert.equal(secondOutput.body?.['outputs']?.[0]?.value?.text, `echo:${PROMPT_SECRET} B:${INPUT_B}`);

  // A run id belongs to exactly one live hive; reading it through the other is 404.
  const crossed = await getJson(
    context.running.info.url,
    context.running.token,
    `/lives/first/output?runId=${encodeURIComponent(secondRunId)}`,
  );
  assert.equal(crossed.status, 404);

  assert.equal(
    (await postJson(context.running.info.url, context.running.token, '/lives/unload', {
      liveId: 'first',
    })).status,
    200,
  );
  assert.equal(
    (await postJson(context.running.info.url, context.running.token, '/lives/unload', {
      liveId: 'second',
    })).status,
    200,
  );
});

test('queue reads require the bearer token, are GET-only, and reject unknown ids', async (t) => {
  const context = await setup();
  t.after(stopCleanly(context));

  const anonymous = await readResponse(
    await fetch(`${context.running.info.url}/queues/whatever`),
  );
  assert.equal(anonymous.status, 401, anonymous.text);
  assert.equal(anonymous.body?.['code'], 'unauthorized');

  const wrongToken = await readResponse(
    await fetch(`${context.running.info.url}/queues/whatever`, {
      headers: { authorization: 'Bearer not-the-daemon-token' },
    }),
  );
  assert.equal(wrongToken.status, 401, wrongToken.text);
  assert.equal(wrongToken.body?.['code'], 'unauthorized');

  const posted = await postJson(
    context.running.info.url,
    context.running.token,
    '/queues/whatever',
    {},
  );
  assert.equal(posted.status, 405, posted.text);
  assert.equal(posted.body?.['code'], 'method-not-allowed');
  assert.equal(posted.headers.get('allow'), 'GET');

  const missing = await context.queue('no-such-queue');
  assert.equal(missing.status, 404, missing.text);
  assert.equal(missing.body?.['code'], 'not-found');
  assert.equal(missing.body?.['error'], 'unknown queue item');
});

test('a full session queue does not block another session on the same daemon', async (t) => {
  const context = await setup();
  t.after(stopCleanly(context));
  const otherSessionId = await context.createSession();
  await context.loadWithSession('third', `${PROMPT_SECRET} C:{{input}}`, otherSessionId);

  const firstWake = context.wake('first', 'hold');
  await waitHeld(context.adapter, 1);
  const queueIds: string[] = [];
  for (let index = 0; index < 16; index += 1) {
    const queued = await context.wake('first', `wait-${String(index)}`);
    assert.equal(queued.status, 200, queued.text);
    assert.equal(queued.body?.['status'], 'queued');
    queueIds.push(String(queued.body?.['queueId']));
  }

  const overflow = await context.wake('first', 'overflow');
  assert.equal(overflow.status, 429, overflow.text);
  assert.equal(overflow.body?.['code'], 'queue-full');

  // live 'second' shares session-1, so it sees the same capacity limit.
  const sameSession = await context.wake('second', 'overflow-second');
  assert.equal(sameSession.status, 429, sameSession.text);
  assert.equal(sameSession.body?.['code'], 'queue-full');

  // live 'third' holds a different session and must run right away.
  const isolatedWake = context.wake('third', 'isolated');
  await waitHeld(context.adapter, 2);
  context.adapter.finishNext();
  assert.equal((await firstWake).status, 200);
  context.adapter.finishNext();
  const isolated = await isolatedWake;
  assert.equal(isolated.status, 200, isolated.text);
  assert.equal(isolated.body?.['status'], undefined);
  assert.equal(isolated.body?.['result']?.['liveId'], 'third');
  assert.equal(typeof isolated.body?.['result']?.['runId'], 'string');

  const promoted = await waitQueueStatus(context, queueIds[0]!, 'running');
  assert.equal(promoted['position'], undefined);
  const last = await context.queue(queueIds[15]!);
  assert.equal(last.body?.['queue']?.['sessionId'], context.sessionId);
  assert.equal(last.body?.['queue']?.['status'], 'queued');
  assert.equal(last.body?.['queue']?.['position'], 15);
});

test('three live hives on one session run in FIFO order', async (t) => {
  const context = await setup();
  t.after(stopCleanly(context));
  await context.loadWithSession('third', `${PROMPT_SECRET} C:{{input}}`, context.sessionId);

  const firstWake = context.wake('first', INPUT_A);
  await waitHeld(context.adapter, 1);
  const secondWake = await context.wake('second', INPUT_B);
  assert.equal(secondWake.status, 200, secondWake.text);
  assert.equal(secondWake.body?.['status'], 'queued');
  assert.equal(secondWake.body?.['position'], 1);
  const secondQueueId = String(secondWake.body?.['queueId']);

  const thirdWake = await context.wake('third', 'gamma');
  assert.equal(thirdWake.status, 200, thirdWake.text);
  assert.equal(thirdWake.body?.['status'], 'queued');
  assert.equal(thirdWake.body?.['position'], 2);
  const thirdQueueId = String(thirdWake.body?.['queueId']);

  const secondQueued = await waitQueueStatus(context, secondQueueId, 'queued');
  assert.equal(secondQueued['liveId'], 'second');
  assert.equal(secondQueued['position'], 1);
  const thirdQueued = await waitQueueStatus(context, thirdQueueId, 'queued');
  assert.equal(thirdQueued['liveId'], 'third');
  assert.equal(thirdQueued['position'], 2);

  context.adapter.finishNext();
  const firstDone = await firstWake;
  assert.equal(firstDone.status, 200, firstDone.text);
  const firstRunId = String(firstDone.body?.['result']?.['runId']);

  await waitHeld(context.adapter, 1);
  const secondRunning = await waitQueueStatus(context, secondQueueId, 'running');
  assert.equal(secondRunning['position'], undefined);
  const thirdWaiting = await context.queue(thirdQueueId);
  assert.equal(thirdWaiting.body?.['queue']?.['status'], 'queued');
  assert.equal(thirdWaiting.body?.['queue']?.['position'], 1);

  context.adapter.finishNext();
  const secondCompleted = await waitQueueStatus(context, secondQueueId, 'completed');
  const secondRunId = String(secondCompleted['runId']);

  await waitHeld(context.adapter, 1);
  const thirdRunning = await waitQueueStatus(context, thirdQueueId, 'running');
  assert.equal(thirdRunning['position'], undefined);
  context.adapter.finishNext();
  const thirdCompleted = await waitQueueStatus(context, thirdQueueId, 'completed');
  const thirdRunId = String(thirdCompleted['runId']);
  assert.notEqual(secondRunId, firstRunId);
  assert.notEqual(thirdRunId, secondRunId);
  assert.notEqual(thirdRunId, firstRunId);

  const firstOutput = await getJson(
    context.running.info.url,
    context.running.token,
    `/lives/first/output?runId=${encodeURIComponent(firstRunId)}`,
  );
  assert.equal(firstOutput.status, 200, firstOutput.text);
  assert.equal(firstOutput.body?.['liveId'], 'first');
  assert.equal(
    firstOutput.body?.['outputs']?.[0]?.value?.text,
    `echo:${PROMPT_SECRET} A:${INPUT_A}`,
  );
  const secondOutput = await getJson(
    context.running.info.url,
    context.running.token,
    `/lives/second/output?runId=${encodeURIComponent(secondRunId)}`,
  );
  assert.equal(secondOutput.status, 200, secondOutput.text);
  assert.equal(secondOutput.body?.['liveId'], 'second');
  assert.equal(
    secondOutput.body?.['outputs']?.[0]?.value?.text,
    `echo:${PROMPT_SECRET} B:${INPUT_B}`,
  );
  const thirdOutput = await getJson(
    context.running.info.url,
    context.running.token,
    `/lives/third/output?runId=${encodeURIComponent(thirdRunId)}`,
  );
  assert.equal(thirdOutput.status, 200, thirdOutput.text);
  assert.equal(thirdOutput.body?.['liveId'], 'third');
  assert.equal(
    thirdOutput.body?.['outputs']?.[0]?.value?.text,
    `echo:${PROMPT_SECRET} C:gamma`,
  );

  // Durable run records, not the fake's prompt list, prove the serial order.
  const secondStartedAt = Date.parse(String(secondOutput.body?.['startedAt']));
  const thirdStartedAt = Date.parse(String(thirdOutput.body?.['startedAt']));
  assert.ok(
    secondStartedAt >= Date.parse(String(firstOutput.body?.['finishedAt'])),
    'the second run must not start before the first run finished',
  );
  assert.ok(
    thirdStartedAt >= Date.parse(String(secondOutput.body?.['finishedAt'])),
    'the third run must not start before the second run finished',
  );

  for (const liveId of ['first', 'second', 'third']) {
    assert.equal(
      (await postJson(context.running.info.url, context.running.token, '/lives/unload', {
        liveId,
      })).status,
      200,
    );
  }
});

test('a full queue answers 429 queue-full', async (t) => {
  const context = await setup();
  t.after(stopCleanly(context));

  const firstWake = context.wake('first', 'hold');
  await waitHeld(context.adapter, 1);
  const queueIds: string[] = [];
  for (let index = 0; index < 16; index += 1) {
    const queued = await context.wake('first', `run-${String(index)}`);
    assert.equal(queued.status, 200, queued.text);
    assert.equal(queued.body?.['status'], 'queued');
    queueIds.push(String(queued.body?.['queueId']));
  }

  const overflow = await context.wake('first', 'overflow');
  assert.equal(overflow.status, 429, overflow.text);
  assert.equal(overflow.body?.['ok'], false);
  assert.equal(overflow.body?.['code'], 'queue-full');
  assert.equal(overflow.body?.['error'], 'session queue is full');
  assert.equal(overflow.text.includes(PROMPT_SECRET), false);

  // Drain: one running plus sixteen waiting executions.
  context.adapter.finishNext();
  assert.equal((await firstWake).status, 200);
  for (let index = 0; index < queueIds.length; index += 1) {
    await waitHeld(context.adapter, 1);
    context.adapter.finishNext();
  }
  await until(async () => {
    for (const queueId of queueIds) {
      const view = await context.queue(queueId);
      if (view.body?.['queue']?.['status'] !== 'completed') {
        return false;
      }
    }
    return true;
  }, 'all queued runs completed');

  assert.equal(
    (await postJson(context.running.info.url, context.running.token, '/lives/unload', {
      liveId: 'first',
    })).status,
    200,
  );
});

test('unloading a live drops its waiting wakes but not the running one', async (t) => {
  const context = await setup();
  t.after(stopCleanly(context));

  const firstWake = context.wake('first', INPUT_A);
  await waitHeld(context.adapter, 1);
  const queued = await context.wake('second', INPUT_B);
  assert.equal(queued.body?.['status'], 'queued');
  const queueId = String(queued.body?.['queueId']);

  const unloaded = await postJson(context.running.info.url, context.running.token, '/lives/unload', {
    liveId: 'second',
  });
  assert.equal(unloaded.status, 200, unloaded.text);

  const dropped = await waitQueueStatus(context, queueId, 'dropped');
  assert.equal(dropped['runId'], undefined);

  context.adapter.finishNext();
  assert.equal((await firstWake).status, 200);
  await delay(20);
  // The dropped run never reached the native session.
  assert.equal(context.adapter.prompts.length, 1);
  assert.equal(context.adapter.heldCount, 0);

  assert.equal(
    (await postJson(context.running.info.url, context.running.token, '/lives/unload', {
      liveId: 'first',
    })).status,
    200,
  );
});

test('a queue id does not survive a daemon restart', async (t) => {
  const context = await setup();
  let restarted: RunningServer | undefined;
  t.after(async () => {
    context.adapter.finishAll();
    await restarted?.server.stop().catch(() => undefined);
    await context.running.server.stop().catch(() => undefined);
    await context.env.workspace.stop().catch(() => undefined);
  });

  const firstWake = context.wake('first', INPUT_A);
  await waitHeld(context.adapter, 1);
  const queued = await context.wake('second', INPUT_B);
  assert.equal(queued.body?.['status'], 'queued');
  const queueId = String(queued.body?.['queueId']);
  const promptsBeforeRestart = context.adapter.prompts.length;
  assert.equal(promptsBeforeRestart, 1);

  await context.running.server.stop();
  await firstWake.catch(() => undefined);
  // A daemon that promoted or replayed the waiting item would submit a second
  // native prompt; the in-memory queue must drop it instead.
  await delay(50);
  assert.equal(context.adapter.prompts.length, promptsBeforeRestart);

  restarted = await startServer(context.env, { liveProject: context.env.project });
  const afterRestart = await getJson(
    restarted.info.url,
    restarted.token,
    `/queues/${encodeURIComponent(queueId)}`,
  );
  assert.equal(afterRestart.status, 404, afterRestart.text);
  assert.equal(afterRestart.body?.['code'], 'not-found');
  // Recovery must not replay the side-effecting queued job either.
  await delay(50);
  assert.equal(context.adapter.prompts.length, promptsBeforeRestart);
});
