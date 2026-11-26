import assert from 'node:assert/strict';
import test from 'node:test';

import { createMemoryLog, type CompositionDefinition, type RuntimeOptions } from '../src/runtime/index.js';
import {
  failureMessages,
  fastDefinition,
  gatherDefinition,
  recorder,
  runtimeOf,
} from './support/m19-runtime.js';

const START = Date.parse('2026-11-26T12:00:00.000Z');

const TYPE_A = {
  match: { path: 'role', equals: 'a' },
  count: 1,
  reads: ['message'],
};
const TYPE_B = {
  match: { path: 'role', equals: 'b' },
  count: 1,
  reads: ['message'],
};

function setup(definition: CompositionDefinition, options: Partial<RuntimeOptions> = {}) {
  const log = createMemoryLog();
  const rec = recorder();
  const runtime = runtimeOf(definition, rec.executor, { onLog: log.sink, ...options });
  return { runtime, rec, log };
}

test('one type with count 2 emits one package and writes lastOutput', async () => {
  const definition = gatherDefinition('gather-single', {
    types: {
      t: { match: { path: 'role', equals: 't' }, count: 2, reads: ['message'] },
    },
  });
  const { runtime, log } = setup(definition);

  await runtime.admit('gather', { role: 't', message: 'one' });
  await runtime.settle();
  assert.equal(runtime.snapshot().nodes['gather']?.lastOutput, undefined);
  assert.equal(runtime.snapshot().rest, false);

  await runtime.admit('gather', { role: 't', message: 'two' });
  await runtime.settle();
  assert.deepEqual(runtime.snapshot().nodes['gather']?.lastOutput, { t: ['one', 'two'] });
  assert.equal(runtime.snapshot().rest, true);
  assert.deepEqual(failureMessages(log.entries, 'gather'), []);
});

test('one read field yields scalars and several read fields yield nested objects', async () => {
  const definition = gatherDefinition('gather-entry-shape', {
    types: {
      plain: {
        match: { path: 'kind', equals: 'plain' },
        count: 1,
        reads: ['message'],
      },
      nested: {
        match: { path: 'kind', equals: 'nested' },
        count: 1,
        reads: ['message', 'meta.score'],
      },
    },
  });
  const { runtime } = setup(definition);

  await runtime.admit('gather', { kind: 'plain', message: 'hello' });
  await runtime.admit('gather', {
    kind: 'nested',
    message: 'world',
    meta: { score: 7 },
  });
  await runtime.settle();
  assert.deepEqual(runtime.snapshot().nodes['gather']?.lastOutput, {
    plain: ['hello'],
    nested: [{ message: 'world', meta: { score: 7 } }],
  });
});

test('FIFO groups complete one at a time and the next input starts a new group', async () => {
  const { runtime, rec, log } = setup(
    gatherDefinition('gather-fifo', { types: { a: TYPE_A, b: TYPE_B } }, { sink: true }),
  );

  await runtime.admit('gather', { role: 'a', message: 'a1' });
  await runtime.settle();
  assert.equal(rec.calls.length, 0);
  assert.equal(runtime.snapshot().rest, false);

  await runtime.admit('gather', { role: 'b', message: 'b1' });
  await runtime.settle();
  assert.deepEqual(rec.calls[0]?.input, { a: ['a1'], b: ['b1'] });
  assert.equal(runtime.snapshot().rest, true);

  await runtime.admit('gather', { role: 'a', message: 'a2' });
  await runtime.settle();
  assert.equal(rec.calls.length, 1);
  assert.equal(runtime.snapshot().rest, false);

  await runtime.admit('gather', { role: 'b', message: 'b2' });
  await runtime.settle();
  assert.deepEqual(rec.calls[1]?.input, { a: ['a2'], b: ['b2'] });
  assert.equal(runtime.snapshot().rest, true);
  assert.deepEqual(failureMessages(log.entries, 'gather'), []);
});

