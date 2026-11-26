import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CompositionValidationError,
  createMemoryLog,
  type CompositionDefinition,
} from '../src/runtime/index.js';
import {
  definitionOf,
  failureMessages,
  gatherDefinition,
  recorder,
  runtimeOf,
} from './support/m19-runtime.js';

const SIGNAL = { path: 'secrete', equals: true };
const TYPE_T = {
  match: { path: 'role', exists: true },
  reads: ['message'],
};

function setup(definition: CompositionDefinition) {
  const log = createMemoryLog();
  const rec = recorder();
  const runtime = runtimeOf(definition, rec.executor, { onLog: log.sink });
  return { runtime, rec, log };
}

function batchDefinition(id: string, config: Record<string, unknown>): CompositionDefinition {
  return gatherDefinition(id, { strategy: 'batch', batch: { signal: SIGNAL }, ...config });
}

const flush = { secrete: true };

function batchConfig(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    strategy: 'batch',
    batch: { signal: SIGNAL },
    types: { review: { match: { path: 'role', equals: 'review' }, reads: ['message'] } },
    ...extra,
  };
}

test('batch config parses without count/groupBy and defaults typeQueueMax', () => {
  const parsed = definitionOf('batch-config', {
    gather: { kind: 'gather', config: batchConfig() },
  });
  const node = parsed.nodes.get('gather');
  assert.ok(node !== undefined && node.kind === 'gather');
  assert.equal(node.config.strategy, 'batch');
  assert.equal(node.config.typeQueueMax, 256);
});

test('batch config rejects count and groupBy when present', () => {
  assert.throws(
    () =>
      definitionOf('batch-count', {
        gather: {
          kind: 'gather',
          config: batchConfig({
            types: {
              review: {
                match: { path: 'role', equals: 'review' },
                count: 1,
                reads: ['message'],
              },
            },
          }),
        },
      }),
    CompositionValidationError,
  );
  assert.throws(
    () =>
      definitionOf('batch-group', {
        gather: { kind: 'gather', config: batchConfig({ groupBy: 'topic' }) },
      }),
    CompositionValidationError,
  );
});

test('the signal is checked first and is consumed, never packaged', async () => {
  const definition = gatherDefinition('batch-signal-first', {
    strategy: 'batch',
    batch: { signal: SIGNAL },
    types: {
      all: { match: { path: 'secrete', equals: true }, reads: ['message'] },
    },
  });
  const { runtime } = setup(definition);

  await runtime.admit('gather', { secrete: true, message: 'consume-me' });
  await runtime.settle();
  assert.deepEqual(runtime.snapshot().nodes['gather']?.lastOutput, { all: [] });
  assert.equal(runtime.snapshot().rest, true);
});

test('inputs accumulate before the signal and the flush resets the queues', async () => {
  const { runtime, rec } = setup(
    gatherDefinition(
      'batch-reset',
      { strategy: 'batch', batch: { signal: SIGNAL }, types: { t: TYPE_T } },
      { sink: true },
    ),
  );

  await runtime.admit('gather', { role: 't', message: 'one' });
  await runtime.admit('gather', { role: 't', message: 'two' });
  await runtime.settle();
  assert.equal(rec.calls.length, 0);
  assert.equal(runtime.snapshot().rest, false);

  await runtime.admit('gather', flush);
  await runtime.settle();
  assert.deepEqual(rec.calls[0]?.input, { t: ['one', 'two'] });
  assert.equal(runtime.snapshot().rest, true);

  await runtime.admit('gather', { role: 't', message: 'three' });
  await runtime.settle();
  assert.equal(rec.calls.length, 1);
  assert.deepEqual(runtime.snapshot().nodes['gather']?.gather?.batch, { t: ['three'] });

  await runtime.admit('gather', flush);
  await runtime.settle();
  assert.deepEqual(rec.calls[1]?.input, { t: ['three'] });
  assert.equal(runtime.snapshot().rest, true);
});

test('an empty flush emits one package with every declared type empty', async () => {
  const definition = gatherDefinition('batch-empty', {
    strategy: 'batch',
    batch: { signal: SIGNAL },
    types: {
      a: { match: { path: 'role', equals: 'a' }, reads: ['message'] },
      b: { match: { path: 'role', equals: 'b' }, reads: ['message'] },
    },
  });
  const { runtime } = setup(definition);

  await runtime.admit('gather', flush);
  await runtime.settle();
  assert.deepEqual(runtime.snapshot().nodes['gather']?.lastOutput, { a: [], b: [] });
});

