import type { HiveTemplate, LiveHive } from '../../src/b/types.js';

export function simpleLiveHive(): LiveHive {
  return {
    schemaVersion: 1,
    liveId: 'demo',
    bees: {
      draft: {
        kind: 'forager',
        config: { connection: 'codex', prompt: 'draft {{message}}' },
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

export function spreadLiveHive(): LiveHive {
  return {
    schemaVersion: 1,
    liveId: 'spread-demo',
    bees: {
      start: {
        kind: 'forager',
        config: { connection: 'codex', prompt: 'start {{message}}' },
        outgoing: ['to-spread'],
      },
      spread: {
        kind: 'spread',
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
      gather: {
        kind: 'gather',
        config: { required: ['a', 'b'], combine: 'text' },
        outgoing: [],
      },
    },
    beelines: {
      'to-spread': { fromBee: 'start', toBee: 'spread' },
      fa: { fromBee: 'spread', toBee: 'left', branch: 'a' },
      fb: { fromBee: 'spread', toBee: 'right', branch: 'b' },
      lm: { fromBee: 'left', toBee: 'gather' },
      rm: { fromBee: 'right', toBee: 'gather' },
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
        config: { when: { path: 'boolean', equals: true } },
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
