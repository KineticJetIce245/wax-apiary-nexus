import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import { FakeAdapter, type FakeTerminal } from './support/fake-adapter.js';
import {
  OUTPUT_SECRET,
  PROMPT_SECRET,
  assertNoSecrets,
  foragerDefinition,
  makeEnvWithAdapter,
  startServer,
} from './support/control-server-fixtures.js';
import { bLoad, bTrigger, getJson, waitForRest } from './support/control-server-http.js';

/**
 * A native terminal state is an execution detail of the field, not a
 * control-plane run: delivery answers 202 and the field settles with no cached
 * output. No native error text crosses the control boundary.
 */
const TERMINALS: readonly FakeTerminal[] = ['failed', 'unknown', 'cancelled'];

for (const terminal of TERMINALS) {
  test(`a ${terminal} execution is accepted and leaves no field output`, async (t) => {
    const liveId = `outcome-${terminal}`;
    const adapter = new FakeAdapter({
      terminal,
      output: OUTPUT_SECRET,
      error: `${terminal}-native-detail`,
    });
    const env = makeEnvWithAdapter(adapter);
    const running = await startServer(env);
    t.after(async () => {
      await running.server.stop();
      await env.workspace.stop();
    });

    const loaded = await bLoad(running.info.url, running.token, {
      definition: foragerDefinition(liveId, `run ${PROMPT_SECRET} {{message}}`),
      bindings: { only: { kind: 'fresh' } },
      project: env.project,
    });
    assert.equal(loaded.status, 200);

    const wake = await bTrigger(running.info.url, running.token, liveId, 'only', PROMPT_SECRET);
    assert.equal(wake.status, 202, wake.text);
    assert.equal(wake.body?.['ok'], true);
    assert.equal(Object.hasOwn(wake.body ?? {}, 'runId'), false);

    const finished = await waitForRest(running.info.url, running.token, liveId);
    assert.equal(finished.status, 200);
    assert.equal(finished.body?.['status']?.['rest'], true);
    assert.deepEqual(finished.body?.['outputs'], []);
    assertNoSecrets(finished.text, running.token);
    assert.equal(finished.text.includes(OUTPUT_SECRET), false);
    assert.equal(finished.text.includes('native-detail'), false);

    t.diagnostic(`observed: terminal=${terminal} rest=true outputs=0`);
  });
}

test('the workspace approval timer cancels the execution, not the delivery', async (t) => {
  const liveId = 'outcome-approval-timeout';
  const logs: string[] = [];
  const adapter = new FakeAdapter({
    askApproval: true,
    approvalCancelTerminal: 'cancelled',
    output: OUTPUT_SECRET,
  });
  const env = makeEnvWithAdapter(adapter, undefined, { approvalTimeoutMs: 50 });
  const running = await startServer(env, { logger: (line) => logs.push(line) });
  const requested = new Promise<string>((resolve) => {
    const off = env.workspace.onEvent((event) => {
      if (event.type === 'execution/approval-requested') {
        off();
        resolve(event.executionId);
      }
    });
  });
  t.after(async () => {
    await running.server.stop();
    await env.workspace.stop();
  });
  const loaded = await bLoad(running.info.url, running.token, {
    definition: foragerDefinition(liveId, `run ${PROMPT_SECRET} {{message}}`),
    bindings: { only: { kind: 'fresh' } },
    project: env.project,
  });
  assert.equal(loaded.status, 200);
  const wake = await bTrigger(running.info.url, running.token, liveId, 'only', PROMPT_SECRET);
  assert.equal(wake.status, 202, wake.text);
  const executionId = await requested;
  const inspection = await getJson(running.info.url, running.token, `/lives/${liveId}/inspect`);
  assert.equal(inspection.status, 200, inspection.text);
  assertNoSecrets(inspection.text, running.token);
  assert.equal(inspection.text.includes(OUTPUT_SECRET), false);

  assert.ok(executionId !== undefined, 'expected a native approval request');
  const deadline = Date.now() + 2_000;
  while (env.workspace.getExecution(executionId)?.state !== 'cancelled') {
    assert.ok(Date.now() < deadline, 'the approval timer never cancelled the execution');
    await delay(5);
  }
  const execution = env.workspace.getExecution(executionId);
  assert.ok(execution !== undefined);
  assert.equal(execution.state, 'cancelled');
  assert.equal(execution.cancelReason, 'approval-timeout');
  assert.equal(execution.error, undefined);

  const wakeLine = logs.find(
    (line) => line.includes('path=/lives/trigger') && line.includes('status=202'),
  );
  assert.ok(wakeLine !== undefined, `no 202 trigger log line: ${logs.join(' | ')}`);
  assert.equal(logs.some((line) => line.includes('status=500')), false);

  t.diagnostic('observed: rest=true cancelReason=approval-timeout');
});

test('an explicit workspace cancel settles the field without a run error', async (t) => {
  const liveId = 'outcome-explicit-cancel';
  const adapter = new FakeAdapter({
    askApproval: true,
    approvalCancelTerminal: 'cancelled',
    output: OUTPUT_SECRET,
  });
  const env = makeEnvWithAdapter(adapter, undefined, { approvalTimeoutMs: 60_000 });
  const running = await startServer(env);
  t.after(async () => {
    await running.server.stop();
    await env.workspace.stop();
  });

  const loaded = await bLoad(running.info.url, running.token, {
    definition: foragerDefinition(liveId, `run ${PROMPT_SECRET} {{message}}`),
    bindings: { only: { kind: 'fresh' } },
    project: env.project,
  });
  assert.equal(loaded.status, 200);

  const requested = new Promise<string>((resolve) => {
    const off = env.workspace.onEvent((event) => {
      if (event.type === 'execution/approval-requested') {
        off();
        resolve(event.executionId);
      }
    });
  });
  const wake = await bTrigger(running.info.url, running.token, liveId, 'only', PROMPT_SECRET);
  assert.equal(wake.status, 202, wake.text);
  const executionId = await requested;
  await env.workspace.cancel(executionId);
  const inspection = await getJson(running.info.url, running.token, `/lives/${liveId}/inspect`);
  assert.equal(inspection.status, 200, inspection.text);
  assertNoSecrets(inspection.text, running.token);

  const execution = env.workspace.getExecution(executionId);
  assert.ok(execution !== undefined);
  assert.equal(execution.state, 'cancelled');
  assert.equal(execution.cancelReason, 'explicit-cancel');

  t.diagnostic('observed: rest=true cancelReason=explicit-cancel');
});