test('a partial flush emits empty arrays for types with no accumulated input', async () => {
  const definition = gatherDefinition('batch-partial', {
    strategy: 'batch',
    batch: { signal: SIGNAL },
    types: {
      a: { match: { path: 'role', equals: 'a' }, reads: ['message'] },
      b: { match: { path: 'role', equals: 'b' }, reads: ['message'] },
    },
  });
  const { runtime } = setup(definition);

  await runtime.admit('gather', { role: 'a', message: 'only-a' });
  await runtime.admit('gather', flush);
  await runtime.settle();
  assert.deepEqual(runtime.snapshot().nodes['gather']?.lastOutput, {
    a: ['only-a'],
    b: [],
  });
});

test('batch entries use scalar and multi-read object shapes', async () => {
  const definition = gatherDefinition('batch-entry-shapes', {
    strategy: 'batch',
    batch: { signal: SIGNAL },
    types: {
      scalar: { match: { path: 'role', equals: 'scalar' }, reads: ['message'] },
      nested: {
        match: { path: 'role', equals: 'nested' },
        reads: ['message', 'meta.score'],
      },
    },
  });
  const { runtime } = setup(definition);

  await runtime.admit('gather', { role: 'scalar', message: 'plain' });
  await runtime.admit('gather', { role: 'nested', message: 'rich', meta: { score: 3 } });
  await runtime.admit('gather', flush);
  await runtime.settle();
  assert.deepEqual(runtime.snapshot().nodes['gather']?.lastOutput, {
    scalar: ['plain'],
    nested: [{ message: 'rich', meta: { score: 3 } }],
  });
});

test('typeQueueMax drops an overflowing input and the signal still flushes', async () => {
  const definition = gatherDefinition('batch-queue-max', {
    strategy: 'batch',
    batch: { signal: SIGNAL },
    typeQueueMax: 1,
    types: { t: TYPE_T },
  });
  const { runtime, log } = setup(definition);

  await runtime.admit('gather', { role: 't', message: 'kept' });
  await runtime.admit('gather', { role: 't', message: 'dropped' });
  await runtime.settle();
  assert.match(failureMessages(log.entries, 'gather')[0] ?? '', /queue is full/);
  await runtime.admit('gather', flush);
  await runtime.settle();
  assert.deepEqual(runtime.snapshot().nodes['gather']?.lastOutput, { t: ['kept'] });
  assert.equal(runtime.snapshot().rest, true);
});

test('no-match, ambiguous and missing-read inputs are typed drops', async () => {
  const noMatch = setup(batchDefinition('batch-no-match', { types: { t: TYPE_T } }));
  await noMatch.runtime.admit('gather', { message: 'no role' });
  await noMatch.runtime.settle();

  const ambiguous = setup(
    batchDefinition('batch-ambiguous', {
      types: {
        a: { match: { path: 'role', exists: true }, reads: ['message'] },
        b: { match: { path: 'role', exists: true }, reads: ['message'] },
      },
    }),
  );
  await ambiguous.runtime.admit('gather', { role: 'x', message: 'x' });
  await ambiguous.runtime.settle();

  const missingRead = setup(batchDefinition('batch-missing-read', { types: { t: TYPE_T } }));
  await missingRead.runtime.admit('gather', { role: 't' });
  await missingRead.runtime.settle();

  assert.match(
    failureMessages(noMatch.log.entries, 'gather')[0] ?? '',
    /matches no declared type/,
  );
  assert.match(
    failureMessages(ambiguous.log.entries, 'gather')[0] ?? '',
    /ambiguous/,
  );
  assert.match(
    failureMessages(missingRead.log.entries, 'gather')[0] ?? '',
    /missing read path 'message'/,
  );
});

test('batch has no tombstone and Rest is driven by the accumulated input', async () => {
  const { runtime } = setup(batchDefinition('batch-rest', { types: { t: TYPE_T } }));

  await runtime.admit('gather', { role: 't', message: 'queued' });
  await runtime.settle();
  let gather = runtime.snapshot().nodes['gather']?.gather;
  assert.equal(runtime.snapshot().rest, false);
  assert.equal(gather?.groups.length, 0);
  assert.equal(gather?.tombstones.length, 0);

  await runtime.admit('gather', flush);
  await runtime.settle();
  gather = runtime.snapshot().nodes['gather']?.gather;
  assert.equal(runtime.snapshot().rest, true);
  assert.deepEqual(gather?.batch, { t: [] });
  assert.equal(gather?.tombstones.length, 0);
});
