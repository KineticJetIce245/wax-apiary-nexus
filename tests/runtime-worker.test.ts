import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createMemoryLog,
  MAX_WORKER_OUTPUT_BYTES,
  parseComposition,
  PheromoneRuntime,
  serializeValue,
  WorkerExecutionError,
  type CompositionDefinition,
  type NodeExecutor,
  type Value,
  type WorkerConfig,
} from '../src/runtime/index.js';

const START = Date.parse('2026-05-01T00:00:00.000Z');

function text(value: string): Value {
  return { kind: 'text', text: value };
}

function projectDir(): string {
  return realpathSync.native(mkdtempSync(join(tmpdir(), 'wax-worker-')));
}

function nodeConfig(source: string, overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    command: process.execPath,
    args: ['-e', source],
    cwd: '.',
    timeoutMs: 60_000,
    ...overrides,
  };
}

interface Recorder {
  readonly executor: NodeExecutor;
  readonly calls: { nodeId: string; input: Value }[];
}

function recorder(): Recorder {
  const calls: { nodeId: string; input: Value }[] = [];
  const executor: NodeExecutor = {
    async execute(node, input) {
      calls.push({ nodeId: node.id, input });
      return input;
    },
  };
  return { executor, calls };
}

/** start -> work -> after; the worker's stdout is the Value `after` sees. */
function workerChain(config: WorkerConfig): CompositionDefinition {
  return parseComposition({
    schemaVersion: 1,
    id: 'worker-chain',
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'start {{input}}' } },
      work: { kind: 'worker', config },
      after: { kind: 'forager', config: { connection: 'codex', prompt: 'after {{input}}' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'work' },
      { id: 'e2', from: 'work', to: 'after' },
    ],
  });
}

/** start -> check; check -> yes on exit 0, no otherwise. */
function conditionWorkerComposition(config: Record<string, unknown>): CompositionDefinition {
  return parseComposition({
    schemaVersion: 1,
    id: 'condition-worker',
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'start' } },
      check: { kind: 'condition', config: { mode: 'worker', ...config } },
      yes: { kind: 'forager', config: { connection: 'codex', prompt: 'yes' } },
      no: { kind: 'forager', config: { connection: 'codex', prompt: 'no' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'check' },
      { id: 'e2', from: 'check', to: 'yes', when: 'true' },
      { id: 'e3', from: 'check', to: 'no', when: 'false' },
    ],
  });
}

/** start -> fork (a -> merge, b -> ask, c -> failing worker); merge requires a,c. */
function forkWorkerFailureComposition(config: WorkerConfig): CompositionDefinition {
  return parseComposition({
    schemaVersion: 1,
    id: 'fork-worker-failure',
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'start' } },
      fork: {
        kind: 'fork',
        config: {
          branches: [
            { id: 'a', to: 'merge' },
            { id: 'b', to: 'ask' },
            { id: 'c', to: 'fail' },
          ],
        },
      },
      ask: { kind: 'user', config: { modality: 'text', prompt: 'B?' } },
      merge: { kind: 'merge', config: { required: ['a', 'c'], combine: 'text' } },
      fail: { kind: 'worker', config },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'fork' },
      { id: 'e2', from: 'ask', to: 'merge' },
      { id: 'e3', from: 'fail', to: 'merge' },
      { id: 'e4', from: 'merge', to: 'done' },
    ],
  });
}

async function waitForGone(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        return true;
      }
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
}

test('worker argv runs and stdout becomes the Value', async () => {
  const log = createMemoryLog();
  const { executor, calls } = recorder();
  const project = projectDir();
  const runtime = new PheromoneRuntime(
    workerChain(nodeConfig('process.stdout.write("worker output")')),
    {
      executeForager: executor,
      projectDirectory: project,
      now: () => START,
      onLog: log.sink,
    },
  );

  runtime.trigger('start', text('seed'));
  await runtime.pump();

  const after = calls.find((call) => call.nodeId === 'after');
  assert.ok(after !== undefined);
  assert.deepEqual(after.input, { kind: 'text', text: 'worker output' });
  assert.equal(runtime.snapshot().rest, true);

  const completed = log.entries.find(
    (entry) => entry.event === 'node.completed' && entry.nodeId === 'work',
  );
  assert.ok(completed !== undefined);
  assert.equal(completed.nodeKind, 'worker');
  assert.equal(completed.outcome, 'ok');
  assert.equal(completed.program, process.execPath);
  assert.equal(typeof completed.pid, 'number');
  assert.equal(completed.stdoutBytes, Buffer.byteLength('worker output'));
  assert.equal(completed.stderrBytes, 0);
  assert.equal(completed.exitCode, 0);
  assert.equal('stdout' in completed, false, 'the log carries counts, not the body');
});

