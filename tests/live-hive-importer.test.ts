import assert from 'node:assert/strict';
import test from 'node:test';

import {
  fromCompositionDefinition,
  LiveHiveCodecError,
} from '../src/b/live-hive-codec.js';
import type { GraphBindings } from '../src/graph/binding.js';
import { parseComposition } from '../src/runtime/index.js';

function graphNodes(withCounter: boolean): Record<string, unknown> {
  return {
    start: {
      kind: 'forager',
      config: { connection: 'codex', prompt: 'start' },
    },
    spread: {
      kind: 'spread',
      config: { strategy: 'clone', targets: ['left', 'right'] },
    },
    left: { kind: 'forager', config: { connection: 'codex', prompt: 'left' } },
    right: { kind: 'forager', config: { connection: 'dsh', prompt: 'right' } },
    gather: {
      kind: 'gather',
      config: {
        strategy: 'assemble',
        types: {
          left: {
            match: { path: 'role', equals: 'left' },
            count: 1,
            reads: ['message'],
          },
          right: {
            match: { path: 'role', equals: 'right' },
            count: 1,
            reads: ['message'],
          },
        },
      },
    },
    done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    ...(withCounter
      ? { count: { kind: 'counter', config: { max: 1, step: 1 } } }
      : {}),
  };
}

function graphEdges(withCounter: boolean): Array<Record<string, unknown>> {
  return [
    { id: 'start-spread', from: 'start', to: 'spread' },
    { id: 'left-gather', from: 'left', to: 'gather' },
    { id: 'right-gather', from: 'right', to: 'gather' },
    { id: 'gather-done', from: 'gather', to: 'done' },
    ...(withCounter
      ? [
          { id: 'count-continue', from: 'count', to: 'done', when: 'continue' },
          { id: 'count-done', from: 'count', to: 'done', when: 'done' },
        ]
      : []),
  ];
}

function composition(withCounter = false): ReturnType<typeof parseComposition> {
  return parseComposition({
    schemaVersion: 1,
    id: 'm19-graph',
    nodes: graphNodes(withCounter),
    edges: graphEdges(withCounter),
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
    'spread',
    'left',
    'right',
    'gather',
    'done',
  ]);
  assert.deepEqual(live.bees['start']?.outgoing, ['start-spread']);
  assert.deepEqual(live.bees['spread']?.outgoing, []);
  assert.deepEqual(live.bees['left']?.outgoing, ['left-gather']);
  assert.deepEqual(live.bees['right']?.outgoing, ['right-gather']);
  assert.deepEqual(live.bees['gather']?.outgoing, ['gather-done']);
  assert.equal(live.beelines['start-spread']?.fromBee, 'start');
  assert.equal(live.beelines['start-spread']?.toBee, 'spread');
  assert.deepEqual(live.bindings, { start: 'session-one' });

  assert.equal(live.bees['left']?.sessionMode, 'fresh_once');
  assert.deepEqual(live.bees['left']?.config, {
    connection: 'codex',
    prompt: 'left',
  });
  assert.equal(live.bees['right']?.sessionMode, 'always_fresh');
  assert.equal(live.bees['right']?.config['connection'], 'dsh');
});

test('importer keeps spread targets in config and fabricates no beelines', () => {
  const live = fromCompositionDefinition(composition());
  assert.deepEqual(live.bees['spread']?.config, {
    strategy: 'clone',
    targets: ['left', 'right'],
  });
  assert.deepEqual(live.bees['gather']?.config, {
    strategy: 'assemble',
    types: {
      left: {
        match: { path: 'role', equals: 'left' },
        count: 1,
        reads: ['message'],
      },
      right: {
        match: { path: 'role', equals: 'right' },
        count: 1,
        reads: ['message'],
      },
    },
    typeQueueMax: 256,
  });
  assert.deepEqual(Object.keys(live.beelines).sort(), [
    'gather-done',
    'left-gather',
    'right-gather',
    'start-spread',
  ]);
  assert.equal(
    Object.values(live.beelines).some((line) => line.fromBee === 'spread'),
    false,
  );
  assert.equal(
    Object.values(live.beelines).some((line) => line.when !== undefined),
    false,
  );
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
