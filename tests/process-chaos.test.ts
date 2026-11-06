import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import {
  createMemoryLog,
  parseComposition,
  PheromoneRuntime,
  serializeValue,
  type CompositionDefinition,
  type NodeExecutor,
  type PersistedField,
  type Value,
} from '../src/runtime/index.js';
import { HoneyStore } from '../src/storage/honey.js';

/**
 * OS-process chaos tests: a real child process holds forager activations open
 * and persists mid-flight Honey; the parent SIGKILLs it and restores from disk.
 *
 * SIGKILL is process sudden death, not a power cut. These tests cover the
 * runtime's recovery contract for a dead process (an active forager becomes
 * unknown, wait slots and hovers survive, nothing is replayed). They do not
 * claim to cover disk flush, filesystem power-loss ordering or torn writes:
 * HoneyStore replaces `field.json` with a same-directory rename, and the
 * parent only ever loads a complete file.
 */

const START = Date.parse('2026-09-01T00:00:00.000Z');
const APIARY_ID = 'chaos';
const COMPOSITION_ID = 'process-chaos';
const BURST_COMPOSITION_ID = 'process-chaos-burst';
const READY_TIMEOUT_MS = 15_000;
const KILL_TIMEOUT_MS = 10_000;
const POLL_MS = 25;

function text(value: string): Value {
  return { kind: 'text', text: value };
}

function textOf(pheromone: { readonly value: Value }): string {
  return serializeValue(pheromone.value);
}

function readLines(path: string): string[] {
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.length > 0);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ExecutedCall {
  readonly nodeId: string;
  readonly input: Value;
}

function recorder(): { calls: ExecutedCall[]; executor: NodeExecutor } {
  const calls: ExecutedCall[] = [];
  return {
    calls,
    executor: {
      async execute(node, input) {
        calls.push({ nodeId: node.id, input });
        return { kind: 'text', text: `recorder:${node.id}:${serializeValue(input)}` };
      },
    },
  };
}

interface ChildHandle {
  readonly child: ChildProcess;
  readonly stderr: () => string;
  readonly spawnError: () => Error | undefined;
}

function startChild(args: readonly string[], cwd: string): ChildHandle {
  const child = spawn(process.execPath, [...args], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  let spawnError: Error | undefined;
  child.once('error', (error) => {
    spawnError = error;
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  return { child, stderr: () => stderr, spawnError: () => spawnError };
}

async function waitForChild(
  handle: ChildHandle,
  predicate: () => boolean,
  label: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    const error = handle.spawnError();
    if (error !== undefined) {
      assert.fail(`${label}: child failed to start: ${error.message}`);
    }
    if (handle.child.exitCode !== null || handle.child.signalCode !== null) {
      assert.fail(
        `${label}: child exited early (code=${String(handle.child.exitCode)}, signal=${String(handle.child.signalCode)}); stderr=${handle.stderr()}`,
      );
    }
    if (Date.now() >= deadline) {
      assert.fail(`${label}: timed out after ${String(timeoutMs)}ms; stderr=${handle.stderr()}`);
    }
    await delay(POLL_MS);
  }
}

function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null } | undefined> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(undefined);
    }, timeoutMs);
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      clearTimeout(timer);
      resolve({ code, signal });
    };
    child.once('exit', onExit);
  });
}

async function killAndWait(
  handle: ChildHandle,
  label: string,
): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> {
  const killed = handle.child.kill('SIGKILL');
  assert.equal(
    killed,
    true,
    `${label}: SIGKILL was not delivered to child pid ${String(handle.child.pid)}`,
  );
  const exit = await waitForExit(handle.child, KILL_TIMEOUT_MS);
  assert.ok(
    exit !== undefined,
    `${label}: child pid ${String(handle.child.pid)} did not exit within ${String(KILL_TIMEOUT_MS)}ms after SIGKILL; stderr=${handle.stderr()}`,
  );
  assert.equal(exit.signal, 'SIGKILL', `${label}: the child must actually die from SIGKILL`);
  return exit;
}

async function terminateIfAlive(handle: ChildHandle): Promise<void> {
  if (handle.child.exitCode !== null || handle.child.signalCode !== null) {
    return;
  }
  handle.child.kill('SIGKILL');
  const exit = await waitForExit(handle.child, KILL_TIMEOUT_MS);
  if (exit === undefined) {
    throw new Error(
      `process ${String(handle.child.pid)} survived SIGKILL after cleanup within ${String(KILL_TIMEOUT_MS)}ms`,
    );
  }
}

// ---------------------------------------------------------------------------
// Single-point test: start -> done
// ---------------------------------------------------------------------------

