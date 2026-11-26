import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseComposition,
  PheromoneRuntime,
  serializeValue,
  type NodeExecutor,
  type Value,
} from '../src/runtime/index.js';

const START = Date.parse('2026-03-01T00:00:00.000Z');

function text(value: string): Value {
  return { message: value };
}

function composition(id: string, nodeIds: readonly string[]): ReturnType<typeof parseComposition> {
  const nodes: Record<string, unknown> = {};
  for (const nodeId of nodeIds) {
    nodes[nodeId] = {
      kind: 'forager',
      config: { connection: 'codex', prompt: `run {{message}} on ${nodeId}` },
    };
  }
  return parseComposition({ schemaVersion: 1, id, nodes, edges: [] });
}

interface GatedExecutor {
  readonly executor: NodeExecutor;
  readonly started: string[];
  readonly isRunning: () => boolean;
  readonly release: (key: string) => void;
}

/**
 * A controllable executor: every activation records its input and stays
 * pending until the test releases it. Overlap is therefore proved by two
 * inputs being started before either may finish, not by timing.
 */
function gatedExecutor(): GatedExecutor {
  const started: string[] = [];
  const waiters = new Map<string, () => void>();
  const isRunning = (): boolean => waiters.size > 0;
  return {
    started,
    isRunning,
    executor: {
      execute(_node, input) {
        const key = serializeValue(input);
        started.push(key);
        return new Promise<Value>((resolve) => {
          waiters.set(key, () => {
            waiters.delete(key);
            resolve({ message: `done:${key}` });
          });
        });
      },
    },
    release(key: string): void {
      const release = waiters.get(key);
      assert.ok(release !== undefined, `input '${key}' was not started`);
      release();
    },
  };
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${label}`);
}

interface Internals {
  readonly engine: {
    readonly states: ReadonlyMap<
      string,
      { readonly receptor?: readonly import('../src/runtime/index.js').QueueEntry[] }
    >;
    readonly drains: ReadonlyMap<string, unknown>;
  };
}

function internalsOf(runtime: PheromoneRuntime): Internals['engine'] {
  return (runtime as unknown as Internals).engine;
}

function mailboxOf(
  runtime: PheromoneRuntime,
  nodeId: string,
): readonly import('../src/runtime/index.js').QueueEntry[] | undefined {
  return internalsOf(runtime).states.get(nodeId)?.receptor;
}

test('two different bees start and overlap before either activation finishes', async () => {
  const gated = gatedExecutor();
  const runtime = new PheromoneRuntime(composition('mailbox-overlap', ['a', 'b']), {
    executeForager: gated.executor,
    now: () => START,
  });

  runtime.admit('a', text('a1'));
  runtime.admit('b', text('b1'));

  const pumping = runtime.pump();
  await waitFor(() => gated.started.length === 2, 'both activations to start');

  // Both executors are entered and both are still held by the test: the two
  // bee activations overlap in real time.
  assert.deepEqual(gated.started, ['a1', 'b1']);
  assert.equal(gated.isRunning(), true);
  const running = runtime.snapshot();
  assert.ok(running.nodes['a']?.active !== undefined);
  assert.ok(running.nodes['b']?.active !== undefined);
  assert.equal(internalsOf(runtime).drains.size, 2);

  gated.release('a1');
  await waitFor(() => !internalsOf(runtime).drains.has('a'), 'bee a to finish');
  assert.ok(
    runtime.snapshot().nodes['b']?.active !== undefined,
    'bee b is still active while bee a has finished',
  );

  gated.release('b1');
  await pumping;

  assert.equal(runtime.snapshot().rest, true);
  assert.equal(internalsOf(runtime).drains.size, 0);
  assert.equal(mailboxOf(runtime, 'a'), undefined, 'the resting bee keeps no mailbox');
  assert.equal(mailboxOf(runtime, 'b'), undefined);
});

test('one bee stays FIFO with one active activation and no second drain', async () => {
  let clock = START;
  const gated = gatedExecutor();
  const runtime = new PheromoneRuntime(composition('mailbox-fifo', ['a']), {
    executeForager: gated.executor,
    now: () => clock,
  });

  runtime.admit('a', text('one'));
  const pumping = runtime.pump();
  await waitFor(() => gated.started.length === 1, 'the first activation');

  assert.deepEqual(gated.started, ['one']);
  assert.equal(internalsOf(runtime).drains.size, 1);
  assert.equal(mailboxOf(runtime, 'a')?.length, 0, 'the active input left the mailbox');

  // New input arrives while the first activation is active: it is appended to
  // the mailbox and does not start a second drain for the same bee.
  runtime.admit('a', text('two'));
  assert.deepEqual(
    mailboxOf(runtime, 'a')?.map((entry) => serializeValue(entry.value)),
    ['two'],
  );
  assert.equal(internalsOf(runtime).drains.size, 1);
  assert.equal(gated.started.length, 1);

  gated.release('one');
  clock += 1000;
  await waitFor(() => gated.started.length === 2, 'the second activation');
  assert.deepEqual(gated.started, ['one', 'two'], 'strict FIFO, never concurrent');
  assert.equal(internalsOf(runtime).drains.size, 1);

  gated.release('two');
  await pumping;

  assert.equal(runtime.snapshot().rest, true);
  assert.equal(internalsOf(runtime).drains.size, 0, 'no idle drain is left behind');
  assert.equal(mailboxOf(runtime, 'a'), undefined, 'the mailbox is removed at rest');
});

test('a wake either lands in the live mailbox or starts a fresh drain, never lost', async () => {
  let clock = START;
  const gated = gatedExecutor();
  const runtime = new PheromoneRuntime(composition('mailbox-race', ['a']), {
    executeForager: gated.executor,
    now: () => clock,
  });

  runtime.admit('a', text('first'));
  const pumping = runtime.pump();
  await waitFor(() => gated.started.length === 1, 'the first activation');

  // Release and enqueue before the drain's continuation runs: the drain sees
  // the new input in its mailbox and takes it without a lost wake.
  gated.release('first');
  runtime.admit('a', text('second'));
  clock += 1000;

  await waitFor(() => gated.started.length === 2, 'the appended wake to run');
  gated.release('second');
  await pumping;
  assert.deepEqual(gated.started, ['first', 'second']);
  assert.equal(runtime.snapshot().rest, true);
  assert.equal(mailboxOf(runtime, 'a'), undefined);
});

test('a wake that arrives after an empty mailbox rests starts a new drain', async () => {
  let clock = START;
  const gated = gatedExecutor();
  const runtime = new PheromoneRuntime(composition('mailbox-restart', ['a']), {
    executeForager: gated.executor,
    now: () => clock,
  });

  runtime.admit('a', text('first'));
  const pumping = runtime.pump();
  await waitFor(() => gated.started.length === 1, 'the first activation');

  gated.release('first');
  clock += 1000;
  // Run after the drain's continuation has checked the empty mailbox and
  // removed it: the trigger has to rebuild the mailbox rather than be dropped.
  await new Promise<void>((resolve) => {
    queueMicrotask(() => {
      runtime.admit('a', text('second'));
      resolve();
    });
  });

  await waitFor(() => gated.started.length === 2, 'the restarted drain');
  gated.release('second');
  await pumping;
  assert.deepEqual(gated.started, ['first', 'second']);
  assert.equal(runtime.snapshot().rest, true);
  assert.equal(internalsOf(runtime).drains.size, 0);
});
