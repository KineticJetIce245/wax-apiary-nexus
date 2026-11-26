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
  type CompositionDefinition,
  type NodeExecutor,
  type Value,
  type WorkerConfig,
} from '../src/runtime/index.js';

const START = Date.parse('2026-05-01T00:00:00.000Z');

function text(value: string): Value {
  return { message: value };
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
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'start {{message}}' } },
      work: { kind: 'worker', config },
      after: { kind: 'forager', config: { connection: 'codex', prompt: 'after {{message}}' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'work' },
      { id: 'e2', from: 'work', to: 'after' },
    ],
  });
}

/** start -> spread sharing the input with a user hover and a failing worker. */
function spreadWorkerFailureComposition(config: WorkerConfig): CompositionDefinition {
  return parseComposition({
    schemaVersion: 1,
    id: 'spread-worker-failure',
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'start' } },
      spread: {
        kind: 'spread',
        config: { strategy: 'clone', targets: ['ask', 'fail'] },
      },
      ask: { kind: 'user', config: { modality: 'text', prompt: 'B?' } },
      fail: { kind: 'worker', config },
    },
    edges: [{ id: 'e1', from: 'start', to: 'spread' }],
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

  runtime.admit('start', text('seed'));
  await runtime.settle();

  const after = calls.find((call) => call.nodeId === 'after');
  assert.ok(after !== undefined);
  assert.deepEqual(after.input, { message: 'worker output' });
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

test('worker stdout is trimmed at the end and becomes the field-owned lastOutput', async () => {
  const { executor, calls } = recorder();
  const project = projectDir();
  const runtime = new PheromoneRuntime(
    workerChain(nodeConfig('process.stdout.write("worker output\\n\\n")')),
    {
      executeForager: executor,
      projectDirectory: project,
      now: () => START,
    },
  );

  await runtime.admit('start', text('seed'));
  await runtime.settle();

  const after = calls.find((call) => call.nodeId === 'after');
  assert.ok(after !== undefined);
  assert.deepEqual(after.input, { message: 'worker output' });
  assert.deepEqual(runtime.snapshot().nodes['work']?.lastOutput, {
    message: 'worker output',
  });
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

  await runtime.admit('a', { message: '' });
  await runtime.admit('b', { message: '' });
  await runtime.settle();

  const waiting = runtime.snapshot();
  assert.equal(waiting.rest, false);
  assert.equal(waiting.nodes['work']?.active, undefined);
  assert.ok(waiting.nodes['work']?.pending !== undefined, 'second worker waits for minInterval');
  assert.ok(log.entries.some((entry) => entry.event === 'pheromone.pending'));

  clock += 1000;
  await runtime.settle();

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

  await runtime.admit('start', { message: '' });
  await runtime.settle();

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

  await runtime.admit('start', { message: '' });
  await runtime.settle();

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

  await runtime.admit('start', { message: '' });
  await runtime.settle();

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
  assert.match(failed.error ?? '', /exited with code 3/);
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

  await runtime.admit('start', { message: '' });
  await runtime.settle();

  const pids = JSON.parse(readFileSync(join(project, 'pids.json'), 'utf8')) as {
    parent: number;
    child: number;
  };
  const failed = log.entries.find(
    (entry) => entry.event === 'node.failed' && entry.nodeId === 'work',
  );
  assert.ok(failed !== undefined);
  assert.match(failed.error ?? '', /timed out after 3000 ms/);
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

  await runtime.admit('start', { message: '' });
  await runtime.settle();

  const failed = log.entries.find(
    (entry) => entry.event === 'node.failed' && entry.nodeId === 'work',
  );
  assert.ok(failed !== undefined);
  assert.match(failed.error ?? '', /stdout cap/);
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

  await runtime.admit('start', { message: '' });
  await runtime.settle();

  const failed = log.entries.find(
    (entry) => entry.event === 'node.failed' && entry.nodeId === 'work',
  );
  assert.ok(failed !== undefined);
  assert.match(failed.error ?? '', /stderr cap/);
  assert.ok((failed.stderrBytes ?? 0) > MAX_WORKER_OUTPUT_BYTES);
  assert.equal(JSON.stringify(log.entries).includes('STDERR-BODY-MARKER'), false);
});