test('two worker activations stay queued and never overlap', async () => {
  let clock = START;
  const log = createMemoryLog();
  const { executor } = recorder();
  const project = projectDir();
  const script = [
    "const fs = require('node:fs');",
    "fs.appendFileSync('events.log', 'start\\n');",
    "setTimeout(() => { fs.appendFileSync('events.log', 'end\\n'); }, 100);",
  ].join('\n');
  const definition = parseComposition({
    schemaVersion: 1,
    id: 'worker-queue',
    nodes: {
      a: { kind: 'forager', config: { connection: 'codex', prompt: 'a' } },
      b: { kind: 'forager', config: { connection: 'codex', prompt: 'b' } },
      work: {
        kind: 'worker',
        config: { command: process.execPath, args: ['-e', script], cwd: '.', timeoutMs: 60_000 },
      },
    },
    edges: [
      { id: 'e1', from: 'a', to: 'work' },
      { id: 'e2', from: 'b', to: 'work' },
    ],
  });
  const runtime = new PheromoneRuntime(definition, {
    executeForager: executor,
    projectDirectory: project,
    now: () => clock,
    onLog: log.sink,
  });

  runtime.trigger('a');
  runtime.trigger('b');
  await runtime.pump();

  const waiting = runtime.snapshot();
  assert.equal(waiting.rest, false);
  assert.equal(waiting.nodes['work']?.active, undefined);
  assert.ok(waiting.nodes['work']?.pending !== undefined, 'second worker waits for minInterval');
  assert.ok(log.entries.some((entry) => entry.event === 'pheromone.pending'));

  clock += 1000;
  await runtime.pump();

  const events = readFileSync(join(project, 'events.log'), 'utf8').trim().split('\n');
  assert.deepEqual(events, ['start', 'end', 'start', 'end']);
  assert.equal(runtime.snapshot().rest, true);
});

test('worker cwd defaults to the registered project directory', async () => {
  const { executor, calls } = recorder();
  const project = projectDir();
  const runtime = new PheromoneRuntime(
    workerChain(nodeConfig('process.stdout.write(process.cwd())')),
    {
      executeForager: executor,
      projectDirectory: project,
      now: () => START,
    },
  );

  runtime.trigger('start');
  await runtime.pump();

  const after = calls.find((call) => call.nodeId === 'after');
  assert.ok(after !== undefined);
  assert.equal(serializeValue(after.input), project);
});

test('shell metacharacters in argv are passed literally and not interpreted', async () => {
  const { executor, calls } = recorder();
  const project = projectDir();
  const literalArgs = [
    'a; echo injected',
    '$(touch injected.txt)',
    '& echo injected',
    'two words',
    '> marker.txt',
  ];
  const runtime = new PheromoneRuntime(
    workerChain({
      command: process.execPath,
      args: [
        '-e',
        'process.stdout.write(JSON.stringify(process.argv.slice(1)))',
        ...literalArgs,
      ],
      cwd: '.',
      timeoutMs: 60_000,
    }),
    {
      executeForager: executor,
      projectDirectory: project,
      now: () => START,
    },
  );

  runtime.trigger('start');
  await runtime.pump();

  const after = calls.find((call) => call.nodeId === 'after');
  assert.ok(after !== undefined);
  assert.deepEqual(JSON.parse(serializeValue(after.input)) as unknown, literalArgs);
  assert.deepEqual(readdirSync(project), [], 'no shell redirect or substitution side effect');
  assert.equal(existsSync(join(project, 'marker.txt')), false);
});

