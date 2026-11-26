import assert from 'node:assert/strict';
import test from 'node:test';

import {
  fromCompositionDefinition,
  toCompositionDefinition,
} from '../src/b/live-hive-codec.js';
import type { Bee, LiveHive } from '../src/b/types.js';
import {
  BObjectValidationError,
  parseLiveHive,
} from '../src/b/validation.js';
import { simpleLiveHive } from './support/b-object-fixtures.js';

function liveWithDraft(patch: Partial<Bee>): LiveHive {
  const live = simpleLiveHive();
  return {
    ...live,
    bees: {
      ...live.bees,
      draft: { ...live.bees['draft']!, ...patch },
    },
  };
}

function issuesOf(live: Record<string, unknown>): string[] {
  try {
    parseLiveHive(live);
  } catch (error) {
    assert.ok(error instanceof BObjectValidationError);
    return [...error.issues];
  }
  assert.fail('expected the live object to be rejected');
}

test('live.json accepts Bee reads/writes/fallback/filter and the codec carries them', () => {
  const live = liveWithDraft({
    reads: ['message', 'meta.topic'],
    writes: ['message'],
    fallback: { 'meta.topic': 'static-topic' },
    filter: { allow: ['message', 'meta.topic'], deny: ['meta.debug'] },
  });
  const parsed = parseLiveHive(live);
  assert.deepEqual(parsed.bees['draft']?.reads, ['message', 'meta.topic']);
  assert.deepEqual(parsed.bees['draft']?.writes, ['message']);
  assert.deepEqual(parsed.bees['draft']?.fallback, { 'meta.topic': 'static-topic' });
  assert.deepEqual(parsed.bees['draft']?.filter, {
    allow: ['message', 'meta.topic'],
    deny: ['meta.debug'],
  });

  const composition = toCompositionDefinition(parsed);
  const node = composition.nodes.get('draft');
  assert.ok(node !== undefined);
  assert.deepEqual(node.reads, ['message', 'meta.topic']);
  assert.deepEqual(node.writes, ['message']);
  assert.deepEqual(node.fallback, { 'meta.topic': 'static-topic' });
  assert.deepEqual(node.filter, { allow: ['message', 'meta.topic'], deny: ['meta.debug'] });
});

test('the codec fills the built-in I/O defaults when live.json omits them', () => {
  const live = simpleLiveHive();
  const workerLive: LiveHive = {
    ...live,
    bees: {
      ...live.bees,
      work: { kind: 'worker', config: { command: 'node' }, outgoing: [] },
    },
  };
  const composition = toCompositionDefinition(workerLive);
  const forager = composition.nodes.get('draft');
  const worker = composition.nodes.get('work');
  assert.ok(forager !== undefined && worker !== undefined);
  assert.deepEqual(forager.reads, ['message']);
  assert.deepEqual(forager.writes, ['message']);
  assert.deepEqual(worker.reads, []);
  assert.deepEqual(worker.writes, ['message']);
});

test('the graph revision changes when Bee I/O changes', () => {
  const base = toCompositionDefinition(simpleLiveHive());
  const changed = toCompositionDefinition(
    liveWithDraft({ reads: ['message'], fallback: { message: '' } }),
  );
  assert.notEqual(changed.graphRevision, base.graphRevision);
  assert.equal(
    toCompositionDefinition(simpleLiveHive()).graphRevision,
    base.graphRevision,
  );
});

test('fromCompositionDefinition imports non-default Bee I/O', () => {
  const live = liveWithDraft({
    reads: ['message', 'meta.topic'],
    writes: ['message'],
    fallback: { 'meta.topic': 'static-topic' },
    filter: { allow: [], deny: ['meta.debug'] },
  });
  const composition = toCompositionDefinition(live);
  const imported = fromCompositionDefinition(composition);
  assert.deepEqual(imported.bees['draft']?.reads, ['message', 'meta.topic']);
  assert.deepEqual(imported.bees['draft']?.writes, ['message']);
  assert.deepEqual(imported.bees['draft']?.fallback, { 'meta.topic': 'static-topic' });
  assert.deepEqual(imported.bees['draft']?.filter, { allow: [], deny: ['meta.debug'] });
  assert.deepEqual(imported.bees['review']?.reads, ['message']);
  assert.deepEqual(imported.bees['review']?.writes, ['message']);
});

test('live.json rejects malformed Bee I/O shapes and index write paths', () => {
  const base = simpleLiveHive() as unknown as Record<string, unknown>;
  const withBee = (patch: Record<string, unknown>) => ({
    ...base,
    bees: {
      ...(base['bees'] as Record<string, unknown>),
      draft: {
        ...(base['bees'] as Record<string, Record<string, unknown>>)['draft'],
        ...patch,
      },
    },
  });

  assert.ok(issuesOf(withBee({ reads: 'message' })).some((issue) => issue.includes('array of dot paths')));
  assert.ok(
    issuesOf(withBee({ writes: ['items.0'] })).some((issue) => issue.includes('array indices')),
  );
  assert.ok(
    issuesOf(withBee({ filter: { allow: ['items.0'] } })).some((issue) =>
      issue.includes('array indices'),
    ),
  );
  assert.ok(
    issuesOf(withBee({ fallback: { 'meta.topic': undefined } })).some((issue) =>
      issue.includes('undefined'),
    ),
  );
  assert.ok(
    issuesOf(withBee({ filter: { allow: [], deny: [], extra: true } })).some((issue) =>
      issue.includes("unknown field 'extra'"),
    ),
  );
  assert.ok(
    issuesOf(withBee({ reads: ['message'], unexpected: true })).some((issue) =>
      issue.includes("unknown field 'unexpected'"),
    ),
  );
  assert.doesNotThrow(
    () => parseLiveHive(withBee({ fallback: { 'items.0': 'x' } })),
    'a fallback may supply an indexed read path',
  );
});

test('a valid but non-default Bee is rejected only by the codec when config is malformed', () => {
  const live = liveWithDraft({ reads: ['message'], writes: ['message'] });
  const liveAsUnknown = { ...live } as unknown as Record<string, unknown>;
  const bees = liveAsUnknown['bees'] as Record<string, Record<string, unknown>>;
  bees['draft'] = {
    ...bees['draft'],
    config: { connection: 'codex', prompt: 'p', unknown: true },
  };
  assert.doesNotThrow(() => parseLiveHive(liveAsUnknown));
  assert.throws(() => toCompositionDefinition(liveAsUnknown as unknown as LiveHive), /unknown field/);
});