test('rejects an absolute worker cwd outside the project before spawning', async () => {
  const log = createMemoryLog();
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
      onLog: log.sink,
    },
  );

  await runtime.admit('start', { message: '' });
  await runtime.settle();
  const failed = log.entries.find(
    (entry) => entry.event === 'node.failed' && entry.nodeId === 'work',
  );
  assert.ok(failed !== undefined);
  assert.match(failed.error ?? '', /outside the project directory/);
  assert.equal(existsSync(join(outside, 'probe.txt')), false);
});

test('rejects a worker cwd that escapes through a symlink', async (context) => {
  const log = createMemoryLog();
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
      onLog: log.sink,
    },
  );

  await runtime.admit('start', { message: '' });
  await runtime.settle();
  const failed = log.entries.find(
    (entry) => entry.event === 'node.failed' && entry.nodeId === 'work',
  );
  assert.ok(failed !== undefined);
  assert.match(failed.error ?? '', /symlink/);
  assert.equal(existsSync(join(outside, 'probe.txt')), false);
});

test('a worker without a registered project directory fails before spawning', async () => {
  const log = createMemoryLog();
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
      onLog: log.sink,
    },
  );

  await runtime.admit('start', { message: '' });
  await runtime.settle();
  const failed = log.entries.find(
    (entry) => entry.event === 'node.failed' && entry.nodeId === 'work',
  );
  assert.ok(failed !== undefined);
  assert.match(failed.error ?? '', /is a worker but no project directory is registered/);
  assert.equal(existsSync(marker), false);
});

test('a worker failure on one spread branch leaves the sibling hover open', async () => {
  const log = createMemoryLog();
  const { executor, calls } = recorder();
  const project = projectDir();
  const runtime = new PheromoneRuntime(
    spreadWorkerFailureComposition(nodeConfig('process.exit(1)')),
    {
      executeForager: executor,
      projectDirectory: project,
      now: () => START,
      onLog: log.sink,
    },
  );

  await runtime.admit('start', { message: '' });
  await runtime.settle();

  const failed = log.entries.find(
    (entry) => entry.event === 'node.failed' && entry.nodeId === 'fail',
  );
  assert.ok(failed !== undefined);
  assert.match(failed.error ?? '', /exited with code 1/);
  // The failure belongs to the failing activation only: the sibling user hover
  // is still open and no spread-level cleanup cancelled it.
  const snapshot = runtime.snapshot();
  assert.equal(snapshot.nodes['fail']?.active, undefined);
  assert.equal(snapshot.nodes['fail']?.lastOutput, undefined);
  assert.ok(snapshot.nodes['ask']?.hover !== undefined, 'the sibling hover survives');
  assert.ok(snapshot.nodes['ask']?.hoverPheromone !== undefined);
  assert.equal(snapshot.rest, false, 'the open hover keeps the field non-Rest');
  assert.deepEqual(calls.map((call) => call.nodeId), ['start']);
  assert.equal(log.entries.some((entry) => entry.event === 'hover.cancelled'), false);
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

  await runtime.admit('start', { message: '' });
  await runtime.settle();

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

test('worker is a trigger target in Stage 3C', async () => {
  const { executor } = recorder();
  const runtime = new PheromoneRuntime(workerChain(nodeConfig('process.exit(0)')), {
    executeForager: executor,
    projectDirectory: projectDir(),
    now: () => START,
  });

  await runtime.admit('work', { message: '' });

  assert.equal(runtime.snapshot().nodes['work']?.receptor.length, 1);

  await runtime.settle();
  assert.equal(runtime.snapshot().nodes['work']?.receptor.length, 0);
  assert.equal(runtime.snapshot().rest, true);
});

test('a restored active worker waits for its result and is never replayed', () => {
  const definition = workerChain(nodeConfig('process.exit(0)'));
  const project = projectDir();
  const field = new PheromoneRuntime(definition, {
    executeForager: recorder().executor,
    projectDirectory: project,
    now: () => START,
  }).exportField();
  field.nodes['work'] = {
    receptor: [],
    active: {
      value: text('x'),
    },
  };

  const { runtime, report } = PheromoneRuntime.restore(definition, field, {
    executeForager: recorder().executor,
    projectDirectory: project,
    now: () => START,
  });

  assert.deepEqual(report.resumedHovers, []);
  // The same activation is restored as active; it waits for its own result and
  // is not marked unknown/stuck and not replayed.
  assert.equal(runtime.snapshot().nodes['work']?.active !== undefined, true);
  assert.equal(runtime.snapshot().nodes['work']?.state['needsAttention'], undefined);
});
