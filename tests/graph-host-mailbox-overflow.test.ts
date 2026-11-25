import assert from 'node:assert/strict';
import test from 'node:test';

import { toHttpError } from '../src/control/http-errors.js';
import { LiveHiveHost } from '../src/daemon/graph-host.js';
import {
  MailboxBlockTimeoutError,
  parseComposition,
  QueueFullError,
  type CompositionDefinition,
} from '../src/runtime/index.js';
import {
  FakeClock,
  RecordingAdapter,
  allFresh,
  makeEnv,
} from './support/graph-host-fixtures.js';

function cappedGraph(id: string, queueMax: number): CompositionDefinition {
  const parsed = parseComposition({
    schemaVersion: 1,
    id,
    nodes: {
      only: { kind: 'forager', config: { connection: 'fake', prompt: 'run {{input}}' } },
    },
    edges: [],
    defaults: { queueMax },
  });
  const nodes = new Map(
    [...parsed.nodes].map(([nodeId, node]) => [nodeId, { ...node, minIntervalMs: 0 }]),
  );
  return { ...parsed, nodes };
}

function text(value: string) {
  return { kind: 'text' as const, text: value };
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(label)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

test('block policy waits outside the live lock and admits when the mailbox drains', async (t) => {
  const adapter = new RecordingAdapter();
  adapter.holdSubmissions = true;
  const env = makeEnv(adapter);
  const host = new LiveHiveHost({
    registry: env.registry,
    now: new FakeClock(1_000).now,
    mailboxOverflowPolicy: 'block',
    mailboxBlockTimeoutMs: 5_000,
  });
  t.after(async () => {
    adapter.releaseHeld();
    await host.dispose();
    await env.workspace.stop();
  });

  const definition = cappedGraph('mbx-host', 1);
  await host.loadGraph({
    definition,
    bindings: allFresh(definition),
    project: env.project,
  });

  const first = await host.trigger('mbx-host', 'only', text('one'));
  await adapter.waitForSubmit(1);
  const second = await host.trigger('mbx-host', 'only', text('two'));
  assert.equal(second.status, 'accepted', 'the queued admission is accepted');
  const third = host.trigger('mbx-host', 'only', text('three'));

  // A blocked admission must not hold the per-live lock: save still completes.
  const saved = await withTimeout(host.save('mbx-host'), 1_000, 'host.save was blocked');
  assert.equal(saved.graphId, 'mbx-host');

  adapter.releaseHeld();
  await adapter.waitForSubmit(2);
  const thirdAdmission = await withTimeout(third, 1_000, 'blocked wake did not resume');
  assert.equal(thirdAdmission.status, 'accepted');
  adapter.releaseHeld();
  await adapter.waitForSubmit(3);
  adapter.releaseHeld();

  const finished = await host.runs.wait(thirdAdmission.runId);
  assert.equal(finished.state, 'completed');
  assert.deepEqual(adapter.allPrompts, ['run one', 'run two', 'run three']);
  assert.equal(host.statusOf('mbx-host')?.rest, true);
  assert.ok(first.runId.length > 0);
});

test('block timeout is a structured error and maps to a stable HTTP error', async (t) => {
  const adapter = new RecordingAdapter();
  adapter.holdSubmissions = true;
  const env = makeEnv(adapter);
  const host = new LiveHiveHost({
    registry: env.registry,
    now: () => Date.now(),
    mailboxOverflowPolicy: 'block',
    mailboxBlockTimeoutMs: 25,
  });
  t.after(async () => { adapter.releaseHeld(); await host.dispose(); await env.workspace.stop(); });
  const definition = cappedGraph('mbx-timeout', 1);
  await host.loadGraph({
    definition,
    bindings: allFresh(definition),
    project: env.project,
  });

  const first = await host.trigger('mbx-timeout', 'only', text('one'));
  await adapter.waitForSubmit(1);
  const second = await host.trigger('mbx-timeout', 'only', text('two'));

  let failure: unknown;
  await assert.rejects(
    host.trigger('mbx-timeout', 'only', text('three')),
    (error: unknown) => {
      failure = error;
      assert.ok(error instanceof MailboxBlockTimeoutError);
      assert.equal(error.liveId, 'mbx-timeout');
      assert.equal(error.beeId, 'only');
      assert.equal(error.pending, 1);
      assert.equal(error.limit, 1);
      assert.equal(error.policy, 'block');
      assert.ok(error.waitedMs >= 0);
      return true;
    },
  );

  const http = toHttpError(failure);
  assert.equal(http.status, 429);
  assert.equal(http.code, 'bee-mailbox-block-timeout');
  assertTimeoutHttpBody(failure as MailboxBlockTimeoutError);

  // The failed admission left the mailbox exactly as it was.
  const status = host.statusOf('mbx-timeout');
  assert.equal(status?.nodes.find((node) => node.nodeId === 'only')?.queue, 1);
  assert.ok(first.runId.length > 0);
  assert.ok(second.runId.length > 0);
});

test('a reject overflow maps to 429 bee-mailbox-full with bee and depth', () => {
  const error = new QueueFullError('only', 3, 3, { liveId: 'live-a' });
  const http = toHttpError(error);
  assert.equal(http.status, 429);
  assert.equal(http.code, 'bee-mailbox-full');
  assert.deepEqual(http.options.body, {
    liveId: 'live-a',
    beeId: 'only',
    pending: 3,
    limit: 3,
    policy: 'reject',
  });
});

function assertTimeoutHttpBody(error: MailboxBlockTimeoutError): void {
  assert.deepEqual(toHttpError(error).options.body, {
    liveId: 'mbx-timeout',
    beeId: 'only',
    pending: 1,
    limit: 1,
    policy: 'block',
    waitedMs: error.waitedMs,
  });
}