test('zero and multiple matcher hits are typed drops', async () => {
  const noMatch = setup(
    gatherDefinition('gather-no-match', { types: { a: TYPE_A } }),
  );
  await noMatch.runtime.admit('gather', { role: 'x', message: 'x' });
  await noMatch.runtime.settle();
  assert.match(failureMessages(noMatch.log.entries, 'gather')[0] ?? '', /matches no declared type/);
  assert.equal(noMatch.runtime.snapshot().nodes['gather']?.lastOutput, undefined);
  assert.equal(noMatch.runtime.snapshot().rest, true);

  const ambiguous = setup(
    gatherDefinition('gather-ambiguous', {
      types: {
        a: { match: { path: 'role', exists: true }, count: 1, reads: ['message'] },
        b: { match: { path: 'role', exists: true }, count: 1, reads: ['message'] },
      },
    }),
  );
  await ambiguous.runtime.admit('gather', { role: 'a', message: 'x' });
  await ambiguous.runtime.settle();
  assert.match(failureMessages(ambiguous.log.entries, 'gather')[0] ?? '', /ambiguous/);
  assert.equal(ambiguous.runtime.snapshot().nodes['gather']?.lastOutput, undefined);
});

test('a full type queue drops the overflowing input and keeps the package intact', async () => {
  const definition = gatherDefinition('gather-queue-max', {
    typeQueueMax: 2,
    types: {
      a: { match: { path: 'role', equals: 'a' }, count: 2, reads: ['message'] },
      b: TYPE_B,
    },
  });
  const { runtime, log } = setup(definition);

  await runtime.admit('gather', { role: 'a', message: 'a1' });
  await runtime.admit('gather', { role: 'a', message: 'a2' });
  await runtime.settle();
  await runtime.admit('gather', { role: 'a', message: 'a3' });
  await runtime.settle();
  assert.match(failureMessages(log.entries, 'gather')[0] ?? '', /queue is full/);

  await runtime.admit('gather', { role: 'b', message: 'b1' });
  await runtime.settle();
  assert.deepEqual(runtime.snapshot().nodes['gather']?.lastOutput, {
    a: ['a1', 'a2'],
    b: ['b1'],
  });
});

test('groupBy keeps keys separate and emits one package per key', async () => {
  const { runtime, rec, log } = setup(
    gatherDefinition(
      'gather-group-by',
      { groupBy: 'topic', types: { a: TYPE_A, b: TYPE_B } },
      { sink: true },
    ),
  );

  await runtime.admit('gather', { role: 'a', topic: 'k1', message: 'a-k1' });
  await runtime.admit('gather', { role: 'a', topic: 'k2', message: 'a-k2' });
  await runtime.settle();
  assert.equal(rec.calls.length, 0);
  assert.equal(runtime.snapshot().nodes['gather']?.gather?.groups.length, 2);
  assert.equal(runtime.snapshot().rest, false);

  await runtime.admit('gather', { role: 'b', topic: 'k1', message: 'b-k1' });
  await runtime.settle();
  assert.deepEqual(rec.calls[0]?.input, { a: ['a-k1'], b: ['b-k1'] });
  assert.equal(runtime.snapshot().nodes['gather']?.gather?.groups.length, 1);

  await runtime.admit('gather', { role: 'b', topic: 'k2', message: 'b-k2' });
  await runtime.settle();
  assert.deepEqual(rec.calls[1]?.input, { a: ['a-k2'], b: ['b-k2'] });
  const gather = runtime.snapshot().nodes['gather']?.gather;
  assert.equal(gather?.groups.length, 0);
  assert.equal(gather?.tombstones.length, 2);
  assert.equal(runtime.snapshot().rest, true);
  assert.deepEqual(failureMessages(log.entries, 'gather'), []);
});

test('a code-block group key returns the grouping string', async () => {
  const definition = gatherDefinition('gather-code-key', {
    groupBy: { code: 'return `${String(value.meta.tenant)}:${String(value.meta.topic)}`;' },
    types: {
      t: { match: { path: 'role', equals: 't' }, count: 2, reads: ['message'] },
    },
  });
  const { runtime } = setup(definition);

  await runtime.admit('gather', {
    role: 't',
    meta: { tenant: 'acme', topic: 'review' },
    message: 'one',
  });
  await runtime.admit('gather', {
    role: 't',
    meta: { tenant: 'acme', topic: 'review' },
    message: 'two',
  });
  await runtime.settle();
  assert.deepEqual(runtime.snapshot().nodes['gather']?.lastOutput, { t: ['one', 'two'] });
});

