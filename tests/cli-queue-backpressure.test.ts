import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runCli } from '../src/cli/cli.js';
import { apiaryForProject } from '../src/cli/cli-shared.js';
import { HoneyStore } from '../src/storage/honey.js';
import {
  parseComposition,
  PheromoneRuntime,
  QUEUE_RETRY_MS,
  type NodeExecutor,
  type Pheromone,
  type Value,
} from '../src/runtime/index.js';
import { FakeAdapter } from './support/fake-adapter.js';

const START = Date.parse('2026-04-01T00:00:00.000Z');

function text(value: string): Value {
  return { kind: 'text', text: value };
}

function tempDirectory(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * ask (hover, answered first) -> sink (hover + full queue) -> done.
 * queueMax: 1 makes the ask answer hit a full sink queue.
 */
function rawComposition(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: 'cli-queue-backpressure',
    defaults: { queueMax: 1 },
    nodes: {
      ask: { kind: 'user', config: { modality: 'text', prompt: 'Ask?' } },
      sink: { kind: 'user', config: { modality: 'text', prompt: 'Sink?' } },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'finish {{input}}' } },
    },
    edges: [
      { id: 'e1', from: 'ask', to: 'sink' },
      { id: 'e2', from: 'sink', to: 'done' },
    ],
  };
}

test('interactive CLI keeps a typed answer while the target queue is full, then retries', async () => {
  const project = tempDirectory('wax-cli-queue-project-');
  const state = tempDirectory('wax-cli-queue-state-');
  const compositionPath = join(
    tempDirectory('wax-cli-queue-composition-'),
    'composition.json',
  );
  const raw = rawComposition();
  writeFileSync(compositionPath, JSON.stringify(raw));

  const definition = parseComposition(raw);
  const store = HoneyStore.forComposition(state, apiaryForProject(project), definition.id);
  const never: NodeExecutor = {
    async execute() {
      return { kind: 'text', text: 'never' };
    },
  };

  // Seed a field where ask hovers and sink already holds a pending input plus a
  // full queue: its minInterval keeps the pending activation from draining the
  // queue, so the first ask answer must wait for real backpressure to clear.
  const seedRuntime = new PheromoneRuntime(definition, {
    executeForager: never,
    now: () => START,
  });
  seedRuntime.trigger('ask', text('question'));
  await seedRuntime.pump();
  const seededField = seedRuntime.exportField();
  const sinkQueued: Pheromone = {
    id: 'ph_cli_queued',
    traceId: 'tr_cli_queued',
    value: text('queued'),
    at: new Date(START).toISOString(),
  };
  const sinkPending: Pheromone = {
    id: 'ph_cli_pending',
    traceId: 'tr_cli_pending',
    value: text('pending'),
    at: new Date(START).toISOString(),
  };
  seededField.nodes['sink'] = {
    queue: [sinkQueued],
    pending: sinkPending,
    lastActivatedAt: new Date(START).toISOString(),
  };
  store.save(seededField);

  const adapter = new FakeAdapter({ output: 'DONE' });
  const stdout: string[] = [];
  const stderr: string[] = [];
  const calls: string[] = [];
  const delays: number[] = [];
  let clock = START;
  let sawPreservedAnswer = false;
  let sinkAnswers = 0;

  const code = await runCli(
    [
      'run',
      compositionPath,
      '--project',
      project,
      '--harness',
      'codex',
      '--state-dir',
      state,
      '--resume',
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      createAdapter: async () => adapter,
      now: () => clock,
      sleep: async (ms) => {
        delays.push(ms);
        clock += Math.max(ms, 1);
      },
      askUser: async (node) => {
        calls.push(node.id);
        if (node.id === 'ask') {
          return text('from-ask');
        }
        // Before answering the sink hover, the preserved ask answer must be
        // visible in the flushed Honey field, i.e. it reached its target.
        const fieldText = readFileSync(store.paths.field, 'utf8');
        if (fieldText.includes('from-ask')) {
          sawPreservedAnswer = true;
        }
        sinkAnswers += 1;
        return text(`sink-answer-${String(sinkAnswers)}`);
      },
    },
  );

  assert.equal(code, 0, stderr.join('\n'));
  assert.match(stderr.join('\n'), /backpressure: target queue 'sink' is full/);
  assert.deepEqual(calls, ['ask', 'sink', 'sink', 'sink'], 'each hover was asked once');
  assert.equal(
    sawPreservedAnswer,
    true,
    'the retried answer reached the sink queue instead of being lost',
  );
  assert.deepEqual(adapter.prompts, [
    'finish sink-answer-1',
    'finish sink-answer-2',
    'finish sink-answer-3',
  ]);
  assert.ok(delays.length > 0, 'the CLI waited instead of spinning');
  assert.equal(delays.every((ms) => ms > 0), true, 'no 0ms pump loop');
  assert.equal(
    delays.includes(QUEUE_RETRY_MS),
    true,
    'a blocked answer asks for the short queue retry wait',
  );
  const summary = JSON.parse(
    readFileSync(store.paths.field, 'utf8'),
  ) as { rest: boolean };
  assert.equal(summary.rest, true);
  assert.ok(stdout.includes('rest         true'));
});

