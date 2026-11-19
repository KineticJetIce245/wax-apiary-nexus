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
import { getJson, liveFrom, postJson } from './support/control-server-http.js';

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
  const bindings = { only: { kind: 'session', sessionId: session.sessionId } };
  const load = async (liveId: string, prompt: string): Promise<void> => {
    const live = liveFrom(definition(liveId, prompt), bindings, liveId);
    const response = await postJson(running.info.url, running.token, '/lives', { live });
    assert.equal(response.status, 200, response.text);
  };
  await load('first', options.promptA ?? `${PROMPT_SECRET} A:{{input}}`);
  await load('second', options.promptB ?? `${PROMPT_SECRET} B:{{input}}`);
  return {
    adapter,
    env,
    running,
    sessionId: session.sessionId,
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
  assert.equal(response.body?.['result']?.['graphId'], 'first');
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

  await context.running.server.stop();
  await firstWake.catch(() => undefined);

  restarted = await startServer(context.env, { liveProject: context.env.project });
  const afterRestart = await getJson(
    restarted.info.url,
    restarted.token,
    `/queues/${encodeURIComponent(queueId)}`,
  );
  assert.equal(afterRestart.status, 404, afterRestart.text);
  assert.equal(afterRestart.body?.['code'], 'not-found');
});