/**
 * The runtime never keeps `pending` on a node that already has an `active`
 * Pheromone: `takeRunnable()` skips active nodes before it can move a queued
 * entry into `pending`, and an activation deletes its pending slot before
 * setting `active`. A single node therefore cannot hold active + pending +
 * queue at the same time. This composition still produces all three mid-flight
 * slots in one real saved field, on two nodes: `start` is active in the child
 * process, while `done` holds the pending head and the queued tail.
 */
function singleCompositionInput(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: COMPOSITION_ID,
    defaults: { queueMax: 8, queueTtlMs: 60_000, minIntervalMs: 1000 },
    nodes: {
      start: { kind: 'forager', config: { connection: 'fake', prompt: 'start {{input}}' } },
      done: { kind: 'forager', config: { connection: 'fake', prompt: 'done {{input}}' } },
    },
    edges: [{ id: 'e1', from: 'start', to: 'done' }],
  };
}

function singleDefinition(): CompositionDefinition {
  return parseComposition(singleCompositionInput());
}

/** The single-point child: build active + pending + queue, then wait to be killed. */
function singleChildScript(runtimeUrl: string, honeyUrl: string): string {
  return [
    "import { appendFileSync, existsSync, writeFileSync } from 'node:fs';",
    "import { setTimeout as delay } from 'node:timers/promises';",
    '',
    `import { parseComposition, PheromoneRuntime } from ${JSON.stringify(runtimeUrl)};`,
    `import { HoneyStore } from ${JSON.stringify(honeyUrl)};`,
    '',
    'const [stateRoot, markerPath, readyPath] = process.argv.slice(2);',
    "if (stateRoot === undefined || markerPath === undefined || readyPath === undefined) {",
    "  throw new Error('child: expected <stateRoot> <markerPath> <readyPath>');",
    '}',
    `const START = ${String(START)};`,
    `const definition = parseComposition(${JSON.stringify(singleCompositionInput(), null, 2)});`,
    `const store = HoneyStore.forComposition(stateRoot, ${JSON.stringify(APIARY_ID)}, ${JSON.stringify(COMPOSITION_ID)});`,
    'const clock = () => START;',
    '',
    'const executor = {',
    '  execute(node, input) {',
    "    if (node.id === 'start') {",
    "      const text = input.kind === 'text' ? input.text : '?';",
    "      appendFileSync(markerPath, 'start:' + text + '\\n');",
    '      return new Promise(() => {});',
    '    }',
    "    const text = input.kind === 'text' ? input.text : '?';",
    "    return Promise.resolve({ kind: 'text', text: 'done:' + text });",
    '  },',
    '};',
    '',
    'const runtime = new PheromoneRuntime(definition, { executeForager: executor, now: clock });',
    '',
    '// Warm `done` once so its minimum interval is armed: the next queue head',
    '// will stop in `pending` instead of activating immediately.',
    "runtime.trigger('done', { kind: 'text', text: 'warm' });",
    'await runtime.pump();',
    '',
    '// The active forager: `start` enters its executor (marker) and never resolves.',
    "runtime.trigger('start', { kind: 'text', text: 'root' });",
    'void runtime.pump();',
    'while (!existsSync(markerPath)) {',
    '  await delay(25);',
    '}',
    '',
    '// Real wait slots behind the minimum interval: p1 pending, p2/p3 queued.',
    "runtime.trigger('done', { kind: 'text', text: 'p1' });",
    "runtime.trigger('done', { kind: 'text', text: 'p2' });",
    "runtime.trigger('done', { kind: 'text', text: 'p3' });",
    'await runtime.pump();',
    '',
    'store.save(runtime.exportField());',
    "writeFileSync(readyPath, 'ready\\n');",
    '',
    '// Stay alive (and keep the hanging activation) until the parent SIGKILLs us.',
    'setInterval(() => {}, 1000);',
    '',
  ].join('\n');
}

