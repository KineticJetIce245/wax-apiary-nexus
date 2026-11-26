import assert from 'node:assert/strict';
import test from 'node:test';

import {
  fromCompositionDefinition,
  LiveHiveCodecError,
  toCompositionDefinition,
  toGraphBindings,
} from '../src/b/live-hive-codec.js';
import type { LiveHive } from '../src/b/types.js';
import {
  conditionLiveHive,
  spreadLiveHive,
  simpleLiveHive,
} from './support/b-object-fixtures.js';

test('LiveHive -> CompositionDefinition preserves ids, kinds, edges and graphRevision', () => {
  const live = simpleLiveHive();
  const composition = toCompositionDefinition(live);

  assert.equal(composition.id, 'demo');
  assert.match(composition.graphRevision, /^[0-9a-f]{12}$/);
  assert.deepEqual([...composition.nodes.keys()], ['draft', 'review', 'done']);
  assert.equal(composition.nodes.get('draft')?.kind, 'forager');
  assert.deepEqual(
    composition.edges.map((edge) => [edge.id, edge.from, edge.to]),
    [
      ['l1', 'draft', 'review'],
      ['l2', 'review', 'done'],
    ],
  );
  assert.deepEqual(composition.triggers, []);
  assert.equal(composition.nodes.get('draft')?.minIntervalMs, 1_000);
  assert.equal(composition.defaults.minIntervalMs, 1_000);
});

test('LiveHive -> CompositionDefinition is deterministic and tracks config changes', () => {
  const first = toCompositionDefinition(simpleLiveHive());
  const second = toCompositionDefinition(simpleLiveHive());
  assert.equal(first.graphRevision, second.graphRevision);

  const changed = simpleLiveHive();
  const draft = changed.bees['draft']!;
  const modified: LiveHive = {
    ...changed,
    bees: {
      ...changed.bees,
      draft: { ...draft, config: { ...draft.config, prompt: 'different' } },
    },
  };
  assert.notEqual(
    toCompositionDefinition(modified).graphRevision,
    first.graphRevision,
  );
});

test('spread beelines become config branches, never normal edges', () => {
  const composition = toCompositionDefinition(spreadLiveHive());
  assert.deepEqual(
    composition.edges.map((edge) => edge.id).sort(),
    ['lm', 'rm', 'to-spread'],
  );
  const spread = composition.nodes.get('spread');
  assert.ok(spread !== undefined && spread.kind === 'spread');
  assert.deepEqual(spread.config.branches, [
    { id: 'a', to: 'left' },
    { id: 'b', to: 'right' },
  ]);
});

test('spread branches are derived from beeline branch labels when config omits them', () => {
  const live = spreadLiveHive();
  const spread = live.bees['spread']!;
  const withoutConfig: LiveHive = {
    ...live,
    bees: { ...live.bees, spread: { ...spread, config: {} } },
  };
  const composition = toCompositionDefinition(withoutConfig);
  const node = composition.nodes.get('spread');
  assert.ok(node !== undefined && node.kind === 'spread');
  assert.deepEqual(node.config.branches, [
    { id: 'a', to: 'left' },
    { id: 'b', to: 'right' },
  ]);
});

test('condition beelines keep true/false as edge when labels', () => {
  const composition = toCompositionDefinition(conditionLiveHive());
  const conditionEdges = composition.edges.filter((edge) => edge.from === 'condition');
  assert.deepEqual(
    conditionEdges.map((edge) => [edge.id, edge.when, edge.to]),
    [
      ['yes', 'true', 'done'],
      ['no', 'false', 'done'],
    ],
  );
});

test('a condition beeline without a true/false branch is a codec error', () => {
  const live = conditionLiveHive();
  const broken: LiveHive = {
    ...live,
    beelines: {
      ...live.beelines,
      yes: { ...live.beelines['yes']!, branch: 'maybe' },
    },
  };
  assert.throws(() => toCompositionDefinition(broken), LiveHiveCodecError);
});

test('a spread without branches is a codec error', () => {
  const live = spreadLiveHive();
  const spread = live.bees['spread']!;
  const noBranches: LiveHive = {
    ...live,
    bees: {
      ...live.bees,
      spread: { ...spread, config: {}, outgoing: [] },
    },
    beelines: Object.fromEntries(
      Object.entries(live.beelines).filter(([, line]) => line.fromBee !== 'spread'),
    ),
  };
  assert.throws(() => toCompositionDefinition(noBranches), /needs at least one branch/);
});

test('toGraphBindings includes only forager bindings', () => {
  const live = simpleLiveHive();
  const withUser: LiveHive = {
    ...live,
    bees: {
      ...live.bees,
      done: { kind: 'user', config: { modality: 'text', prompt: 'done' }, outgoing: [] },
    },
    bindings: { ...live.bindings, done: 's3' },
  };
  assert.deepEqual(toGraphBindings(withUser), {
    draft: { kind: 'session', sessionId: 's1' },
    review: { kind: 'session', sessionId: 's2' },
  });
});

test('B schedules map to and from composition triggers', () => {
  const live: LiveHive = {
    ...simpleLiveHive(),
    schedules: [
      { scheduleId: 'once', targetBee: 'draft', at: '2026-01-01T00:00:00Z' },
      { scheduleId: 'tick', targetBee: 'review', everyMs: 1_000 },
    ],
  };
  const composition = toCompositionDefinition(live);
  assert.deepEqual(composition.triggers, [
    {
      id: 'once',
      target: 'draft',
      schedule: { kind: 'at', at: '2026-01-01T00:00:00Z' },
    },
    {
      id: 'tick',
      target: 'review',
      schedule: { kind: 'every', everyMs: 1_000 },
    },
  ]);

  const imported = fromCompositionDefinition(composition);
  assert.deepEqual(imported.schedules, live.schedules);
});

test('codec does not mutate the LiveHive object', () => {
  const live = spreadLiveHive();
  const before = JSON.stringify(live);
  toCompositionDefinition(live);
  toGraphBindings(live);
  assert.equal(JSON.stringify(live), before);
});
