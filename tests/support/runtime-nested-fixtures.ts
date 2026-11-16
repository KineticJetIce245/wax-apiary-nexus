import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseComposition,
  PheromoneRuntime,
  type BranchTag,
  type CompositionDefinition,
  type NodeExecutor,
  type Value,
} from '../../src/runtime/index.js';

export const START = Date.parse('2026-07-01T00:00:00.000Z');

export function text(value: string): Value {
  return { kind: 'text', text: value };
}

interface Recorder {
  readonly executor: NodeExecutor;
  readonly calls: { nodeId: string; input: Value }[];
}

export function recorder(output?: (nodeId: string, input: Value) => Value): Recorder {
  const calls: { nodeId: string; input: Value }[] = [];
  const executor: NodeExecutor = {
    async execute(node, input) {
      calls.push({ nodeId: node.id, input });
      return output === undefined ? input : output(node.id, input);
    },
  };
  return { executor, calls };
}

export function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'wax-nested-honey-'));
}

/**
 * Pumps until the field reaches Rest, advancing the injected clock after every
 * pump so each node's minimum interval can elapse. Only for graphs that have no
 * user hover and no intentionally waiting merge.
 */
export async function runToRest(
  runtime: PheromoneRuntime,
  advance: () => void,
  maxPumps = 50,
): Promise<void> {
  for (let index = 0; index < maxPumps; index += 1) {
    await runtime.pump();
    if (runtime.snapshot().rest) {
      return;
    }
    advance();
  }
  assert.fail('the field did not reach Rest');
}

export function tagIds(tags: readonly BranchTag[] | undefined): string[] {
  return (tags ?? []).map((tag) => `${tag.forkId}/${tag.branchId}`);
}

export function joinAt(
  snapshot: ReturnType<PheromoneRuntime['snapshot']>,
  nodeId: string,
  key?: string,
) {
  const joins = snapshot.nodes[nodeId]?.joins ?? {};
  const value = key === undefined ? Object.values(joins)[0] : joins[key];
  assert.ok(value !== undefined, `expected a join on '${nodeId}'`);
  return value;
}

/** start -> fork (a,b -> merge) -> done. The Stage 3A single-level shape. */
export function singleLevelComposition(): CompositionDefinition {
  return parseComposition({
    schemaVersion: 1,
    id: 'nested-single-level',
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'start {{input}}' } },
      fork: {
        kind: 'fork',
        config: {
          branches: [
            { id: 'a', to: 'merge' },
            { id: 'b', to: 'merge' },
          ],
        },
      },
      merge: { kind: 'merge', config: { required: ['a', 'b'], combine: 'text' } },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'fork' },
      { id: 'e2', from: 'merge', to: 'done' },
    ],
  });
}

/**
 * start -> outer-fork
 *   left  -> inner-fork (i-a, i-b -> inner-merge) -> outer-merge
 *   right -> outer-merge
 * outer-merge -> done
 */
export function twoLevelComposition(): CompositionDefinition {
  return parseComposition({
    schemaVersion: 1,
    id: 'nested-two-level',
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'start {{input}}' } },
      'outer-fork': {
        kind: 'fork',
        config: {
          branches: [
            { id: 'left', to: 'inner-fork' },
            { id: 'right', to: 'outer-merge' },
          ],
        },
      },
      'inner-fork': {
        kind: 'fork',
        config: {
          branches: [
            { id: 'i-a', to: 'inner-merge' },
            { id: 'i-b', to: 'inner-merge' },
          ],
        },
      },
      'inner-merge': { kind: 'merge', config: { required: ['i-a', 'i-b'], combine: 'text' } },
      'outer-merge': { kind: 'merge', config: { required: ['left', 'right'], combine: 'text' } },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'outer-fork' },
      { id: 'e2', from: 'inner-merge', to: 'outer-merge' },
      { id: 'e3', from: 'outer-merge', to: 'done' },
    ],
  });
}

/** Two-level shape whose inner second branch is a user hover. */
export function twoLevelHoverComposition(): CompositionDefinition {
  return parseComposition({
    schemaVersion: 1,
    id: 'nested-two-level-hover',
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'start {{input}}' } },
      'outer-fork': {
        kind: 'fork',
        config: {
          branches: [
            { id: 'left', to: 'inner-fork' },
            { id: 'right', to: 'outer-merge' },
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
      'inner-merge': { kind: 'merge', config: { required: ['i-a', 'i-b'], combine: 'text' } },
      'outer-merge': { kind: 'merge', config: { required: ['left', 'right'], combine: 'text' } },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'outer-fork' },
      { id: 'e2', from: 'ask-inner', to: 'inner-merge' },
      { id: 'e3', from: 'inner-merge', to: 'outer-merge' },
      { id: 'e4', from: 'outer-merge', to: 'done' },
    ],
  });
}