test(
  'SIGKILLed child mid-flight: Honey restore marks the active forager unknown, keeps pending/queue and replays nothing',
  { timeout: 60_000 },
  async (t) => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'wax-process-chaos-'));
    const scriptPath = join(tempRoot, 'chaos-child.mjs');
    const markerPath = join(tempRoot, 'active.marker');
    const readyPath = join(tempRoot, 'ready');

    const runtimeUrl = new URL('../src/runtime/index.js', import.meta.url).href;
    const honeyUrl = new URL('../src/storage/honey.js', import.meta.url).href;
    writeFileSync(scriptPath, singleChildScript(runtimeUrl, honeyUrl), 'utf8');

    const store = HoneyStore.forComposition(tempRoot, APIARY_ID, COMPOSITION_ID);
    const comp = singleDefinition();

    let handle: ChildHandle | undefined;
    try {
      handle = startChild([scriptPath, tempRoot, markerPath, readyPath], tempRoot);

      // 1. Wait for the child to persist its mid-flight field.
      await waitForChild(
        handle,
        () => existsSync(readyPath),
        'child ready file',
        READY_TIMEOUT_MS,
      );

      // 2. Read the field from disk and record the live slots.
      const saved: PersistedField | undefined = store.load();
      assert.ok(saved !== undefined, 'the child must have written honey/field.json');
      assert.equal(saved.rest, false);
      assert.equal(saved.compositionId, COMPOSITION_ID);
      assert.equal(saved.graphRevision, comp.graphRevision);

      const startNode = saved.nodes['start'];
      const doneNode = saved.nodes['done'];
      assert.ok(startNode !== undefined, "field has a 'start' node");
      assert.ok(doneNode !== undefined, "field has a 'done' node");

      const activeRoot = startNode.active;
      assert.ok(activeRoot !== undefined, 'start holds the active Pheromone of the live child');
      assert.equal(textOf(activeRoot), 'root');
      assert.equal(activeRoot.at, new Date(START).toISOString());

      const pendingEntry = doneNode.pending;
      assert.ok(pendingEntry !== undefined, 'done holds a pending Pheromone behind minIntervalMs');
      assert.equal(textOf(pendingEntry), 'p1');

      const queuedEntries = [...doneNode.queue];
      assert.equal(queuedEntries.length, 2, 'done keeps two more Pheromones in its queue');
      assert.deepEqual(
        queuedEntries.map((pheromone) => textOf(pheromone)),
        ['p2', 'p3'],
      );
      assert.equal(queuedEntries[0]?.at, new Date(START).toISOString());
      assert.equal(queuedEntries[1]?.at, new Date(START).toISOString());

      // The active executor really entered once, and only once.
      assert.deepEqual(readLines(markerPath), ['start:root']);
      t.diagnostic(
        `field before kill: active=${activeRoot.id}@${activeRoot.at} ` +
          `pending=${pendingEntry.id}@${pendingEntry.at} ` +
          `queue=${queuedEntries.map((entry) => entry.id).join(',')} ` +
          `markerLines=${String(readLines(markerPath).length)}`,
      );

      // 3. Kill the live process and wait for the real exit.
      const exit = await killAndWait(handle, 'single kill');
      t.diagnostic(
        `child pid=${String(handle.child.pid)} killed: exitCode=${String(exit.code)} signal=${String(exit.signal)}`,
      );

      // 4. Restore from the persisted field with a recorder and an injected clock.
      let clock = START;
      const log = createMemoryLog();
      const parentRecorder = recorder();
      const { runtime: restored, report } = PheromoneRuntime.restore(comp, saved, {
        executeForager: parentRecorder.executor,
        now: () => clock,
        onLog: log.sink,
      });

      assert.deepEqual(report.unknownActive, ['start']);
      assert.equal(report.stuckActive.includes('start'), false);
      assert.deepEqual(report.resumedHovers, []);
      assert.equal(parentRecorder.calls.length, 0, 'restore must not execute any node');
      t.diagnostic(`restore report: ${JSON.stringify(report)}`);

      const restoredField = restored.exportField();
      const restoredStart = restoredField.nodes['start'];
      const restoredDone = restoredField.nodes['done'];
      assert.ok(restoredStart !== undefined);
      assert.ok(restoredDone !== undefined);

      // The active Pheromone is not reattached and not replayed.
      assert.equal(restoredStart.active, undefined, 'an active Pheromone is never reattached');
      assert.equal(restoredStart.state?.['lastOutcome'], 'unknown');
      assert.equal(restoredStart.state?.['needsAttention'], true);

      // The wait slots survive byte-for-byte (id, at, value).
      assert.equal(restoredDone.pending?.id, pendingEntry.id);
      assert.equal(restoredDone.pending?.at, pendingEntry.at);
      assert.equal(restoredDone.pending === undefined ? undefined : textOf(restoredDone.pending), 'p1');
      assert.deepEqual(
        restoredDone.queue.map((entry) => entry.id),
        queuedEntries.map((entry) => entry.id),
      );
      assert.deepEqual(
        restoredDone.queue.map((entry) => entry.at),
        queuedEntries.map((entry) => entry.at),
      );
      assert.deepEqual(
        restoredDone.queue.map((entry) => textOf(entry)),
        ['p2', 'p3'],
      );
      assert.equal(restoredField.rest, false);

      // 5. An empty pump at the saved clock must not replay anything.
      const beforeEmptyPump = restored.exportField();
      await restored.pump();
      assert.equal(parentRecorder.calls.length, 0, 'an empty pump after restore called the executor');
      assert.deepEqual(
        restored.exportField(),
        beforeEmptyPump,
        'an empty pump at the saved clock changed the field',
      );
      assert.equal(
        log.entries.some((entry) => entry.event === 'node.activated' && entry.nodeId === 'start'),
        false,
        'the active start node was re-activated',
      );

      // 6. Only new input moves after the clock advances; `root` never comes back.
      clock += 1000;
      await restored.pump();
      assert.deepEqual(
        parentRecorder.calls.map((call) => `${call.nodeId}:${serializeValue(call.input)}`),
        ['done:p1'],
      );

      clock += 1000;
      await restored.pump();
      clock += 1000;
      await restored.pump();

      assert.deepEqual(
        parentRecorder.calls.map((call) => `${call.nodeId}:${serializeValue(call.input)}`),
        ['done:p1', 'done:p2', 'done:p3'],
      );
      assert.equal(
        parentRecorder.calls.some((call) => call.nodeId === 'start'),
        false,
        'the killed start activation was replayed',
      );
      assert.equal(
        parentRecorder.calls.some((call) => serializeValue(call.input) === 'root'),
        false,
      );
      assert.equal(restored.snapshot().rest, true, 'draining the wait slots reaches Rest');
      assert.equal(restored.exportField().nodes['done']?.queue.length, 0);
      assert.equal(restored.exportField().nodes['done']?.pending, undefined);

      // 7. No failure, no duplicate terminal execution, and no replayed side effect.
      assert.equal(
        log.entries.some((entry) => entry.event === 'node.failed'),
        false,
        'restore or pumping logged node.failed',
      );
      const completedIds = log.entries
        .filter((entry) => entry.event === 'node.completed')
        .map((entry) => entry.pheromoneId);
      assert.deepEqual(completedIds, [
        pendingEntry.id,
        queuedEntries[0]?.id,
        queuedEntries[1]?.id,
      ]);
      assert.equal(
        log.entries.some(
          (entry) => entry.event === 'node.activated' && entry.nodeId === 'start',
        ),
        false,
      );
      assert.deepEqual(readLines(markerPath), ['start:root']);
      assert.equal(readLines(markerPath).length, 1, 'the active side effect was replayed');
    } finally {
      // Never leave a live child behind, even when an assertion above failed.
      if (handle !== undefined) {
        await terminateIfAlive(handle);
      }
    }
  },
);

