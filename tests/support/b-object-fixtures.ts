import type { HiveTemplate, LiveHive } from '../../src/b/types.js';

export function simpleLiveHive(): LiveHive {
  return {
    schemaVersion: 1,
    liveId: 'demo',
    bees: {
      draft: {
        kind: 'forager',
        config: { connection: 'codex', prompt: 'draft {{input}}' },
        outgoing: ['l1'],
        roleLabel: 'planner',
        sessionMode: 'fresh_once',
      },
      review: {
        kind: 'forager',
        config: { connection: 'codex', prompt: 'review' },
        outgoing: ['l2'],
      },
      done: {
        kind: 'forager',
        config: { connection: 'codex', prompt: 'done' },
        outgoing: [],
      },
    },
    beelines: {
      l1: { fromBee: 'draft', toBee: 'review' },
      l2: { fromBee: 'review', toBee: 'done', branch: 'continue' },
    },
    bindings: {
      draft: 's1',
      review: 's2',
    },
  };
}

export function forkLiveHive(): LiveHive {
  return {
    schemaVersion: 1,
    liveId: 'fork-demo',
    bees: {
      start: {
        kind: 'forager',
        config: { connection: 'codex', prompt: 'start {{input}}' },
        outgoing: ['to-fork'],
      },
      fork: {
        kind: 'fork',
        config: {
          branches: [
            { id: 'a', to: 'left' },
            { id: 'b', to: 'right' },
          ],
        },
        outgoing: ['fa', 'fb'],
      },
      left: {
        kind: 'forager',
        config: { connection: 'codex', prompt: 'left' },
        outgoing: ['lm'],
      },
      right: {
        kind: 'forager',
        config: { connection: 'codex', prompt: 'right' },
        outgoing: ['rm'],
      },
      merge: {
        kind: 'merge',
        config: { required: ['a', 'b'], combine: 'text' },
        outgoing: [],
      },
    },
    beelines: {
      'to-fork': { fromBee: 'start', toBee: 'fork' },
      fa: { fromBee: 'fork', toBee: 'left', branch: 'a' },
      fb: { fromBee: 'fork', toBee: 'right', branch: 'b' },
      lm: { fromBee: 'left', toBee: 'merge' },
      rm: { fromBee: 'right', toBee: 'merge' },
    },
    bindings: { left: 'sl', right: 'sr' },
  };
}

export function conditionLiveHive(): LiveHive {
  return {
    schemaVersion: 1,
    liveId: 'condition-demo',
    bees: {
      start: {
        kind: 'forager',
        config: { connection: 'codex', prompt: 'start' },
        outgoing: ['to-condition'],
      },
      condition: {
        kind: 'condition',
        config: { mode: 'boolean' },
        outgoing: ['yes', 'no'],
      },
      done: {
        kind: 'forager',
        config: { connection: 'codex', prompt: 'done' },
        outgoing: [],
      },
    },
    beelines: {
      'to-condition': { fromBee: 'start', toBee: 'condition' },
      yes: { fromBee: 'condition', toBee: 'done', branch: 'true' },
      no: { fromBee: 'condition', toBee: 'done', branch: 'false' },
    },
    bindings: { start: 's1' },
  };
}

export function simpleTemplate(): HiveTemplate {
  const live = simpleLiveHive();
  return {
    schemaVersion: 1,
    templateId: 'starter',
    hive: { bees: live.bees, beelines: live.beelines },
    defaults: {
      draft: { harness: 'codex', model: 'gpt-5', reasoning: 'high' },
      review: { harness: 'dsh' },
    },
  };
}
