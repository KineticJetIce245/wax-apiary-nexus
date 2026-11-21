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
  bWake,
  postJson,
  withTimeout,
} from './support/control-server-http.js';
import { FakeAdapter } from './support/fake-adapter.js';

/**
 * Holds every submitted execution in `running` until the caller cancels it.
 * The scripted FakeAdapter always emits a terminal event on the next tick, so
 * a dispatch that must time out (or stay busy while a wake collides) needs an
 * adapter that never settles on its own.
 */
class HoldingAdapter extends FakeAdapter {
  readonly executionIds: string[] = [];

  override async submit(_nativeId: string, executionId: string, text: string): Promise<void> {
    this.prompts.push(text);
    this.executionIds.push(executionId);
  }

  override async cancel(_nativeId: string): Promise<void> {
    // An explicit cancel settles the held execution; without this the
    // execution would stay `running` until it timed out.
    const executionId = this.executionIds.at(-1);
    if (executionId !== undefined) {
      this.emit({ type: 'execution/cancelled', executionId });
    }
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

test('dispatch that exceeds its timeout maps to 409 dispatch-timeout', async (t) => {
  const env = makeEnvWithAdapter(new HoldingAdapter());
  const running = await startEnv(t, env);

  const response = await postJson(running.info.url, running.token, '/dispatch', {
    input: 'slow',
    sessionParams: { harness: 'codex' },
    timeoutMs: 40,
  });

  assert.equal(response.status, 409, response.text);
  assert.equal(response.body?.['code'], 'dispatch-timeout');
  assert.equal(response.body?.['error'], 'dispatch timed out');
});

const TERMINAL_CASES = [
  {
    label: 'cancelled',
    options: { terminal: 'cancelled' },
    status: 409,
    code: 'execution-cancelled',
  },
  {
    label: 'failed',
    options: { terminal: 'failed', error: 'native failure' },
    status: 500,
    code: 'internal',
  },
  {
    label: 'unknown',
    options: { terminal: 'unknown', error: 'no outcome' },
    status: 500,
    code: 'internal',
  },
] as const;

for (const { label, options, status, code } of TERMINAL_CASES) {
  test(`dispatch execution state '${label}' maps to ${String(status)} ${code}`, async (t) => {
    const env = makeEnv(options);
    const running = await startEnv(t, env);

    const response = await postJson(running.info.url, running.token, '/dispatch', {
      input: 'x',
      sessionParams: { harness: 'codex' },
    });

    assert.equal(response.status, status, response.text);
    assert.equal(response.body?.['code'], code);
    if (status >= 500) {
      // The terminal detail is native text and never reaches the caller.
      assert.equal(response.body?.['error'], 'internal error');
      assert.equal(response.text.includes('native failure'), false);
      assert.equal(response.text.includes('no outcome'), false);
    }
  });
}

function foragerDefinition(id: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id,
    nodes: {
      only: {
        kind: 'forager',
        config: { connection: 'codex', prompt: 'wake {{input}}' },
      },
    },
    edges: [],
  };
}

test(
  'a wake that collides with a running dispatch maps to 409 session-busy',
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

    // Start the dispatch and never await it until the wake has been asserted;
    // the immediate catch keeps a cleanup abort from becoming an unhandled
    // rejection while the original promise stays awaitable below.
    const dispatch = postJson(running.info.url, running.token, '/dispatch', {
      input: 'holds the conversation',
      sessionId: session.sessionId,
      timeoutMs: 2_000,
    });
    void dispatch.catch(() => undefined);

    const deadline = Date.now() + 2_000;
    while (!env.workspace.isConversationBusy(session.sessionId)) {
      assert.ok(Date.now() < deadline, 'dispatch never took the conversation');
      await delay(5);
    }

    const wake = await bWake(running.info.url, running.token, 'wake-vs-dispatch', 'only', 'go');
    assert.equal(wake.status, 409, wake.text);
    assert.equal(wake.body?.['code'], 'session-busy');
    assert.equal(wake.body?.['error'], 'session is busy');

    // Release the dispatch instead of waiting for its timeout: an explicit
    // cancel is a client-visible outcome and must stay 409, not 500.
    const executionId = adapter.executionIds[0];
    assert.ok(executionId !== undefined, 'dispatch never reached the adapter');
    await env.workspace.cancel(executionId);
    const settled = await withTimeout(dispatch, 2_000, 'dispatch');
    assert.equal(settled.status, 409, settled.text);
    assert.equal(settled.body?.['code'], 'execution-cancelled');
  },
);
