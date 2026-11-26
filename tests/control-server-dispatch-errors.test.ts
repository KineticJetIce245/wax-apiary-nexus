import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';

import {
  makeEnv,
  makeEnvWithAdapter,
  startServer,
  type RunningServer,
  type TestEnv,
} from './support/control-server-fixtures.js';
import {
  bLoad,
  bTrigger,
  postJson,
  waitForRest,
} from './support/control-server-http.js';
import { FakeAdapter } from './support/fake-adapter.js';

/**
 * Holds every submitted execution in `running` until the caller releases or
 * cancels it. A dispatch/trigger that must collide with a busy conversation
 * needs an adapter that never settles on its own.
 */
class HoldingAdapter extends FakeAdapter {
  readonly executionIds: string[] = [];

  override async submit(_nativeId: string, executionId: string, text: string): Promise<void> {
    this.prompts.push(text);
    this.executionIds.push(executionId);
  }

  override async cancel(_nativeId: string): Promise<void> {
    const executionId = this.executionIds.at(-1);
    if (executionId !== undefined) {
      this.emit({ type: 'execution/cancelled', executionId });
    }
  }

  /** Settle one held execution without cancelling the whole conversation. */
  release(executionId: string): void {
    this.emit({ type: 'execution/completed', executionId, stopReason: 'end_turn' });
  }
}

async function waitForPrompt(
  adapter: FakeAdapter,
  prompt: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!adapter.prompts.includes(prompt)) {
    assert.ok(Date.now() < deadline, `prompt never ran: ${prompt}`);
    await delay(5);
  }
}

async function startEnv(t: TestContext, env: TestEnv): Promise<RunningServer> {
  const running = await startServer(env, { liveProject: env.project });
  t.after(async () => {
    await running.server.stop();
    await env.workspace.stop();
  });
  return running;
}

test('dispatch on a busy conversation maps to 409 session-busy', async (t) => {
  const env = makeEnvWithAdapter(new HoldingAdapter());
  const running = await startEnv(t, env);
  const session = await env.registry.create(env.project, { harness: 'codex' });

  // A running execution holds the conversation; the adapter never settles it.
  await env.workspace.submit(session.sessionId, 'holds the conversation');

  const response = await postJson(running.info.url, running.token, '/dispatch', {
    input: 'next',
    sessionId: session.sessionId,
  });

  assert.equal(response.status, 409, response.text);
  assert.equal(response.body?.['code'], 'session-busy');
  assert.equal(response.body?.['error'], 'session is busy');
});

test('dispatch for an unknown session maps to 404 not-found', async (t) => {
  const env = makeEnv();
  const running = await startEnv(t, env);

  const response = await postJson(running.info.url, running.token, '/dispatch', {
    input: 'x',
    sessionId: 'missing-session',
  });

  assert.equal(response.status, 404, response.text);
  assert.equal(response.body?.['code'], 'not-found');
  assert.equal(response.body?.['error'], 'dispatch session is not registered');
});

test('conflicting dispatch session parameters map to 409 conflict', async (t) => {
  const env = makeEnv();
  const running = await startEnv(t, env);
  const session = await env.registry.create(env.project, {
    harness: 'codex',
    model: 'session-model',
  });

  const response = await postJson(running.info.url, running.token, '/dispatch', {
    input: 'x',
    sessionId: session.sessionId,
    sessionParams: { model: 'other-model' },
  });

  assert.equal(response.status, 409, response.text);
  assert.equal(response.body?.['code'], 'conflict');
  assert.equal(
    response.body?.['error'],
    'dispatch session parameters conflict with the session',
  );
});

test('an accepted dispatch never returns execution state or output', async (t) => {
  const env = makeEnvWithAdapter(new HoldingAdapter());
  const running = await startEnv(t, env);

  const response = await postJson(running.info.url, running.token, '/dispatch', {
    input: 'slow',
    sessionParams: { harness: 'codex' },
  });

  assert.equal(response.status, 202, response.text);
  assert.deepEqual(response.body, { ok: true });
  assert.equal(response.text.includes('output'), false);
  assert.equal(response.text.includes('timeout'), false);
});

function foragerDefinition(id: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id,
    nodes: {
      only: {
        kind: 'forager',
        config: { connection: 'codex', prompt: 'wake {{message}}' },
      },
    },
    edges: [],
  };
}

test(
  'a trigger that collides with a running dispatch is accepted but never runs twice',
  { timeout: 10_000 },
  async (t) => {
    const adapter = new HoldingAdapter();
    const env = makeEnvWithAdapter(adapter);
    const running = await startEnv(t, env);
    const session = await env.registry.create(env.project, { harness: 'codex' });

    const loaded = await bLoad(running.info.url, running.token, {
      definition: foragerDefinition('wake-vs-dispatch'),
      bindings: { only: { kind: 'session', sessionId: session.sessionId } },
      project: env.project,
    });
    assert.equal(loaded.status, 200, loaded.text);

    const dispatch = await postJson(running.info.url, running.token, '/dispatch', {
      input: 'holds the conversation',
      sessionId: session.sessionId,
    });
    assert.equal(dispatch.status, 202, dispatch.text);

    const deadline = Date.now() + 2_000;
    while (!env.workspace.isConversationBusy(session.sessionId)) {
      assert.ok(Date.now() < deadline, 'dispatch never took the conversation');
      await delay(5);
    }

    // Delivery is accepted (202) even though the busy execution will be
    // refused in the background; the control plane owns no execution state.
    const wake = await bTrigger(running.info.url, running.token, 'wake-vs-dispatch', 'only', 'go');
    assert.equal(wake.status, 202, wake.text);
    await waitForRest(running.info.url, running.token, 'wake-vs-dispatch');
    assert.equal(adapter.prompts.includes('wake go'), false);

    // Release the dispatch; the session is free again and a retrigger runs.
    const executionId = adapter.executionIds[0];
    assert.ok(executionId !== undefined, 'dispatch never reached the adapter');
    adapter.release(executionId);

    const retried = await bTrigger(running.info.url, running.token, 'wake-vs-dispatch', 'only', 'go2');
    assert.equal(retried.status, 202, retried.text);
    await waitForPrompt(adapter, 'wake go2');
    const retryExecutionId = adapter.executionIds.at(-1);
    assert.ok(retryExecutionId !== undefined);
    adapter.release(retryExecutionId);
    await waitForRest(running.info.url, running.token, 'wake-vs-dispatch');
  },
);