/**
 * start -> outer-fork (o-left -> mid-fork, o-right -> outer-merge)
 * mid-fork (m-left -> inner-fork, m-right -> mid-merge)
 * inner-fork (i-a, i-b -> inner-merge) -> mid-merge -> outer-merge -> done
 */
export function threeLevelComposition(): CompositionDefinition {
  return parseComposition({
    schemaVersion: 1,
    id: 'nested-three-level',
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'start {{input}}' } },
      'outer-fork': {
        kind: 'fork',
        config: {
          branches: [
            { id: 'o-left', to: 'mid-fork' },
            { id: 'o-right', to: 'outer-merge' },
          ],
        },
      },
      'mid-fork': {
        kind: 'fork',
        config: {
          branches: [
            { id: 'm-left', to: 'inner-fork' },
            { id: 'm-right', to: 'mid-merge' },
          ],
        },
      },
      'inner-fork': {
        kind: 'fork',
        config: {
          branches: [
            { id: 'i-a', to: 'inner-merge' },
            { id: 'i-b', to: 'inner-merge' },
          ],
        },
      },
      'inner-merge': { kind: 'merge', config: { required: ['i-a', 'i-b'], combine: 'text' } },
      'mid-merge': { kind: 'merge', config: { required: ['m-left', 'm-right'], combine: 'text' } },
      'outer-merge': { kind: 'merge', config: { required: ['o-left', 'o-right'], combine: 'text' } },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'outer-fork' },
      { id: 'e2', from: 'inner-merge', to: 'mid-merge' },
      { id: 'e3', from: 'mid-merge', to: 'outer-merge' },
      { id: 'e4', from: 'outer-merge', to: 'done' },
    ],
  });
}

/**
 * The same three-level nesting as `threeLevelComposition`, but the outer right
 * branch is a user hover instead of a direct Merge arrival:
 *
 * start -> outer-fork
 *   o-left  -> mid-fork (m-left -> inner-fork, m-right -> mid-merge)
 *              inner-fork (i-a, i-b -> inner-merge) -> mid-merge -> outer-merge
 *   o-right -> ask-outer -> outer-merge
 * outer-merge -> done
 *
 * `queue-node` is deliberately detached: no edge reaches it, so it can hold an
 * independent queue/pending pair without touching the nested graph.
 */
export function threeLevelHoverComposition(): CompositionDefinition {
  return parseComposition({
    schemaVersion: 1,
    id: 'nested-three-level-hover',
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'start {{input}}' } },
      'outer-fork': {
        kind: 'fork',
        config: {
          branches: [
            { id: 'o-left', to: 'mid-fork' },
            { id: 'o-right', to: 'ask-outer' },
          ],
        },
      },
      'mid-fork': {
        kind: 'fork',
        config: {
          branches: [
            { id: 'm-left', to: 'inner-fork' },
            { id: 'm-right', to: 'mid-merge' },
          ],
        },
      },
      'inner-fork': {
        kind: 'fork',
        config: {
          branches: [
            { id: 'i-a', to: 'inner-merge' },
            { id: 'i-b', to: 'inner-merge' },
          ],
        },
      },
      'inner-merge': { kind: 'merge', config: { required: ['i-a', 'i-b'], combine: 'text' } },
      'mid-merge': { kind: 'merge', config: { required: ['m-left', 'm-right'], combine: 'text' } },
      'outer-merge': { kind: 'merge', config: { required: ['o-left', 'o-right'], combine: 'text' } },
      'ask-outer': { kind: 'user', config: { modality: 'text', prompt: 'outer?' } },
      'queue-node': {
        kind: 'forager',
        config: { connection: 'codex', prompt: 'detached {{input}}' },
        minIntervalMs: 5000,
      },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'outer-fork' },
      { id: 'e2', from: 'inner-merge', to: 'mid-merge' },
      { id: 'e3', from: 'mid-merge', to: 'outer-merge' },
      { id: 'e4', from: 'ask-outer', to: 'outer-merge' },
      { id: 'e5', from: 'outer-merge', to: 'done' },
    ],
  });
}
