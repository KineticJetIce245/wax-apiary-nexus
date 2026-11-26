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
 * user hover and no intentionally waiting gather.
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
  return (tags ?? []).map((tag) => `${tag.spreadId}/${tag.branchId}`);
}

export function joinAt(
  snapshot: ReturnType<PheromoneRuntime['snapshot']>,
  nodeId: string,
  key?: string,
) {
  const gathers = snapshot.nodes[nodeId]?.gathers ?? {};
  const value = key === undefined ? Object.values(gathers)[0] : gathers[key];
  assert.ok(value !== undefined, `expected a join on '${nodeId}'`);
  return value;
}

/** start -> spread (a,b -> gather) -> done. The Stage 3A single-level shape. */
export function singleLevelComposition(): CompositionDefinition {
  return parseComposition({
    schemaVersion: 1,
    id: 'nested-single-level',
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'start {{input}}' } },
      spread: {
        kind: 'spread',
        config: {
          branches: [
            { id: 'a', to: 'gather' },
            { id: 'b', to: 'gather' },
          ],
        },
      },
      gather: { kind: 'gather', config: { required: ['a', 'b'], combine: 'text' } },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'spread' },
      { id: 'e2', from: 'gather', to: 'done' },
    ],
  });
}

/**
 * start -> outer-spread
 *   left  -> inner-spread (i-a, i-b -> inner-gather) -> outer-gather
 *   right -> outer-gather
 * outer-gather -> done
 */
export function twoLevelComposition(): CompositionDefinition {
  return parseComposition({
    schemaVersion: 1,
    id: 'nested-two-level',
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'start {{input}}' } },
      'outer-spread': {
        kind: 'spread',
        config: {
          branches: [
            { id: 'left', to: 'inner-spread' },
            { id: 'right', to: 'outer-gather' },
          ],
        },
      },
      'inner-spread': {
        kind: 'spread',
        config: {
          branches: [
            { id: 'i-a', to: 'inner-gather' },
            { id: 'i-b', to: 'inner-gather' },
          ],
        },
      },
      'inner-gather': { kind: 'gather', config: { required: ['i-a', 'i-b'], combine: 'text' } },
      'outer-gather': { kind: 'gather', config: { required: ['left', 'right'], combine: 'text' } },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'outer-spread' },
      { id: 'e2', from: 'inner-gather', to: 'outer-gather' },
      { id: 'e3', from: 'outer-gather', to: 'done' },
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
      'outer-spread': {
        kind: 'spread',
        config: {
          branches: [
            { id: 'left', to: 'inner-spread' },
            { id: 'right', to: 'outer-gather' },
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
      'inner-gather': { kind: 'gather', config: { required: ['i-a', 'i-b'], combine: 'text' } },
      'outer-gather': { kind: 'gather', config: { required: ['left', 'right'], combine: 'text' } },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'outer-spread' },
      { id: 'e2', from: 'ask-inner', to: 'inner-gather' },
      { id: 'e3', from: 'inner-gather', to: 'outer-gather' },
      { id: 'e4', from: 'outer-gather', to: 'done' },
    ],
  });
}

/**
 * start -> outer-spread (o-left -> mid-spread, o-right -> outer-gather)
 * mid-spread (m-left -> inner-spread, m-right -> mid-gather)
 * inner-spread (i-a, i-b -> inner-gather) -> mid-gather -> outer-gather -> done
 */
export function threeLevelComposition(): CompositionDefinition {
  return parseComposition({
    schemaVersion: 1,
    id: 'nested-three-level',
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'start {{input}}' } },
      'outer-spread': {
        kind: 'spread',
        config: {
          branches: [
            { id: 'o-left', to: 'mid-spread' },
            { id: 'o-right', to: 'outer-gather' },
          ],
        },
      },
      'mid-spread': {
        kind: 'spread',
        config: {
          branches: [
            { id: 'm-left', to: 'inner-spread' },
            { id: 'm-right', to: 'mid-gather' },
          ],
        },
      },
      'inner-spread': {
        kind: 'spread',
        config: {
          branches: [
            { id: 'i-a', to: 'inner-gather' },
            { id: 'i-b', to: 'inner-gather' },
          ],
        },
      },
      'inner-gather': { kind: 'gather', config: { required: ['i-a', 'i-b'], combine: 'text' } },
      'mid-gather': { kind: 'gather', config: { required: ['m-left', 'm-right'], combine: 'text' } },
      'outer-gather': { kind: 'gather', config: { required: ['o-left', 'o-right'], combine: 'text' } },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'outer-spread' },
      { id: 'e2', from: 'inner-gather', to: 'mid-gather' },
      { id: 'e3', from: 'mid-gather', to: 'outer-gather' },
      { id: 'e4', from: 'outer-gather', to: 'done' },
    ],
  });
}

/**
 * The same three-level nesting as `threeLevelComposition`, but the outer right
 * branch is a user hover instead of a direct Gather arrival:
 *
 * start -> outer-spread
 *   o-left  -> mid-spread (m-left -> inner-spread, m-right -> mid-gather)
 *              inner-spread (i-a, i-b -> inner-gather) -> mid-gather -> outer-gather
 *   o-right -> ask-outer -> outer-gather
 * outer-gather -> done
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
      'outer-spread': {
        kind: 'spread',
        config: {
          branches: [
            { id: 'o-left', to: 'mid-spread' },
            { id: 'o-right', to: 'ask-outer' },
          ],
        },
      },
      'mid-spread': {
        kind: 'spread',
        config: {
          branches: [
            { id: 'm-left', to: 'inner-spread' },
            { id: 'm-right', to: 'mid-gather' },
          ],
        },
      },
      'inner-spread': {
        kind: 'spread',
        config: {
          branches: [
            { id: 'i-a', to: 'inner-gather' },
            { id: 'i-b', to: 'inner-gather' },
          ],
        },
      },
      'inner-gather': { kind: 'gather', config: { required: ['i-a', 'i-b'], combine: 'text' } },
      'mid-gather': { kind: 'gather', config: { required: ['m-left', 'm-right'], combine: 'text' } },
      'outer-gather': { kind: 'gather', config: { required: ['o-left', 'o-right'], combine: 'text' } },
      'ask-outer': { kind: 'user', config: { modality: 'text', prompt: 'outer?' } },
      'queue-node': {
        kind: 'forager',
        config: { connection: 'codex', prompt: 'detached {{input}}' },
        minIntervalMs: 5000,
      },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'outer-spread' },
      { id: 'e2', from: 'inner-gather', to: 'mid-gather' },
      { id: 'e3', from: 'mid-gather', to: 'outer-gather' },
      { id: 'e4', from: 'ask-outer', to: 'outer-gather' },
      { id: 'e5', from: 'outer-gather', to: 'done' },
    ],
  });
}