test('a non-zero worker exit is one failed activation and is never retried', async () => {
  const log = createMemoryLog();
  const { executor, calls } = recorder();
  const project = projectDir();
  const runtime = new PheromoneRuntime(
    workerChain(
      nodeConfig('process.stderr.write("stderr-body-marker"); process.exit(3)'),
    ),
    {
      executeForager: executor,
      projectDirectory: project,
      now: () => START,
      onLog: log.sink,
    },
  );

  runtime.trigger('start');
  await assert.rejects(runtime.pump(), (error: unknown) => {
    assert.ok(error instanceof WorkerExecutionError);
    assert.equal(error.code, 'exit');
    assert.equal(error.exitCode, 3);
    assert.match(error.stderr, /stderr-body-marker/);
    return true;
  });

  assert.equal(calls.some((call) => call.nodeId === 'after'), false);
  assert.equal(
    log.entries.filter((entry) => entry.event === 'node.activated' && entry.nodeId === 'work')
      .length,
    1,
    'the failed worker is not retried',
  );
  const failed = log.entries.find(
    (entry) => entry.event === 'node.failed' && entry.nodeId === 'work',
  );
  assert.ok(failed !== undefined);
  assert.equal(failed.outcome, 'failed');
  assert.equal(failed.exitCode, 3);
  assert.equal(failed.stderrBytes, Buffer.byteLength('stderr-body-marker'));
  assert.equal(
    JSON.stringify(log.entries).includes('stderr-body-marker'),
    false,
    'stderr is error metadata, not a log body',
  );
  assert.equal(runtime.snapshot().nodes['work']?.active, undefined);
  assert.equal(runtime.snapshot().rest, true);
});

test('timeout kills the worker process tree', async () => {
  const log = createMemoryLog();
  const { executor } = recorder();
  const project = projectDir();
  const script = [
    "import { spawn } from 'node:child_process';",
    "import { writeFileSync } from 'node:fs';",
    "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    "writeFileSync('pids.json', JSON.stringify({ parent: process.pid, child: grandchild.pid }));",
    "setInterval(() => {}, 1000);",
  ].join('\n');
  writeFileSync(join(project, 'tree.mjs'), script, 'utf8');

  const runtime = new PheromoneRuntime(
    workerChain({
      command: process.execPath,
      args: ['tree.mjs'],
      cwd: '.',
      timeoutMs: 3_000,
    }),
    {
      executeForager: executor,
      projectDirectory: project,
      now: () => START,
      onLog: log.sink,
    },
  );

  runtime.trigger('start');
  await assert.rejects(runtime.pump(), (error: unknown) => {
    assert.ok(error instanceof WorkerExecutionError);
    assert.equal(error.code, 'timeout');
    assert.match(error.message, /timed out after 3000 ms/);
    return true;
  });

  const pids = JSON.parse(readFileSync(join(project, 'pids.json'), 'utf8')) as {
    parent: number;
    child: number;
  };
  const failed = log.entries.find(
    (entry) => entry.event === 'node.failed' && entry.nodeId === 'work',
  );
  assert.ok(failed !== undefined);
  assert.equal(failed.pid, pids.parent);
  assert.equal(await waitForGone(pids.parent), true, 'worker process was killed');
  assert.equal(await waitForGone(pids.child), true, 'worker grandchild was killed');
});

test('stdout over the 64 KiB cap fails and is not buffered', async () => {
  const log = createMemoryLog();
  const { executor } = recorder();
  const project = projectDir();
  const runtime = new PheromoneRuntime(
    workerChain(nodeConfig('process.stdout.write("STDOUT-BODY-MARKER" + "x".repeat(70000))')),
    {
      executeForager: executor,
      projectDirectory: project,
      now: () => START,
      onLog: log.sink,
    },
  );

  runtime.trigger('start');
  await assert.rejects(runtime.pump(), (error: unknown) => {
    assert.ok(error instanceof WorkerExecutionError);
    assert.equal(error.code, 'output-cap');
    assert.match(error.message, /stdout cap/);
    assert.ok(error.stdoutBytes > MAX_WORKER_OUTPUT_BYTES);
    return true;
  });

  const failed = log.entries.find(
    (entry) => entry.event === 'node.failed' && entry.nodeId === 'work',
  );
  assert.ok(failed !== undefined);
  assert.ok((failed.stdoutBytes ?? 0) > MAX_WORKER_OUTPUT_BYTES);
  assert.equal(JSON.stringify(log.entries).includes('STDOUT-BODY-MARKER'), false);
});

test('stderr over the 64 KiB cap fails and is not buffered', async () => {
  const log = createMemoryLog();
  const { executor } = recorder();
  const project = projectDir();
  const runtime = new PheromoneRuntime(
    workerChain(nodeConfig('process.stderr.write("STDERR-BODY-MARKER" + "y".repeat(70000))')),
    {
      executeForager: executor,
      projectDirectory: project,
      now: () => START,
      onLog: log.sink,
    },
  );

  runtime.trigger('start');
  await assert.rejects(runtime.pump(), (error: unknown) => {
    assert.ok(error instanceof WorkerExecutionError);
    assert.equal(error.code, 'output-cap');
    assert.match(error.message, /stderr cap/);
    assert.ok(error.stderrBytes > MAX_WORKER_OUTPUT_BYTES);
    return true;
  });

  const failed = log.entries.find(
    (entry) => entry.event === 'node.failed' && entry.nodeId === 'work',
  );
  assert.ok(failed !== undefined);
  assert.ok((failed.stderrBytes ?? 0) > MAX_WORKER_OUTPUT_BYTES);
  assert.equal(JSON.stringify(log.entries).includes('STDERR-BODY-MARKER'), false);
});

