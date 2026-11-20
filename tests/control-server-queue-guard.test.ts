import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { GuardedEchoAdapter } from './support/control-server-adapters.js';
import {
  makeEnvWithAdapter,
  startServer,
  type RunningServer,
  type TestEnv,
} from './support/control-server-fixtures.js';
import { getJson, liveFrom, postJson } from './support/control-server-http.js';

const PROMPT_SECRET = 'M16D-GUARD-PROMPT';
const INPUT_A = 'alpha';
const INPUT_B = 'beta';
const GUARD_OUTPUT_PREFIX = 'guarded:';

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

interface GuardContext {
  readonly adapter: GuardedEchoAdapter;
  readonly env: TestEnv;
  readonly running: RunningServer;
  readonly sessionId: string;
}

async function setup(): Promise<GuardContext> {
  const adapter = new GuardedEchoAdapter({ outputPrefix: GUARD_OUTPUT_PREFIX });
  const env = makeEnvWithAdapter(adapter);
  const running = await startServer(env, { liveProject: env.project });
  const session = await env.registry.create(env.project, { harness: 'codex' });
  const load = async (liveId: string, prompt: string): Promise<void> => {
    const bindings = { only: { kind: 'session', sessionId: session.sessionId } };
    const live = liveFrom(definition(liveId, prompt), bindings, liveId);
    const response = await postJson(running.info.url, running.token, '/lives', { live });
    assert.equal(response.status, 200, response.text);
  };
  await load('first', `${PROMPT_SECRET} A:{{input}}`);
  await load('second', `${PROMPT_SECRET} B:{{input}}`);
  return { adapter, env, running, sessionId: session.sessionId };
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
    await delay(10);
  }
}

async function guardList(context: GuardContext): Promise<Record<string, any>[]> {
  const listed = await getJson(context.running.info.url, context.running.token, '/guards');
  assert.equal(listed.status, 200, listed.text);
  const guards = listed.body?.['guards'];
  assert.ok(Array.isArray(guards), 'guards response is not a list');
  return guards as Record<string, any>[];
}

async function waitGuard(context: GuardContext, liveId: string): Promise<Record<string, any>> {
  let found: Record<string, any> | undefined;
  await until(async () => {
    found = (await guardList(context)).find((guard) => guard['liveId'] === liveId);
    return found !== undefined;
  }, `a guard attributed to live '${liveId}'`);
  assert.ok(found !== undefined);
  return found;
}

async function waitQueueStatus(
  context: GuardContext,
  queueId: string,
  status: string,
): Promise<Record<string, any>> {
  await until(async () => {
    const response = await getJson(
      context.running.info.url,
      context.running.token,
      `/queues/${encodeURIComponent(queueId)}`,
    );
    assert.equal(response.status, 200, response.text);
    return response.body?.['queue']?.['status'] === status;
  }, `queue '${queueId}' status '${status}'`);
  const response = await getJson(
    context.running.info.url,
    context.running.token,
    `/queues/${encodeURIComponent(queueId)}`,
  );
  return response.body?.['queue'] as Record<string, any>;
}

test(
  'a queued wake parks no guard until the running guard is allowed',
  async (t) => {
    const context = await setup();
    t.after(async () => {
      await context.running.server.stop().catch(() => undefined);
      await context.env.workspace.stop().catch(() => undefined);
    });

    const firstWake = postJson(context.running.info.url, context.running.token, '/lives/wake', {
      liveId: 'first',
      beeId: 'only',
      input: INPUT_A,
    });
    const firstGuard = await waitGuard(context, 'first');
    assert.equal(firstGuard['beeId'], 'only');
    assert.equal(firstGuard['sessionId'], context.sessionId);
    assert.deepEqual(firstGuard['options'], ['allow_once', 'reject_once']);
    assert.equal(typeof firstGuard['createdAt'], 'string');
    const firstGuardJson = JSON.stringify(firstGuard);
    assert.equal(firstGuardJson.includes(PROMPT_SECRET), false);
    assert.equal(firstGuardJson.includes(GUARD_OUTPUT_PREFIX), false);
    assert.equal(firstGuardJson.includes(context.running.token), false);

    const queued = await postJson(context.running.info.url, context.running.token, '/lives/wake', {
      liveId: 'second',
      beeId: 'only',
      input: INPUT_B,
    });
    assert.equal(queued.status, 200, queued.text);
    assert.equal(queued.body?.['status'], 'queued', queued.text);
    assert.equal(queued.body?.['position'], 1);
    const queueId = String(queued.body?.['queueId']);
    await waitQueueStatus(context, queueId, 'queued');

    // Queueing is not executing: the second live must not open its own guard
    // while the first guard is still pending.
    await delay(50);
    const whileFirstGuarded = await guardList(context);
    assert.equal(whileFirstGuarded.length, 1);
    assert.equal(whileFirstGuarded[0]?.['liveId'], 'first');

    const allowFirst = await postJson(
      context.running.info.url,
      context.running.token,
      '/guard/decide',
      { requestId: firstGuard['requestId'], decision: 'allow_once' },
    );
    assert.equal(allowFirst.status, 200, allowFirst.text);
    const firstDone = await firstWake;
    assert.equal(firstDone.status, 200, firstDone.text);
    const firstRunId = String(firstDone.body?.['result']?.['runId']);
    assert.ok(firstRunId.length > 0);

    // Allowing the first run promotes the queued one, which parks its own guard
    // with its own attribution.
    const secondGuard = await waitGuard(context, 'second');
    assert.equal(secondGuard['beeId'], 'only');
    assert.equal(secondGuard['sessionId'], context.sessionId);
    assert.notEqual(secondGuard['requestId'], firstGuard['requestId']);
    const secondGuardJson = JSON.stringify(secondGuard);
    assert.equal(secondGuardJson.includes(PROMPT_SECRET), false);
    assert.equal(secondGuardJson.includes(GUARD_OUTPUT_PREFIX), false);
    const runningView = await waitQueueStatus(context, queueId, 'running');
    assert.equal(runningView['liveId'], 'second');
    assert.equal(runningView['position'], undefined);

    const allowSecond = await postJson(
      context.running.info.url,
      context.running.token,
      '/guard/decide',
      { requestId: secondGuard['requestId'], decision: 'allow_once' },
    );
    assert.equal(allowSecond.status, 200, allowSecond.text);
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
    assert.equal(
      firstOutput.body?.['outputs']?.[0]?.value?.text,
      `${GUARD_OUTPUT_PREFIX}${PROMPT_SECRET} A:${INPUT_A}`,
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
      `${GUARD_OUTPUT_PREFIX}${PROMPT_SECRET} B:${INPUT_B}`,
    );
    assert.notEqual(
      firstOutput.body?.['outputs']?.[0]?.value?.text,
      secondOutput.body?.['outputs']?.[0]?.value?.text,
    );

    const crossed = await getJson(
      context.running.info.url,
      context.running.token,
      `/lives/first/output?runId=${encodeURIComponent(secondRunId)}`,
    );
    assert.equal(crossed.status, 404);

    await until(async () => (await guardList(context)).length === 0, 'guards to drain');
    assert.deepEqual(
      context.adapter.approvals.map((decision) => decision.kind),
      ['allow_once', 'allow_once'],
    );
    assert.equal(context.adapter.prompts.length, 2);

    for (const liveId of ['first', 'second']) {
      assert.equal(
        (await postJson(context.running.info.url, context.running.token, '/lives/unload', {
          liveId,
        })).status,
        200,
      );
    }
  },
);