test('a missing or empty group key drops the input without touching the open group', async () => {
  const { runtime, log } = setup(
    gatherDefinition('gather-key-missing', {
      groupBy: 'topic',
      types: { a: TYPE_A, b: TYPE_B },
    }),
  );

  await runtime.admit('gather', { role: 'a', topic: 't', message: 'a' });
  await runtime.settle();
  await runtime.admit('gather', { role: 'b', message: 'no-key' });
  await runtime.settle();
  await runtime.admit('gather', { role: 'b', topic: '   ', message: 'blank-key' });
  await runtime.settle();

  const failures = failureMessages(log.entries, 'gather');
  assert.match(failures[0] ?? '', /group key 'topic' is missing/);
  assert.match(failures[1] ?? '', /must be a non-empty string/);
  const gather = runtime.snapshot().nodes['gather']?.gather;
  assert.equal(gather?.groups.length, 1);
  assert.deepEqual(gather?.groups[0]?.entries['a'], ['a']);
  assert.deepEqual(gather?.groups[0]?.entries['b'], []);

  await runtime.admit('gather', { role: 'b', topic: 't', message: 'b' });
  await runtime.settle();
  assert.deepEqual(runtime.snapshot().nodes['gather']?.lastOutput, { a: ['a'], b: ['b'] });
});

test('a missing read path drops the input and leaves the group incomplete', async () => {
  const { runtime, log } = setup(
    gatherDefinition('gather-missing-read', {
      types: { a: TYPE_A, b: TYPE_B },
    }),
  );

  await runtime.admit('gather', { role: 'a', message: 'a' });
  await runtime.settle();
  await runtime.admit('gather', { role: 'b' });
  await runtime.settle();
  assert.match(failureMessages(log.entries, 'gather')[0] ?? '', /missing read path 'message'/);
  assert.equal(runtime.snapshot().nodes['gather']?.lastOutput, undefined);
  assert.equal(runtime.snapshot().rest, false);

  await runtime.admit('gather', { role: 'b', message: 'b' });
  await runtime.settle();
  assert.deepEqual(runtime.snapshot().nodes['gather']?.lastOutput, { a: ['a'], b: ['b'] });
});

test('a tombstone rejects a late input for a closed keyed group', async () => {
  const { runtime, log } = setup(
    gatherDefinition('gather-tombstone', {
      groupBy: 'topic',
      types: { t: { match: { path: 'role', equals: 't' }, count: 1, reads: ['message'] } },
    }),
  );

  await runtime.admit('gather', { role: 't', topic: 'k', message: 'first' });
  await runtime.settle();
  assert.deepEqual(runtime.snapshot().nodes['gather']?.lastOutput, { t: ['first'] });

  await runtime.admit('gather', { role: 't', topic: 'k', message: 'late' });
  await runtime.settle();
  assert.match(failureMessages(log.entries, 'gather')[0] ?? '', /group 'k' is closed/);
  const gather = runtime.snapshot().nodes['gather']?.gather;
  assert.equal(gather?.groups.length, 0);
  assert.equal(gather?.tombstones.length, 1);
  assert.deepEqual(runtime.snapshot().nodes['gather']?.lastOutput, { t: ['first'] });
  // A tombstone is not a Rest blocker.
  assert.equal(runtime.snapshot().rest, true);
});

test('tombstone retention forgets an old key so it can open a new group', async () => {
  let now = START;
  const { runtime, log } = setup(
    gatherDefinition(
      'gather-tombstone-ttl',
      {
        groupBy: 'topic',
        types: { t: { match: { path: 'role', equals: 't' }, count: 1, reads: ['message'] } },
      },
    ),
    { now: () => now },
  );

  await runtime.admit('gather', { role: 't', topic: 'old', message: 'first' });
  await runtime.settle();
  now += 3_600_001;
  await runtime.admit('gather', { role: 't', topic: 'old', message: 'fresh' });
  await runtime.settle();

  assert.deepEqual(failureMessages(log.entries, 'gather'), []);
  assert.deepEqual(runtime.snapshot().nodes['gather']?.lastOutput, { t: ['fresh'] });
  assert.equal(runtime.snapshot().nodes['gather']?.gather?.tombstones.length, 1);
});