test('rejects an absolute worker cwd outside the project before spawning', async () => {
  const { executor } = recorder();
  const project = projectDir();
  const outside = projectDir();
  const runtime = new PheromoneRuntime(
    workerChain(
      nodeConfig("require('node:fs').writeFileSync('probe.txt', 'x')", { cwd: outside }),
    ),
    {
      executeForager: executor,
      projectDirectory: project,
      now: () => START,
    },
  );

  runtime.trigger('start');
  await assert.rejects(runtime.pump(), (error: unknown) => {
    assert.ok(error instanceof WorkerExecutionError);
    assert.equal(error.code, 'cwd');
    assert.match(error.message, /outside the project directory/);
    return true;
  });
  assert.equal(existsSync(join(outside, 'probe.txt')), false);
});

test('rejects a worker cwd that escapes through a symlink', async (context) => {
  const { executor } = recorder();
  const project = projectDir();
  const outside = projectDir();
  const link = join(project, 'link');
  try {
    symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    context.skip('directory symlinks/junctions are unavailable on this host');
    return;
  }

  const runtime = new PheromoneRuntime(
    workerChain(
      nodeConfig("require('node:fs').writeFileSync('probe.txt', 'x')", { cwd: 'link' }),
    ),
    {
      executeForager: executor,
      projectDirectory: project,
      now: () => START,
    },
  );

  runtime.trigger('start');
  await assert.rejects(runtime.pump(), (error: unknown) => {
    assert.ok(error instanceof WorkerExecutionError);
    assert.equal(error.code, 'cwd');
    assert.match(error.message, /symlink/);
    return true;
  });
  assert.equal(existsSync(join(outside, 'probe.txt')), false);
});

test('a worker without a registered project directory fails before spawning', async () => {
  const { executor } = recorder();
  const marker = join(projectDir(), 'spawned.txt');
  const runtime = new PheromoneRuntime(
    workerChain({
      command: process.execPath,
      args: ['-e', "require('node:fs').writeFileSync(process.argv[1], 'x')", marker],
      cwd: '.',
      timeoutMs: 60_000,
    }),
    {
      executeForager: executor,
      now: () => START,
    },
  );

  runtime.trigger('start');
  await assert.rejects(
    runtime.pump(),
    /is a worker but no project directory is registered/,
  );
  assert.equal(existsSync(marker), false);
});

test('condition worker branches true on exit 0 and false on non-zero without failing', async () => {
  const project = projectDir();
  const log = createMemoryLog();

  const trueRecorder = recorder();
  const trueRuntime = new PheromoneRuntime(
    conditionWorkerComposition({
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
    }),
    {
      executeForager: trueRecorder.executor,
      projectDirectory: project,
      now: () => START,
      onLog: log.sink,
    },
  );
  trueRuntime.trigger('start');
  await trueRuntime.pump();
  assert.deepEqual(
    trueRecorder.calls.map((call) => call.nodeId),
    ['start', 'yes'],
  );

  const falseRecorder = recorder();
  const falseRuntime = new PheromoneRuntime(
    conditionWorkerComposition({
      command: process.execPath,
      args: ['-e', 'process.exit(1)'],
    }),
    {
      executeForager: falseRecorder.executor,
      projectDirectory: project,
      now: () => START,
      onLog: log.sink,
    },
  );
  falseRuntime.trigger('start');
  await falseRuntime.pump();
  assert.deepEqual(
    falseRecorder.calls.map((call) => call.nodeId),
    ['start', 'no'],
  );

  const completed = log.entries.filter(
    (entry) => entry.event === 'node.completed' && entry.nodeId === 'check',
  );
  assert.deepEqual(
    completed.map((entry) => [entry.outcome, entry.exitCode]),
    [
      ['true', 0],
      ['false', 1],
    ],
  );
  assert.equal(
    log.entries.some((entry) => entry.event === 'node.failed'),
    false,
    'a non-zero Condition worker is a false branch, not a runtime error',
  );
});