// ---------------------------------------------------------------------------
// Seeded burst: SIGKILL at deterministic progress checkpoints
// ---------------------------------------------------------------------------

/**
 * The burst composition adds a fork/merge and a user hover, so a killed field
 * can contain an incomplete join, an open hover, wait slots and an active
 * forager. `hold` is the active forager (its executor never resolves); `park`
 * is the rate-limited node whose pending/queue slots are real.
 */
function burstCompositionInput(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: BURST_COMPOSITION_ID,
    defaults: { queueMax: 8, queueTtlMs: 60_000, minIntervalMs: 1000 },
    nodes: {
      start: { kind: 'forager', config: { connection: 'fake', prompt: 'start {{input}}' } },
      fan: {
        kind: 'fork',
        config: {
          branches: [
            { id: 'a', to: 'work' },
            { id: 'b', to: 'ask' },
          ],
        },
      },
      work: { kind: 'forager', config: { connection: 'fake', prompt: 'work {{input}}' } },
      ask: { kind: 'user', config: { modality: 'text', prompt: 'ask {{input}}' } },
      join: {
        kind: 'merge',
        config: { required: ['a', 'b'], combine: 'text' },
      },
      done: { kind: 'forager', config: { connection: 'fake', prompt: 'done {{input}}' } },
      hold: { kind: 'forager', config: { connection: 'fake', prompt: 'hold {{input}}' } },
      park: { kind: 'forager', config: { connection: 'fake', prompt: 'park {{input}}' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'fan' },
      { id: 'e2', from: 'work', to: 'join' },
      { id: 'e3', from: 'ask', to: 'join' },
      { id: 'e4', from: 'join', to: 'done' },
    ],
  };
}

function burstDefinition(): CompositionDefinition {
  return parseComposition(burstCompositionInput());
}

/**
 * Checkpoints in chronological order. The parent kills at one of them; the
 * child writes the label and then blocks there, so the kill point is exact
 * instead of racing a poll interval. `save:N:begin` is written before the save
 * and `save:N:end` after it; this covers "around a save" and does not claim to
 * hit inside `writeFileSync` + rename.
 */