test('the tombstone record count is bounded to the default 64, keeping the newest', async () => {
  const { runtime, log } = setup(
    gatherDefinition('gather-tombstone-bound', {
      groupBy: 'topic',
      types: { t: { match: { path: 'role', equals: 't' }, count: 1, reads: ['message'] } },
    }),
  );

  for (let index = 0; index < 65; index += 1) {
    await runtime.admit('gather', {
      role: 't',
      topic: `k${String(index)}`,
      message: `m${String(index)}`,
    });
    await runtime.settle();
  }
  const tombstones = runtime.snapshot().nodes['gather']?.gather?.tombstones ?? [];
  assert.equal(tombstones.length, 64);
  assert.equal(tombstones[0]?.key, 'k1');
  assert.equal(tombstones[63]?.key, 'k64');

  // k1 is still closed and rejects its late input.
  await runtime.admit('gather', { role: 't', topic: 'k1', message: 'late' });
  await runtime.settle();
  assert.match(failureMessages(log.entries, 'gather')[0] ?? '', /group 'k1' is closed/);

  // k0 was forgotten, so it may open a new group again.
  await runtime.admit('gather', { role: 't', topic: 'k0', message: 'again' });
  await runtime.settle();
  assert.equal(failureMessages(log.entries, 'gather').length, 1);
});

test('an outgoing edge receives the package as one new Pheromone value', async () => {
  const { runtime, rec } = setup(
    gatherDefinition('gather-outgoing', { types: { a: TYPE_A, b: TYPE_B } }, { sink: true }),
  );

  await runtime.admit('gather', { role: 'a', message: 'a' });
  await runtime.admit('gather', { role: 'b', message: 'b' });
  await runtime.settle();

  assert.equal(rec.calls.length, 1);
  assert.deepEqual(rec.calls[0]?.input, { a: ['a'], b: ['b'] });
  assert.deepEqual(runtime.snapshot().nodes['sink']?.lastOutput, { a: ['a'], b: ['b'] });
});

test('gather ignores ordinary Bee writes and filter settings', async () => {
  const definition = fastDefinition('gather-ignores-io', {
    gather: {
      kind: 'gather',
      reads: ['never-present'],
      writes: ['never-produced'],
      filter: { allow: ['message'], deny: [] },
      config: {
        types: {
          t: { match: { path: 'role', equals: 't' }, count: 1, reads: ['value'] },
        },
      },
    },
  });
  const { runtime, log } = setup(definition);

  await runtime.admit('gather', { role: 't', value: 5 });
  await runtime.settle();
  assert.deepEqual(runtime.snapshot().nodes['gather']?.lastOutput, { t: [5] });
  assert.deepEqual(failureMessages(log.entries, 'gather'), []);
});

test('count is exact: a third FIFO entry starts a new group', async () => {
  const { runtime, rec } = setup(
    gatherDefinition(
      'gather-count-exact',
      {
        types: {
          a: { match: { path: 'role', equals: 'a' }, count: 2, reads: ['message'] },
          b: { match: { path: 'role', equals: 'b' }, count: 2, reads: ['message'] },
        },
      },
      { sink: true },
    ),
  );

  await runtime.admit('gather', { role: 'a', message: 'a1' });
  await runtime.admit('gather', { role: 'a', message: 'a2' });
  await runtime.admit('gather', { role: 'a', message: 'a3' });
  await runtime.settle();
  assert.equal(rec.calls.length, 0);
  const groups = runtime.snapshot().nodes['gather']?.gather?.groups ?? [];
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0]?.entries, { a: ['a1', 'a2'], b: [] });
  assert.deepEqual(groups[1]?.entries, { a: ['a3'], b: [] });

  await runtime.admit('gather', { role: 'a', message: 'a4' });
  await runtime.admit('gather', { role: 'b', message: 'b1' });
  await runtime.admit('gather', { role: 'b', message: 'b2' });
  await runtime.settle();
  assert.deepEqual(rec.calls[0]?.input, { a: ['a1', 'a2'], b: ['b1', 'b2'] });
  assert.equal(runtime.snapshot().rest, false);

  await runtime.admit('gather', { role: 'b', message: 'b3' });
  await runtime.admit('gather', { role: 'b', message: 'b4' });
  await runtime.settle();
  assert.deepEqual(rec.calls[1]?.input, { a: ['a3', 'a4'], b: ['b3', 'b4'] });
  assert.equal(runtime.snapshot().rest, true);
});