test('a Condition worker timeout is a runtime failure, not a false branch', async () => {
  const project = projectDir();
  const { executor, calls } = recorder();
  const runtime = new PheromoneRuntime(
    conditionWorkerComposition({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      timeoutMs: 200,
    }),
    {
      executeForager: executor,
      projectDirectory: project,
      now: () => START,
    },
  );

  runtime.trigger('start');
  await assert.rejects(runtime.pump(), (error: unknown) => {
    assert.ok(error instanceof WorkerExecutionError);
    assert.equal(error.code, 'timeout');
    return true;
  });
  assert.deepEqual(calls.map((call) => call.nodeId), ['start']);
});

test('a worker failure on a fork branch cancels siblings through fork semantics', async () => {
  const log = createMemoryLog();
  const { executor, calls } = recorder();
  const project = projectDir();
  const runtime = new PheromoneRuntime(
    forkWorkerFailureComposition(nodeConfig('process.exit(1)')),
    {
      executeForager: executor,
      projectDirectory: project,
      now: () => START,
      onLog: log.sink,
    },
  );

  runtime.trigger('start');
  await assert.rejects(runtime.pump(), /exited with code 1/);

  const snapshot = runtime.snapshot();
  assert.equal(snapshot.nodes['ask']?.hover, undefined);
  assert.equal(snapshot.nodes['ask']?.queue.length, 0);
  assert.equal(snapshot.nodes['merge']?.joins, undefined);
  assert.equal(snapshot.rest, true);
  assert.deepEqual(calls.map((call) => call.nodeId), ['start']);
  assert.ok(log.entries.some((entry) => entry.event === 'hover.cancelled'));
  const failed = log.entries.find((entry) => entry.event === 'merge.failed');
  assert.ok(failed !== undefined);
  assert.equal(failed.outcome, 'failed-branch');
});

test('worker logs carry metadata but not stdout or stderr bodies', async () => {
  const log = createMemoryLog();
  const { executor, calls } = recorder();
  const project = projectDir();
  const stdoutMarker = 'STDOUT_ONLY_MARKER';
  const stderrMarker = 'STDERR_ONLY_MARKER';
  const runtime = new PheromoneRuntime(
    workerChain(
      nodeConfig(
        `process.stdout.write(${JSON.stringify(stdoutMarker)}); ` +
          `process.stderr.write(${JSON.stringify(stderrMarker)})`,
      ),
    ),
    {
      executeForager: executor,
      projectDirectory: project,
      now: () => START,
      onLog: log.sink,
    },
  );

  runtime.trigger('start');
  await runtime.pump();

  const after = calls.find((call) => call.nodeId === 'after');
  assert.ok(after !== undefined);
  assert.equal(serializeValue(after.input), stdoutMarker, 'stderr is not part of the Value');

  const completed = log.entries.find(
    (entry) => entry.event === 'node.completed' && entry.nodeId === 'work',
  );
  assert.ok(completed !== undefined);
  assert.equal(completed.stdoutBytes, Buffer.byteLength(stdoutMarker));
  assert.equal(completed.stderrBytes, Buffer.byteLength(stderrMarker));
  assert.equal(typeof completed.program, 'string');

  const serialized = JSON.stringify(log.entries);
  assert.equal(serialized.includes(stdoutMarker), false);
  assert.equal(serialized.includes(stderrMarker), false);
});

test('worker is not a trigger target in Stage 3B', () => {
  const { executor } = recorder();
  const runtime = new PheromoneRuntime(workerChain(nodeConfig('process.exit(0)')), {
    executeForager: executor,
    projectDirectory: projectDir(),
    now: () => START,
  });

  assert.throws(
    () => runtime.trigger('work'),
    /must be a forager or user node/,
    'worker triggers are deferred to a later stage',
  );
});

test('an active worker on restore is stuck and never replayed', () => {
  const definition = workerChain(nodeConfig('process.exit(0)'));
  const project = projectDir();
  const field = new PheromoneRuntime(definition, {
    executeForager: recorder().executor,
    projectDirectory: project,
    now: () => START,
  }).exportField();
  field.nodes['work'] = {
    queue: [],
    active: {
      id: 'ph_active_worker',
      traceId: 'tr_active_worker',
      value: text('x'),
      at: new Date(START).toISOString(),
    },
  };

  const { runtime, report } = PheromoneRuntime.restore(definition, field, {
    executeForager: recorder().executor,
    projectDirectory: project,
    now: () => START,
  });

  assert.deepEqual(report.stuckActive, ['work']);
  assert.deepEqual(report.unknownActive, []);
  assert.equal(runtime.snapshot().nodes['work']?.state['needsAttention'], true);
  assert.equal(runtime.snapshot().nodes['work']?.active, undefined);
});