const BURST_PHASES = [
  'save:1:begin',
  'save:1:end',
  'hover',
  'save:2:begin',
  'save:2:end',
  'active',
  'save:3:begin',
  'save:3:end',
  'queue',
] as const;

type BurstPhase = (typeof BURST_PHASES)[number];

interface BurstRound {
  readonly seed: number;
  readonly phase: BurstPhase;
}

/**
 * Fixed seeds and kill points. The plan guarantees at least two rounds in each
 * required class: active, open hover, non-empty pending/queue, a save-before
 * point and a save-after point.
 */
const BURST_ROUNDS: readonly BurstRound[] = [
  { seed: 2101, phase: 'hover' },
  { seed: 2102, phase: 'save:1:begin' },
  { seed: 2103, phase: 'active' },
  { seed: 2104, phase: 'save:1:end' },
  { seed: 2105, phase: 'queue' },
  { seed: 2106, phase: 'save:2:begin' },
  { seed: 2107, phase: 'save:2:end' },
  { seed: 2108, phase: 'save:3:begin' },
  { seed: 2109, phase: 'queue' },
  { seed: 2110, phase: 'active' },
  { seed: 2111, phase: 'save:3:end' },
  { seed: 2112, phase: 'hover' },
];

/**
 * The child scripted sequence:
 *   save(0)                                  empty field
 *   start -> pump                            fork -> work, ask hovers, join waits
 *   save(1), checkpoint('hover')
 *   hold('h1') -> pump                       hold active (executor never resolves)
 *   save(2), checkpoint('active')
 *   park('warm') -> pump                     warm the rate limit
 *   park(p1..pN) -> pump                     p1 pending, p2.. queue
 *   save(3), checkpoint('queue')
 *
 * Every kill phase is after `save(0)`, so a field exists for every round.
 */
function burstChildScript(runtimeUrl: string, honeyUrl: string): string {
  return [
    "import { appendFileSync } from 'node:fs';",
    '',
    `import { parseComposition, PheromoneRuntime } from ${JSON.stringify(runtimeUrl)};`,
    `import { HoneyStore } from ${JSON.stringify(honeyUrl)};`,
    '',
    'const [stateRoot, markerPath, progressPath, targetPhase, seedText] = process.argv.slice(2);',
    "if (stateRoot === undefined || markerPath === undefined || progressPath === undefined || targetPhase === undefined || seedText === undefined) {",
    "  throw new Error('child: expected <stateRoot> <markerPath> <progressPath> <targetPhase> <seed>');",
    '}',
    `const TARGET_PHASES = ${JSON.stringify(BURST_PHASES)};`,
    'if (!TARGET_PHASES.includes(targetPhase)) {',
    "  throw new Error('child: unknown target phase ' + targetPhase);",
    '}',
    `const START = ${String(START)};`,
    'const seed = Number(seedText);',
    `const definition = parseComposition(${JSON.stringify(burstCompositionInput(), null, 2)});`,
    `const store = HoneyStore.forComposition(stateRoot, ${JSON.stringify(APIARY_ID)}, ${JSON.stringify(BURST_COMPOSITION_ID)});`,
    'const clock = () => START;',
    '',
    '// A kill target blocks here forever; the parent sees the label and SIGKILLs.',
    'const blockForever = () => new Promise(() => {});',
    'const checkpoint = async (label) => {',
    "  appendFileSync(progressPath, label + '\\n');",
    '  if (label === targetPhase) {',
    '    setInterval(() => {}, 1000);',
    '    await blockForever();',
    '  }',
    '};',
    'const save = async (index) => {',
    "  await checkpoint('save:' + index + ':begin');",
    '  store.save(runtime.exportField());',
    "  await checkpoint('save:' + index + ':end');",
    '};',
    '',
    'const executor = {',
    '  execute(node, input) {',
    "    const text = input.kind === 'text' ? input.text : '?';",
    "    if (node.id === 'hold') {",
    "      appendFileSync(markerPath, 'hold:' + text + '\\n');",
    '      return new Promise(() => {});',
    '    }',
    "    return Promise.resolve({ kind: 'text', text: node.id + ':' + text });",
    '  },',
    '};',
    '',
    'const runtime = new PheromoneRuntime(definition, { executeForager: executor, now: clock });',
    '',
    'await save(0);',
    "runtime.trigger('start', { kind: 'text', text: 'root-' + seed });",
    "await checkpoint('op:start-trigger');",
    'await runtime.pump();',
    "await checkpoint('op:start-pump');",
    'await save(1);',
    "await checkpoint('hover');",
    '',
    "runtime.trigger('hold', { kind: 'text', text: 'h1' });",
    "await checkpoint('op:hold-trigger');",
    '// The active activation is now hanging; a second pump can still run `park`.',
    'void runtime.pump();',
    "await checkpoint('op:hold-pump-start');",
    'await save(2);',
    "await checkpoint('active');",
    '',
    "runtime.trigger('park', { kind: 'text', text: 'warm' });",
    "await checkpoint('op:park-warm-trigger');",
    'await runtime.pump();',
    "await checkpoint('op:park-warm-pump');",
    '',
    'const queued = 2 + (seed % 2);',
    'for (let index = 1; index <= queued; index += 1) {',
    "  runtime.trigger('park', { kind: 'text', text: 'p' + index });",
    '}',
    "await checkpoint('op:park-queue-trigger');",
    'await runtime.pump();',
    "await checkpoint('op:park-queue-pump');",
    'await save(3);',
    "await checkpoint('queue');",
    '',
    'setInterval(() => {}, 1000);',
    'await blockForever();',
    '',
  ].join('\n');
}