test('a keyed group rejects an entry beyond count before the group closes', async () => {
  const { runtime, log } = setup(
    gatherDefinition('gather-keyed-exact', {
      groupBy: 'topic',
      types: {
        a: { match: { path: 'role', equals: 'a' }, count: 2, reads: ['message'] },
        b: { match: { path: 'role', equals: 'b' }, count: 1, reads: ['message'] },
      },
    }),
  );

  await runtime.admit('gather', { role: 'a', topic: 'k1', message: 'a1' });
  await runtime.admit('gather', { role: 'a', topic: 'k1', message: 'a2' });
  await runtime.admit('gather', { role: 'a', topic: 'k2', message: 'other' });
  await runtime.settle();
  await runtime.admit('gather', { role: 'a', topic: 'k1', message: 'a3' });
  await runtime.settle();

  assert.match(
    failureMessages(log.entries, 'gather')[0] ?? '',
    /already holds 2 'a' entries/,
  );
  const groups = runtime.snapshot().nodes['gather']?.gather?.groups ?? [];
  assert.deepEqual(
    groups.map((group) => group.key),
    ['k1', 'k2'],
  );
  assert.deepEqual(groups[0]?.entries, { a: ['a1', 'a2'], b: [] });
  assert.deepEqual(groups[1]?.entries, { a: ['other'], b: [] });
  assert.equal(runtime.snapshot().rest, false);

  await runtime.admit('gather', { role: 'b', topic: 'k1', message: 'b1' });
  await runtime.settle();
  assert.deepEqual(runtime.snapshot().nodes['gather']?.lastOutput, {
    a: ['a1', 'a2'],
    b: ['b1'],
  });
  // The full-type drop touched no other group.
  assert.deepEqual(runtime.snapshot().nodes['gather']?.gather?.groups, [
    { key: 'k2', entries: { a: ['other'], b: [] } },
  ]);
});

test('typeQueueMax bounds one type across every open keyed group', async () => {
  const { runtime, log } = setup(
    gatherDefinition('gather-cross-group-max', {
      groupBy: 'topic',
      typeQueueMax: 2,
      types: {
        a: { match: { path: 'role', equals: 'a' }, count: 2, reads: ['message'] },
        b: { match: { path: 'role', equals: 'b' }, count: 1, reads: ['message'] },
      },
    }),
  );

  await runtime.admit('gather', { role: 'a', topic: 'k1', message: 'a1' });
  await runtime.admit('gather', { role: 'a', topic: 'k2', message: 'a2' });
  await runtime.settle();
  await runtime.admit('gather', { role: 'a', topic: 'k3', message: 'a3' });
  await runtime.settle();

  assert.match(failureMessages(log.entries, 'gather')[0] ?? '', /queue is full/);
  assert.deepEqual(
    (runtime.snapshot().nodes['gather']?.gather?.groups ?? []).map((group) => group.key),
    ['k1', 'k2'],
  );

  // The bound is per type: b still lands in an existing group.
  await runtime.admit('gather', { role: 'b', topic: 'k1', message: 'b1' });
  await runtime.settle();
  const groups = runtime.snapshot().nodes['gather']?.gather?.groups ?? [];
  assert.deepEqual(groups[0]?.entries, { a: ['a1'], b: ['b1'] });
  assert.equal(failureMessages(log.entries, 'gather').length, 1);
});
