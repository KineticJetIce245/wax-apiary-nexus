import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createMemoryLog,
  parseComposition,
  PheromoneRuntime,
  type GuardDecision,
  type NodeExecutor,
} from '../src/runtime/index.js';

const START = Date.parse('2026-03-01T00:00:00.000Z');

function guardComposition(): ReturnType<typeof parseComposition> {
  return parseComposition({
    schemaVersion: 1,
    id: 'guard',
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'run {{input}}' } },
    },
    edges: [],
  });
}

function guardExecutor(): { executor: NodeExecutor; decisions: GuardDecision[] } {
  const decisions: GuardDecision[] = [];
  return {
    decisions,
    executor: {
      async execute(_node, _input, context) {
        if (context === undefined) {
          throw new Error('missing context');
        }
        const decision = await context.requestGuard({
          requestId: 'r1',
          executionId: 'e1',
          summary: 'run a command',
          options: ['allow_once', 'reject_once'],
        });
        decisions.push(decision);
        return { kind: 'text', text: `decision:${decision}` };
      },
    },
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('a guard request parks the node in a guard hover and waits for the decision', async () => {
  const { executor, decisions } = guardExecutor();
  const runtime = new PheromoneRuntime(guardComposition(), {
    executeForager: executor,
    now: () => START,
    guardTimeoutMs: 5_000,
    onGuard: () => new Promise(() => undefined),
  });

  runtime.trigger('start', { kind: 'text', text: 'x' });
  const pumping = runtime.pump();
  await wait(20);

  const hover = runtime.snapshot().nodes['start']?.hover;
  assert.ok(hover !== undefined);
  assert.equal(hover.kind, 'guard');
  assert.equal(hover.meta?.['requestId'], 'r1');
  assert.equal(runtime.snapshot().rest, false);

  runtime.settleGuard('start', 'r1', 'allow_once');
  await pumping;

  assert.deepEqual(decisions, ['allow_once']);
  assert.equal(runtime.snapshot().nodes['start']?.hover, undefined);
  assert.equal(runtime.snapshot().rest, true);
});

test('without a handler the guard is rejected, never allowed', async () => {
  const { executor, decisions } = guardExecutor();
  const runtime = new PheromoneRuntime(guardComposition(), {
    executeForager: executor,
    now: () => START,
  });

  runtime.trigger('start', { kind: 'text', text: 'x' });
  await runtime.pump();

  assert.deepEqual(decisions, ['reject_once']);
});

test('a guard that times out is cancelled and cannot be settled afterwards', async () => {
  const log = createMemoryLog();
  const { executor, decisions } = guardExecutor();
  const runtime = new PheromoneRuntime(guardComposition(), {
    executeForager: executor,
    now: () => START,
    guardTimeoutMs: 25,
    onGuard: () => new Promise(() => undefined),
    onLog: log.sink,
  });

  runtime.trigger('start', { kind: 'text', text: 'x' });
  await runtime.pump();

  assert.deepEqual(decisions, ['cancelled']);
  assert.ok(log.entries.some((entry) => entry.event === 'guard.timeout'));
  assert.equal(runtime.snapshot().nodes['start']?.hover, undefined);

  assert.throws(() => runtime.settleGuard('start', 'r1', 'allow_once'), /no open guard/);
});

test('a decision for another request is rejected and does not disturb the open one', async () => {
  const { executor, decisions } = guardExecutor();
  const runtime = new PheromoneRuntime(guardComposition(), {
    executeForager: executor,
    now: () => START,
    guardTimeoutMs: 5_000,
    onGuard: () => new Promise(() => undefined),
  });

  runtime.trigger('start', { kind: 'text', text: 'x' });
  const pumping = runtime.pump();
  await wait(20);

  assert.throws(() => runtime.settleGuard('start', 'other', 'allow_once'), /no open guard/);
  assert.equal(runtime.snapshot().nodes['start']?.hover?.meta?.['requestId'], 'r1');

  runtime.settleGuard('start', 'r1', 'reject_once');
  await pumping;
  assert.deepEqual(decisions, ['reject_once']);
});

test('an early decision is rejected', () => {
  const { executor } = guardExecutor();
  const runtime = new PheromoneRuntime(guardComposition(), {
    executeForager: executor,
    now: () => START,
  });

  assert.throws(() => runtime.settleGuard('start', 'r1', 'allow_once'), /no open guard/);
});

test('a decision for an unknown node is rejected', () => {
  const { executor } = guardExecutor();
  const runtime = new PheromoneRuntime(guardComposition(), {
    executeForager: executor,
    now: () => START,
  });

  assert.throws(() => runtime.settleGuard('ghost', 'r1', 'allow_once'), /no open guard/);
});