interface KillObservation {
  readonly phase: string;
  readonly exit: { readonly code: number | null; readonly signal: NodeJS.Signals | null };
  readonly progress: readonly string[];
  readonly marker: readonly string[];
  readonly stderr: string;
}

async function killBurstChild(
  t: TestContext,
  tempRoot: string,
  seed: number,
  phase: string,
): Promise<KillObservation> {
  const scriptPath = join(tempRoot, 'burst-child.mjs');
  const markerPath = join(tempRoot, 'active.marker');
  const progressPath = join(tempRoot, 'progress.log');
  const runtimeUrl = new URL('../src/runtime/index.js', import.meta.url).href;
  const honeyUrl = new URL('../src/storage/honey.js', import.meta.url).href;
  writeFileSync(scriptPath, burstChildScript(runtimeUrl, honeyUrl), 'utf8');

  const handle = startChild(
    [scriptPath, tempRoot, markerPath, progressPath, phase, String(seed)],
    tempRoot,
  );
  try {
    await waitForChild(
      handle,
      () => readLines(progressPath).includes(phase),
      `seed=${String(seed)} kill phase '${phase}'`,
      READY_TIMEOUT_MS,
    );
    const exit = await killAndWait(handle, `seed=${String(seed)} phase '${phase}'`);
    t.diagnostic(
      `burst seed=${String(seed)} phase=${phase} pid=${String(handle.child.pid)} ` +
        `exitCode=${String(exit.code)} signal=${String(exit.signal)}`,
    );
    return {
      phase,
      exit,
      progress: readLines(progressPath),
      marker: readLines(markerPath),
      stderr: handle.stderr(),
    };
  } finally {
    await terminateIfAlive(handle);
  }
}

function activeForagersOf(
  comp: CompositionDefinition,
  field: PersistedField,
): string[] {
  const ids: string[] = [];
  for (const [id, node] of Object.entries(field.nodes)) {
    if (node.active === undefined) {
      continue;
    }
    const definition = comp.nodes.get(id);
    assert.ok(definition !== undefined, `field has node '${id}' in the composition`);
    assert.equal(
      definition.kind,
      'forager',
      `burst field has an active non-forager node '${id}'`,
    );
    ids.push(id);
  }
  return ids.sort();
}

function hoveredNodesOf(field: PersistedField): string[] {
  return Object.keys(field.nodes)
    .filter((id) => field.nodes[id]?.hover !== undefined)
    .sort();
}

function hasOpenJoin(field: PersistedField): boolean {
  for (const node of Object.values(field.nodes)) {
    for (const join of Object.values(node.joins ?? {})) {
      if (join.completedAt === undefined && join.timedOutAt === undefined) {
        return true;
      }
    }
  }
  return false;
}

function restoreField(
  comp: CompositionDefinition,
  saved: PersistedField,
  now: () => number,
): {
  readonly calls: ExecutedCall[];
  readonly log: ReturnType<typeof createMemoryLog>;
  readonly restored: PheromoneRuntime;
  readonly report: ReturnType<typeof PheromoneRuntime.restore>['report'];
} {
  const log = createMemoryLog();
  const parentRecorder = recorder();
  const { runtime, report } = PheromoneRuntime.restore(comp, saved, {
    executeForager: parentRecorder.executor,
    now,
    onLog: log.sink,
  });
  return { calls: parentRecorder.calls, log, restored: runtime, report };
}

