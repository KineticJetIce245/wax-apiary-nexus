import {
  parseComposition,
  type CompositionDefinition,
} from '../../src/runtime/index.js';

/**
 * Two outer branches, each running its own inner Fork/Merge pair with distinct
 * forager outputs, then both joining at the outer Merge.
 */
export function siblingInnerForksComposition(): CompositionDefinition {
  return parseComposition({
    schemaVersion: 1,
    id: 'nested-sibling-forks',
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'start {{input}}' } },
      'outer-fork': {
        kind: 'fork',
        config: {
          branches: [
            { id: 'left', to: 'left-fork' },
            { id: 'right', to: 'right-fork' },
          ],
        },
      },
      'left-fork': {
        kind: 'fork',
        config: {
          branches: [
            { id: 'l-a', to: 'l-a-node' },
            { id: 'l-b', to: 'l-b-node' },
          ],
        },
      },
      'right-fork': {
        kind: 'fork',
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
      'left-merge': { kind: 'merge', config: { required: ['l-a', 'l-b'], combine: 'text' } },
      'right-merge': { kind: 'merge', config: { required: ['r-a', 'r-b'], combine: 'text' } },
      'outer-merge': { kind: 'merge', config: { required: ['left', 'right'], combine: 'text' } },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'outer-fork' },
      { id: 'e2', from: 'l-a-node', to: 'left-merge' },
      { id: 'e3', from: 'l-b-node', to: 'left-merge' },
      { id: 'e4', from: 'r-a-node', to: 'right-merge' },
      { id: 'e5', from: 'r-b-node', to: 'right-merge' },
      { id: 'e6', from: 'left-merge', to: 'outer-merge' },
      { id: 'e7', from: 'right-merge', to: 'outer-merge' },
      { id: 'e8', from: 'outer-merge', to: 'done' },
    ],
  });
}

/**
 * start -> outer-fork (left -> inner-fork, right -> ask-outer)
 * inner-fork (i-a, i-b -> inner-merge, i-opt -> ask-inner)
 * inner-merge required [i-a,i-b], optional [i-opt] -> outer-merge
 */
export function nestedOptionalComposition(): CompositionDefinition {
  return parseComposition({
    schemaVersion: 1,
    id: 'nested-optional',
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'start {{input}}' } },
      'outer-fork': {
        kind: 'fork',
        config: {
          branches: [
            { id: 'left', to: 'inner-fork' },
            { id: 'right', to: 'ask-outer' },
          ],
        },
      },
      'inner-fork': {
        kind: 'fork',
        config: {
          branches: [
            { id: 'i-a', to: 'inner-merge' },
            { id: 'i-b', to: 'inner-merge' },
            { id: 'i-opt', to: 'ask-inner' },
          ],
        },
      },
      'ask-inner': { kind: 'user', config: { modality: 'text', prompt: 'inner optional?' } },
      'ask-outer': { kind: 'user', config: { modality: 'text', prompt: 'outer?' } },
      'inner-merge': {
        kind: 'merge',
        config: { required: ['i-a', 'i-b'], optional: ['i-opt'], combine: 'text' },
      },
      'outer-merge': { kind: 'merge', config: { required: ['left', 'right'], combine: 'text' } },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'outer-fork' },
      { id: 'e2', from: 'ask-inner', to: 'inner-merge' },
      { id: 'e3', from: 'inner-merge', to: 'outer-merge' },
      { id: 'e4', from: 'ask-outer', to: 'outer-merge' },
      { id: 'e5', from: 'outer-merge', to: 'done' },
    ],
  });
}

/**
 * start -> outer-fork (left -> inner-fork, right -> ask-outer)
 * inner-fork (i-a -> inner-merge, i-b -> ask-inner)
 * inner-merge required [i-a,i-b], optional [i-opt], timeoutMs 5000.
 */
export function nestedTimeoutComposition(): CompositionDefinition {
  return parseComposition({
    schemaVersion: 1,
    id: 'nested-timeout',
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'start {{input}}' } },
      'outer-fork': {
        kind: 'fork',
        config: {
          branches: [
            { id: 'left', to: 'inner-fork' },
            { id: 'right', to: 'ask-outer' },
          ],
        },
      },
      'inner-fork': {
        kind: 'fork',
        config: {
          branches: [
            { id: 'i-a', to: 'inner-merge' },
            { id: 'i-b', to: 'ask-inner' },
          ],
        },
      },
      'ask-inner': { kind: 'user', config: { modality: 'text', prompt: 'inner?' } },
      'ask-outer': { kind: 'user', config: { modality: 'text', prompt: 'outer?' } },
      'inner-merge': {
        kind: 'merge',
        config: {
          required: ['i-a', 'i-b'],
          optional: ['i-opt'],
          combine: 'text',
          timeoutMs: 5000,
        },
      },
      'outer-merge': { kind: 'merge', config: { required: ['left', 'right'], combine: 'text' } },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'outer-fork' },
      { id: 'e2', from: 'ask-inner', to: 'inner-merge' },
      { id: 'e3', from: 'inner-merge', to: 'outer-merge' },
      { id: 'e4', from: 'ask-outer', to: 'outer-merge' },
      { id: 'e5', from: 'outer-merge', to: 'done' },
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
      'outer-fork': {
        kind: 'fork',
        config: {
          branches: [
            { id: 'left', to: 'inner-fork' },
            { id: 'right', to: 'ask-outer' },
          ],
        },
      },
      'inner-fork': {
        kind: 'fork',
        config: {
          branches: [
            { id: 'i-a', to: 'inner-merge' },
            { id: 'i-b', to: 'boom' },
          ],
        },
      },
      'ask-outer': { kind: 'user', config: { modality: 'text', prompt: 'outer?' } },
      'inner-merge': { kind: 'merge', config: { required: ['i-a', 'i-b'], combine: 'text' } },
      'outer-merge': { kind: 'merge', config: { required: ['left', 'right'], combine: 'text' } },
      boom: { kind: 'forager', config: { connection: 'codex', prompt: 'boom' } },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'outer-fork' },
      { id: 'e2', from: 'inner-merge', to: 'outer-merge' },
      { id: 'e3', from: 'ask-outer', to: 'outer-merge' },
      { id: 'e4', from: 'outer-merge', to: 'done' },
    ],
  });
}