/** a (forager) -> b (user), with b's queue already full and pending rate-limited. */
function blockedActivationComposition(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: 'cli-blocked-activation',
    defaults: { queueMax: 1 },
    nodes: {
      a: { kind: 'forager', config: { connection: 'codex', prompt: 'a {{input}}' } },
      b: { kind: 'user', config: { modality: 'text', prompt: 'b?' } },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done {{input}}' } },
    },
    edges: [
      { id: 'e1', from: 'a', to: 'b' },
      { id: 'e2', from: 'b', to: 'done' },
    ],
  };
}

test('a blocked activation does not spin the CLI at 0ms', async () => {
  const project = tempDirectory('wax-cli-blocked-project-');
  const state = tempDirectory('wax-cli-blocked-state-');
  const compositionPath = join(
    tempDirectory('wax-cli-blocked-composition-'),
    'composition.json',
  );
  const raw = blockedActivationComposition();
  writeFileSync(compositionPath, JSON.stringify(raw));
  const definition = parseComposition(raw);
  const store = HoneyStore.forComposition(state, apiaryForProject(project), definition.id);

  const at = new Date(START).toISOString();
  const pheromone = (id: string, value: string): Pheromone => ({
    id,
    traceId: `tr_${id}`,
    value: text(value),
    at,
  });
  store.save({
    schemaVersion: 1,
    compositionId: definition.id,
    graphRevision: definition.graphRevision,
    rest: false,
    nodes: {
      // a is ready, but its only target b is full.
      a: { queue: [pheromone('ph_a', 'a')] },
      // b has a full queue and a rate-limited pending head, so nothing can drain.
      b: {
        queue: [pheromone('ph_b_queue', 'b-queue')],
        pending: pheromone('ph_b_pending', 'b-pending'),
        lastActivatedAt: at,
      },
    },
  });

  const delays: number[] = [];
  const code = await runCli(
    [
      'run',
      compositionPath,
      '--project',
      project,
      '--harness',
      'codex',
      '--state-dir',
      state,
      '--resume',
    ],
    {
      createAdapter: async () => new FakeAdapter({ output: 'DONE' }),
      now: () => START,
      sleep: async (ms) => {
        delays.push(ms);
        throw new Error('stop after first wait');
      },
    },
  );

  assert.equal(code, 1, 'the injected sleep stops the run cleanly');
  assert.ok(delays.length > 0, 'the CLI reached a wait instead of spinning');
  assert.equal(delays[0], QUEUE_RETRY_MS, 'a blocked activation waits the retry interval');
  assert.ok((delays[0] ?? 0) > 0, 'no 0ms pump loop');
});
