import {
  parseComposition,
  type CompositionDefinition,
} from '../../src/runtime/index.js';

/**
 * Two outer branches, each running its own inner Spread/Gather pair with distinct
 * forager outputs, then both joining at the outer Gather.
 */
export function siblingInnerSpreadsComposition(): CompositionDefinition {
  return parseComposition({
    schemaVersion: 1,
    id: 'nested-sibling-spreads',
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'start {{input}}' } },
      'outer-spread': {
        kind: 'spread',
        config: {
          branches: [
            { id: 'left', to: 'left-spread' },
            { id: 'right', to: 'right-spread' },
          ],
        },
      },
      'left-spread': {
        kind: 'spread',
        config: {
          branches: [
            { id: 'l-a', to: 'l-a-node' },
            { id: 'l-b', to: 'l-b-node' },
          ],
        },
      },
      'right-spread': {
        kind: 'spread',
        config: {
          branches: [
            { id: 'r-a', to: 'r-a-node' },
            { id: 'r-b', to: 'r-b-node' },
          ],
        },
      },
      'l-a-node': { kind: 'forager', config: { connection: 'codex', prompt: 'l-a' } },
      'l-b-node': { kind: 'forager', config: { connection: 'codex', prompt: 'l-b' } },
      'r-a-node': { kind: 'forager', config: { connection: 'codex', prompt: 'r-a' } },
      'r-b-node': { kind: 'forager', config: { connection: 'codex', prompt: 'r-b' } },
      'left-gather': { kind: 'gather', config: { required: ['l-a', 'l-b'], combine: 'text' } },
      'right-gather': { kind: 'gather', config: { required: ['r-a', 'r-b'], combine: 'text' } },
      'outer-gather': { kind: 'gather', config: { required: ['left', 'right'], combine: 'text' } },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'outer-spread' },
      { id: 'e2', from: 'l-a-node', to: 'left-gather' },
      { id: 'e3', from: 'l-b-node', to: 'left-gather' },
      { id: 'e4', from: 'r-a-node', to: 'right-gather' },
      { id: 'e5', from: 'r-b-node', to: 'right-gather' },
      { id: 'e6', from: 'left-gather', to: 'outer-gather' },
      { id: 'e7', from: 'right-gather', to: 'outer-gather' },
      { id: 'e8', from: 'outer-gather', to: 'done' },
    ],
  });
}

/**
 * start -> outer-spread (left -> inner-spread, right -> ask-outer)
 * inner-spread (i-a, i-b -> inner-gather, i-opt -> ask-inner)
 * inner-gather required [i-a,i-b], optional [i-opt] -> outer-gather
 */
export function nestedOptionalComposition(): CompositionDefinition {
  return parseComposition({
    schemaVersion: 1,
    id: 'nested-optional',
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'start {{input}}' } },
      'outer-spread': {
        kind: 'spread',
        config: {
          branches: [
            { id: 'left', to: 'inner-spread' },
            { id: 'right', to: 'ask-outer' },
          ],
        },
      },
      'inner-spread': {
        kind: 'spread',
        config: {
          branches: [
            { id: 'i-a', to: 'inner-gather' },
            { id: 'i-b', to: 'inner-gather' },
            { id: 'i-opt', to: 'ask-inner' },
          ],
        },
      },
      'ask-inner': { kind: 'user', config: { modality: 'text', prompt: 'inner optional?' } },
      'ask-outer': { kind: 'user', config: { modality: 'text', prompt: 'outer?' } },
      'inner-gather': {
        kind: 'gather',
        config: { required: ['i-a', 'i-b'], optional: ['i-opt'], combine: 'text' },
      },
      'outer-gather': { kind: 'gather', config: { required: ['left', 'right'], combine: 'text' } },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'outer-spread' },
      { id: 'e2', from: 'ask-inner', to: 'inner-gather' },
      { id: 'e3', from: 'inner-gather', to: 'outer-gather' },
      { id: 'e4', from: 'ask-outer', to: 'outer-gather' },
      { id: 'e5', from: 'outer-gather', to: 'done' },
    ],
  });
}

/**
 * start -> outer-spread (left -> inner-spread, right -> ask-outer)
 * inner-spread (i-a -> inner-gather, i-b -> ask-inner)
 * inner-gather required [i-a,i-b], optional [i-opt], timeoutMs 5000.
 */
export function nestedTimeoutComposition(): CompositionDefinition {
  return parseComposition({
    schemaVersion: 1,
    id: 'nested-timeout',
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'start {{input}}' } },
      'outer-spread': {
        kind: 'spread',
        config: {
          branches: [
            { id: 'left', to: 'inner-spread' },
            { id: 'right', to: 'ask-outer' },
          ],
        },
      },
      'inner-spread': {
        kind: 'spread',
        config: {
          branches: [
            { id: 'i-a', to: 'inner-gather' },
            { id: 'i-b', to: 'ask-inner' },
          ],
        },
      },
      'ask-inner': { kind: 'user', config: { modality: 'text', prompt: 'inner?' } },
      'ask-outer': { kind: 'user', config: { modality: 'text', prompt: 'outer?' } },
      'inner-gather': {
        kind: 'gather',
        config: {
          required: ['i-a', 'i-b'],
          optional: ['i-opt'],
          combine: 'text',
          timeoutMs: 5000,
        },
      },
      'outer-gather': { kind: 'gather', config: { required: ['left', 'right'], combine: 'text' } },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'outer-spread' },
      { id: 'e2', from: 'ask-inner', to: 'inner-gather' },
      { id: 'e3', from: 'inner-gather', to: 'outer-gather' },
      { id: 'e4', from: 'ask-outer', to: 'outer-gather' },
      { id: 'e5', from: 'outer-gather', to: 'done' },
    ],
  });
}

/** Same outer shape as nestedTimeout, but one inner branch throws. */
export function nestedFailureComposition(): CompositionDefinition {
  return parseComposition({
    schemaVersion: 1,
    id: 'nested-failure',
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'start {{input}}' } },
      'outer-spread': {
        kind: 'spread',
        config: {
          branches: [
            { id: 'left', to: 'inner-spread' },
            { id: 'right', to: 'ask-outer' },
          ],
        },
      },
      'inner-spread': {
        kind: 'spread',
        config: {
          branches: [
            { id: 'i-a', to: 'inner-gather' },
            { id: 'i-b', to: 'boom' },
          ],
        },
      },
      'ask-outer': { kind: 'user', config: { modality: 'text', prompt: 'outer?' } },
      'inner-gather': { kind: 'gather', config: { required: ['i-a', 'i-b'], combine: 'text' } },
      'outer-gather': { kind: 'gather', config: { required: ['left', 'right'], combine: 'text' } },
      boom: { kind: 'forager', config: { connection: 'codex', prompt: 'boom' } },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'outer-spread' },
      { id: 'e2', from: 'inner-gather', to: 'outer-gather' },
      { id: 'e3', from: 'ask-outer', to: 'outer-gather' },
      { id: 'e4', from: 'outer-gather', to: 'done' },
    ],
  });
}
