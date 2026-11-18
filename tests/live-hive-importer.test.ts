import assert from 'node:assert/strict';
import test from 'node:test';

import {
  fromCompositionDefinition,
  LiveHiveCodecError,
} from '../src/b/live-hive-codec.js';
import type { GraphBindings } from '../src/graph/binding.js';
import { parseComposition } from '../src/runtime/index.js';

function composition(withCounter = false): ReturnType<typeof parseComposition> {
  return parseComposition({
    schemaVersion: 1,
    id: 'legacy-graph',
    nodes: {
      start: {
        kind: 'forager',
        config: { connection: 'codex', prompt: 'start' },
      },
      fork: {
        kind: 'fork',
        config: {
          branches: [
            { id: 'a', to: 'left' },
            { id: 'b', to: 'right' },
          ],
        },
      },
      left: { kind: 'forager', config: { connection: 'codex', prompt: 'left' } },
      right: { kind: 'forager', config: { connection: 'dsh', prompt: 'right' } },
      merge: { kind: 'merge', config: { required: ['a', 'b'], combine: 'text' } },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
      ...(withCounter
        ? { count: { kind: 'counter', config: { max: 1, step: 1 } } }
        : {}),
    },
    edges: [
      { id: 'start-fork', from: 'start', to: 'fork' },
      { id: 'left-merge', from: 'left', to: 'merge' },
      { id: 'right-merge', from: 'right', to: 'merge' },
      { id: 'merge-done', from: 'merge', to: 'done' },
      ...(withCounter
        ? [
            { id: 'count-continue', from: 'count', to: 'done', when: 'continue' as const },
            { id: 'count-done', from: 'count', to: 'done', when: 'done' as const },
          ]
        : []),
    ],
    triggers: [
      { id: 't', target: 'start', schedule: { kind: 'at', at: '2026-01-01T00:00:00Z' } },
    ],
  });
}

test('fromCompositionDefinition preserves node/edge ids and session bindings', () => {
  const bindings: GraphBindings = {
    start: { kind: 'session', sessionId: 'session-one' },
    left: { kind: 'fresh', mode: 'once', harness: 'codex', model: 'm' },
    right: { kind: 'fresh', harness: 'dsh' },
  };
  const live = fromCompositionDefinition(composition(), bindings, 'imported');

  assert.equal(live.schemaVersion, 1);
  assert.equal(live.liveId, 'imported');
  assert.deepEqual(Object.keys(live.bees), [
    'start',
    'fork',
    'left',
    'right',
    'merge',
    'done',
  ]);
  assert.deepEqual(live.bees['start']?.outgoing, ['start-fork']);
  assert.equal(live.beelines['start-fork']?.fromBee, 'start');
  assert.equal(live.beelines['start-fork']?.toBee, 'fork');
  assert.deepEqual(live.bindings, { start: 'session-one' });

  assert.equal(live.bees['left']?.sessionMode, 'fresh_once');
  assert.deepEqual(live.bees['left']?.config, {
    connection: 'codex',
    prompt: 'left',
  });
  assert.equal(live.bees['right']?.sessionMode, 'always_fresh');
  assert.equal(live.bees['right']?.config['connection'], 'dsh');
});

test('fork branches become labelled beelines without fabricating edges', () => {
  const live = fromCompositionDefinition(composition());
  assert.deepEqual(live.bees['fork']?.outgoing, [
    'fork:fork:a',
    'fork:fork:b',
  ]);
  assert.deepEqual(live.beelines['fork:fork:a'], {
    fromBee: 'fork',
    toBee: 'left',
    branch: 'a',
  });
  assert.deepEqual(live.beelines['fork:fork:b'], {
    fromBee: 'fork',
    toBee: 'right',
    branch: 'b',
  });
  assert.equal(live.beelines['start-fork']?.branch, undefined);
  assert.equal(live.beelines['left-merge']?.toBee, 'merge');
  assert.equal(live.beelines['merge-done']?.toBee, 'done');
});

test('importer copies composition triggers into schedules', () => {
  const live = fromCompositionDefinition(composition());
  assert.equal(Object.hasOwn(live, 'triggers'), false);
  assert.deepEqual(live.schedules, [
    {
      scheduleId: 't',
      targetBee: 'start',
      at: '2026-01-01T00:00:00Z',
    },
  ]);
});

test('importer rejects unsupported counter nodes', () => {
  assert.throws(
    () => fromCompositionDefinition(composition(true)),
    LiveHiveCodecError,
  );
});
