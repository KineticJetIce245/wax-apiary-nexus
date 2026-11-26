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
import {
  getJson,
  liveFrom,
  postJson,
  waitForRest,
} from './support/control-server-http.js';

const OUTPUT_PREFIX = 'isolated:';

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

interface IsolationContext {
  readonly adapter: GuardedEchoAdapter;
  readonly env: TestEnv;
  readonly running: RunningServer;
  readonly sessionIds: ReadonlyMap<string, string>;
}

async function setup(): Promise<IsolationContext> {
  const adapter = new GuardedEchoAdapter({ outputPrefix: OUTPUT_PREFIX });
  const env = makeEnvWithAdapter(adapter);
  const running = await startServer(env, { liveProject: env.project });
  const sessionIds = new Map<string, string>();
  for (const liveId of ['alpha', 'beta']) {
    const session = await env.registry.create(env.project, { harness: 'codex' });
    sessionIds.set(liveId, session.sessionId);
    const bindings = { only: { kind: 'session', sessionId: session.sessionId } };
    const live = liveFrom(definition(liveId, `${liveId.toUpperCase()}:{{message}}`), bindings, liveId);
    const response = await postJson(running.info.url, running.token, '/lives', { live });
    assert.equal(response.status, 200, response.text);
  }
  return { adapter, env, running, sessionIds };
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

async function guardList(context: IsolationContext): Promise<Record<string, any>[]> {
  const listed = await getJson(context.running.info.url, context.running.token, '/guards');
  assert.equal(listed.status, 200, listed.text);
  const guards = listed.body?.['guards'];
  assert.ok(Array.isArray(guards), 'guards response is not a list');
  return guards as Record<string, any>[];
}

async function waitGuard(
  context: IsolationContext,
  liveId: string,
): Promise<Record<string, any>> {
  let found: Record<string, any> | undefined;
  await until(async () => {
    found = (await guardList(context)).find((guard) => guard['liveId'] === liveId);
    return found !== undefined;
  }, `a guard attributed to live '${liveId}'`);
  assert.ok(found !== undefined);
  return found;
}

async function decide(
  context: IsolationContext,
  requestId: string,
  decision: 'allow_once' | 'reject_once',
): Promise<void> {
  const response = await postJson(
    context.running.info.url,
    context.running.token,
    '/guard/decide',
    { requestId, decision },
  );
  assert.equal(response.status, 200, response.text);
}

/**
 * Two loaded lives on two different sessions. Each live has its own
 * WorkspaceForagerExecutor, but both executors subscribe to the whole
 * Workspace, so an idle live used to handle (and auto-reject) the other
 * live's approval. Only the executor that submitted the execution may decide.
 */
async function assertOnlyRunningGuard(
  url: string,
  token: string,
  liveId: string,
  requestId: string,
  idleLiveId: string,
): Promise<void> {
  const stillListed = await getJson(url, token, '/guards');
  assert.equal(stillListed.status, 200, stillListed.text);
  const guards = (stillListed.body?.['guards'] as Record<string, any>[]) ?? [];
  assert.ok(
    guards.some(
      (guard) => guard['liveId'] === liveId && guard['requestId'] === requestId,
    ),
    'the running live approval is no longer parked',
  );
  assert.equal(
    guards.some((guard) => guard['liveId'] === idleLiveId),
    false,
    'the idle co-loaded live parked a guard of its own',
  );
}

async function admitAlphaAgainstIdleLive(
  context: Awaited<ReturnType<typeof setup>>,
): Promise<Record<string, any>> {
  const alphaWake = postJson(context.running.info.url, context.running.token, '/lives/trigger', {
    liveId: 'alpha',
    beeId: 'only',
    input: 'one',
  });
  const alphaGuard = await waitGuard(context, 'alpha');
  assert.equal(alphaGuard['liveId'], 'alpha');
  assert.equal(alphaGuard['sessionId'], context.sessionIds.get('alpha'));

  // The idle second live must not touch this approval: no decision may reach
  // the adapter and the guard must stay pending for the running live.
  await delay(150);
  const stillPending = await guardList(context);
  assert.equal(stillPending.length, 1, JSON.stringify(stillPending));
  assert.equal(stillPending[0]?.['liveId'], 'alpha');
  assert.equal(stillPending[0]?.['requestId'], alphaGuard['requestId']);
  assert.equal(context.adapter.approvals.length, 0, 'an idle live rejected the approval');

  await decide(context, String(alphaGuard['requestId']), 'allow_once');
  const alphaDone = await alphaWake;
  assert.equal(alphaDone.status, 202, alphaDone.text);
  assert.equal(alphaDone.body?.['ok'], true);
  await waitForRest(
    context.running.info.url,
    context.running.token,
    'alpha',
  );
  await until(async () => (await guardList(context)).length === 0, 'the alpha guard to drain');
  return alphaGuard;
}

test('a co-loaded live on another session never decides the running live approval', async (t) => {
  const context = await setup();
  t.after(async () => {
    await context.running.server.stop().catch(() => undefined);
    await context.env.workspace.stop().catch(() => undefined);
  });

  const alphaGuard = await admitAlphaAgainstIdleLive(context);

  const betaWake = postJson(context.running.info.url, context.running.token, '/lives/trigger', {
    liveId: 'beta',
    beeId: 'only',
    input: 'two',
  });
  const betaGuard = await waitGuard(context, 'beta');
  assert.equal(betaGuard['sessionId'], context.sessionIds.get('beta'));
  assert.notEqual(betaGuard['requestId'], alphaGuard['requestId']);
  await decide(context, String(betaGuard['requestId']), 'allow_once');
  const betaDone = await betaWake;
  assert.equal(betaDone.status, 202, betaDone.text);
  assert.equal(betaDone.body?.['ok'], true);
  await waitForRest(
    context.running.info.url,
    context.running.token,
    'beta',
  );

  assert.deepEqual(
    context.adapter.approvals.map((decision) => decision.kind),
    ['allow_once', 'allow_once'],
  );
  for (const liveId of ['alpha', 'beta']) {
    const unloaded = await postJson(
      context.running.info.url,
      context.running.token,
      '/lives/unload',
      { liveId },
    );
    assert.equal(unloaded.status, 200, unloaded.text);
  }
});