test(
  'seeded burst SIGKILL: every killed Honey field restores without replay, including active, hover, wait slots and joins',
  { timeout: 60_000 },
  async (t) => {
    const comp = burstDefinition();
    const coverage = {
      active: false,
      hover: false,
      wait: false,
      join: false,
      saveBefore: false,
      saveAfter: false,
    };
    const killedPhases: string[] = [];

    for (const [roundIndex, round] of BURST_ROUNDS.entries()) {
      let phaseIndex = BURST_PHASES.indexOf(round.phase);
      assert.notEqual(phaseIndex, -1, `unknown burst phase '${round.phase}'`);

      let saved: PersistedField | undefined;
      let observation: KillObservation | undefined;
      let tempRoot = '';

      // The first save happens before every kill phase, so a missing field is
      // unexpected. Per the burst contract, do not skip the round silently: a
      // missing field means the kill point was too early, so choose a later
      // phase (seeded round, same seed, later checkpoint) and try again.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        tempRoot = mkdtempSync(
          join(tmpdir(), `wax-process-chaos-burst-${String(roundIndex)}-`),
        );
        const phase = BURST_PHASES[phaseIndex];
        assert.ok(phase !== undefined, `no burst phase at index ${String(phaseIndex)}`);
        observation = await killBurstChild(t, tempRoot, round.seed, phase);
        const store = HoneyStore.forComposition(tempRoot, APIARY_ID, BURST_COMPOSITION_ID);
        saved = store.load();
        if (saved !== undefined) {
          break;
        }
        const nextIndex = Math.min(phaseIndex + 1, BURST_PHASES.length - 1);
        t.diagnostic(
          `burst round ${String(roundIndex)} seed=${String(round.seed)}: no Honey field after kill at '${phase}'; ` +
            `too early, choosing later kill point '${BURST_PHASES[nextIndex] ?? '?'}'`,
        );
        assert.notEqual(
          nextIndex,
          phaseIndex,
          `round ${String(roundIndex)}: no Honey field at the last kill point`,
        );
        phaseIndex = nextIndex;
      }

      assert.ok(observation !== undefined);
      assert.ok(saved !== undefined, `round ${String(roundIndex)}: Honey field is missing`);
      const field: PersistedField = saved;
      const killedPhase = observation.phase;
      killedPhases.push(killedPhase);
      assert.ok(
        observation.progress.includes(killedPhase),
        `round ${String(roundIndex)}: the child never reported kill phase '${killedPhase}'`,
      );

      const activeForagers = activeForagersOf(comp, field);
      const hoveredNodes = hoveredNodesOf(field);
      const waitNodes = Object.keys(field.nodes).filter((id) => {
        const node = field.nodes[id];
        return node !== undefined && (node.pending !== undefined || node.queue.length > 0);
      });
      const openJoin = hasOpenJoin(field);

      assert.equal(field.schemaVersion, 1);
      assert.equal(field.compositionId, BURST_COMPOSITION_ID);
      assert.equal(field.graphRevision, comp.graphRevision);

      // 1. Restore without executing anything; the report maps the dead process.
      let clock = START;
      const { calls, log, restored, report } = restoreField(comp, field, () => clock);
      assert.equal(calls.length, 0, 'restore must not execute any node');
      assert.deepEqual([...report.unknownActive].sort(), activeForagers);
      assert.deepEqual([...report.stuckActive].sort(), []);
      assert.deepEqual([...report.resumedHovers].sort(), hoveredNodes);

      // 2. Every wait slot, hover and join survives byte-for-byte; active does not.
      const restoredField = restored.exportField();
      for (const [id, node] of Object.entries(field.nodes)) {
        const after = restoredField.nodes[id];
        assert.ok(after !== undefined, `restored field lost node '${id}'`);
        if (node.active !== undefined) {
          assert.equal(after.active, undefined, `active '${id}' was reattached`);
        }
        assert.deepEqual(after.queue, node.queue, `queue changed on '${id}'`);
        assert.deepEqual(after.pending, node.pending, `pending changed on '${id}'`);
        assert.deepEqual(after.joins, node.joins, `joins changed on '${id}'`);
        assert.deepEqual(after.hover, node.hover, `hover changed on '${id}'`);
        assert.deepEqual(
          after.hoverPheromone,
          node.hoverPheromone,
          `hoverPheromone changed on '${id}'`,
        );
      }
      assert.equal(restoredField.rest, field.rest);

      // 3. An empty pump at the saved clock changes nothing and replays nothing.
      const beforeEmptyPump = restored.exportField();
      await restored.pump();
      assert.equal(calls.length, 0, 'an empty pump after restore called the executor');
      assert.deepEqual(
        restored.exportField(),
        beforeEmptyPump,
        'an empty pump at the saved clock changed the field',
      );
      assert.equal(
        log.entries.some((entry) => entry.event === 'node.failed'),
        false,
        'restore or an empty pump logged node.failed',
      );

      // 4. Answer a resumed hover (the only new input) and drain; the killed
      // active forager is never executed and a terminal never runs twice.
      const expectedDoneCalls = hoveredNodes.length > 0 ? 1 : 0;
      const hoverNodeId = hoveredNodes[0];
      if (hoverNodeId !== undefined) {
        const token = restored.snapshot().nodes[hoverNodeId]?.hover?.token;
        assert.ok(token !== undefined, `restored hover '${hoverNodeId}' lost its token`);
        restored.answerHover(hoverNodeId, text(`answer-${String(round.seed)}`), token);
      }
      for (let pumpIndex = 0; pumpIndex < 8 && !restored.snapshot().rest; pumpIndex += 1) {
        clock += 1000;
        await restored.pump();
      }
      assert.equal(restored.snapshot().rest, true, 'draining the restored field did not reach Rest');
      const execCalls = calls;

      assert.equal(
        execCalls.some((call) => call.nodeId === 'start' || call.nodeId === 'work'),
        false,
        'an already-completed forager was replayed',
      );
      assert.equal(
        execCalls.some((call) => call.nodeId === 'hold'),
        false,
        'the killed active forager was replayed',
      );
      const doneCalls = execCalls.filter((call) => call.nodeId === 'done');
      assert.equal(doneCalls.length, expectedDoneCalls, 'terminal done ran the wrong number of times');
      const executedKeys = execCalls.map(
        (call) => `${call.nodeId}:${serializeValue(call.input)}`,
      );
      assert.equal(new Set(executedKeys).size, executedKeys.length, 'a node executed the same input twice');
      const completedIds = log.entries
        .filter((entry) => entry.event === 'node.completed')
        .map((entry) => entry.pheromoneId);
      assert.equal(
        new Set(completedIds).size,
        completedIds.length,
        'a Pheromone completed twice',
      );
      assert.equal(
        log.entries.some((entry) => entry.event === 'node.failed'),
        false,
        'draining logged node.failed',
      );

      // Only the saved pending/queue values may execute, in FIFO order.
      const expectedPark: string[] = [];
      const parkNode = field.nodes['park'];
      if (parkNode?.pending !== undefined) {
        expectedPark.push(textOf(parkNode.pending));
      }
      for (const entry of parkNode?.queue ?? []) {
        expectedPark.push(textOf(entry));
      }
      const actualPark = execCalls
        .filter((call) => call.nodeId === 'park')
        .map((call) => serializeValue(call.input));
      assert.deepEqual(actualPark, expectedPark);

      // 5. The dead process's active side effect was not replayed.
      assert.deepEqual(readLines(join(tempRoot, 'active.marker')), observation.marker);
      assert.ok(observation.marker.length <= 1, 'the active executor ran more than once in the child');

      // 6. Coverage bookkeeping.
      if (activeForagers.length > 0) {
        coverage.active = true;
      }
      if (hoveredNodes.length > 0) {
        coverage.hover = true;
      }
      if (waitNodes.length > 0) {
        coverage.wait = true;
      }
      if (openJoin) {
        coverage.join = true;
      }
      if (killedPhase.endsWith(':begin')) {
        coverage.saveBefore = true;
      }
      if (killedPhase.endsWith(':end')) {
        coverage.saveAfter = true;
      }
      t.diagnostic(
        `burst round ${String(roundIndex)} seed=${String(round.seed)} killedAt=${killedPhase} ` +
          `active=${activeForagers.join(',') || '-'} hover=${hoveredNodes.join(',') || '-'} ` +
          `pending/queue=${waitNodes.join(',') || '-'} openJoin=${String(openJoin)} ` +
          `marker=${String(observation.marker.length)} report=${JSON.stringify(report)}`,
      );
    }

    t.diagnostic(
      `burst coverage: rounds=${String(BURST_ROUNDS.length)} ` +
        `phases=${killedPhases.join(',')} ${JSON.stringify(coverage)}`,
    );
    assert.deepEqual(
      coverage,
      { active: true, hover: true, wait: true, join: true, saveBefore: true, saveAfter: true },
      'the burst rounds did not cover every required mid-flight state',
    );
    assert.ok(
      BURST_ROUNDS.length >= 10 && BURST_ROUNDS.length <= 20,
      `burst round count ${String(BURST_ROUNDS.length)} is outside 10..20`,
    );
  },
);
