import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runCli } from '../src/cli.js';
import { apiaryForProject, type AdapterRequest } from '../src/cli-shared.js';
import { parseDaemonArgs, runDaemon } from '../src/daemon.js';
import { HoneyStore, honeyPaths } from '../src/honey.js';
import { parseComposition, PheromoneRuntime } from '../src/runtime/index.js';
import { FakeAdapter } from './support/fake-adapter.js';

interface Capture {
  readonly stdout: string[];
  readonly stderr: string[];
  readonly deps: {
    stdout: (line: string) => void;
    stderr: (line: string) => void;
  };
}

function capture(): Capture {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    deps: {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
  };
}

function tempDirectory(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function compositionFile(contents: unknown): string {
  const path = join(tempDirectory('wax-daemon-composition-'), 'composition.json');
  writeFileSync(path, JSON.stringify(contents));
  return path;
}

function baseArgs(compositionPath: string, project: string, state: string): string[] {
  return ['daemon', compositionPath, '--project', project, '--harness', 'codex', '--state-dir', state];
}

function scheduledComposition(options: {
  id: string;
  targetKind: 'forager' | 'worker';
  target?: string;
  atMs?: number;
  config?: Record<string, unknown>;
}): Record<string, unknown> {
  const target = options.target ?? 'node';
  const config =
    options.config ??
    (options.targetKind === 'forager'
      ? { connection: 'codex', prompt: 'scheduled {{input}}' }
      : { command: process.execPath, args: ['-e', 'process.stdout.write("WORKER")'] });
  return {
    schemaVersion: 1,
    id: options.id,
    nodes: { [target]: { kind: options.targetKind, config } },
    edges: [],
    triggers: [
      {
        id: 'once',
        target,
        schedule: { kind: 'at', at: new Date(options.atMs ?? Date.now() - 60_000).toISOString() },
      },
    ],
  };
}

function logEntries(path: string): Record<string, unknown>[] {
  try {
    return readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

function hasLogEvent(path: string, event: string, nodeId?: string): boolean {
  return logEntries(path).some(
    (entry) => entry['event'] === event && (nodeId === undefined || entry['nodeId'] === nodeId),
  );
}

async function waitFor(
  condition: () => boolean,
  label: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (condition()) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('parses the daemon command with its default state directory', () => {
  const command = parseDaemonArgs([
    'daemon',
    'composition.json',
    '--project',
    'C:/work',
    '--harness',
    'codex',
    '--apiary',
    'demo',
    '--codex-exe',
    'C:/tools/codex.exe',
  ]);

  assert.equal(command.compositionPath, 'composition.json');
  assert.equal(command.projectDirectory, 'C:/work');
  assert.equal(command.harness, 'codex');
  assert.equal(command.apiary, 'demo');
  assert.equal(command.codexExe, 'C:/tools/codex.exe');
  assert.equal(command.stateDir, '~/.wax');
});

test('parses the opt-in --composition-tools flag', () => {
  const off = parseDaemonArgs([
    'daemon',
    'c.json',
    '--project',
    'p',
    '--harness',
    'codex',
  ]);
  assert.equal(off.compositionTools, false);

  const on = parseDaemonArgs([
    'daemon',
    'c.json',
    '--project',
    'p',
    '--harness',
    'codex',
    '--composition-tools',
  ]);
  assert.equal(on.compositionTools, true);

  assert.throws(
    () =>
      parseDaemonArgs([
        'daemon',
        'c.json',
        '--project',
        'p',
        '--harness',
        'codex',
        '--composition-tools',
        '--composition-tools',
      ]),
    /more than once/,
  );
});

test('parses a dsh daemon from the flag or DSH_ROOT', () => {
  const fromFlag = parseDaemonArgs(
    [
      'daemon',
      'composition.json',
      '--project',
      'C:/work',
      '--harness',
      'dsh',
      '--dsh-root',
      'C:/deepseek-harness',
      '--state-dir',
      'C:/state',
    ],
    {},
  );
  assert.equal(fromFlag.harness, 'dsh');
  assert.equal(fromFlag.dshRoot, 'C:/deepseek-harness');

  const fromEnv = parseDaemonArgs(
    ['daemon', 'composition.json', '--project', 'C:/work', '--harness', 'dsh'],
    { DSH_ROOT: 'C:/env-dsh' },
  );
  assert.equal(fromEnv.harness, 'dsh');
  assert.equal(fromEnv.dshRoot, 'C:/env-dsh');
});

test('rejects missing, duplicated and unknown daemon options', () => {
  assert.throws(() => parseDaemonArgs(['daemon', 'c.json', '--harness', 'codex']), /--project/);
  assert.throws(() => parseDaemonArgs(['daemon', 'c.json', '--project', 'p']), /--harness/);
  assert.throws(
    () => parseDaemonArgs(['daemon', 'c.json', '--project', 'p', '--harness', 'dsh'], {}),
    /requires --dsh-root/,
  );
  assert.throws(
    () =>
      parseDaemonArgs(
        [
          'daemon',
          'c.json',
          '--project',
          'p',
          '--harness',
          'dsh',
          '--dsh-root',
          'C:/dsh',
          '--codex-exe',
          'C:/tools/codex.exe',
        ],
        {},
      ),
    /--codex-exe only applies to --harness codex/,
  );
  assert.throws(
    () =>
      parseDaemonArgs(
        ['daemon', 'c.json', '--project', 'p', '--harness', 'codex', '--dsh-root', 'C:/dsh'],
        {},
      ),
    /--dsh-root only applies to --harness dsh/,
  );
  assert.throws(
    () => parseDaemonArgs(['daemon', 'c.json', '--project', 'p', '--harness', 'codex', '--trigger', 'x']),
    /unknown option '--trigger'/,
  );
  assert.throws(
    () =>
      parseDaemonArgs([
        'daemon',
        'c.json',
        '--project',
        'p',
        '--project',
        'q',
        '--harness',
        'codex',
      ]),
    /more than once/,
  );
});

test('a composition without scheduled triggers is a usage error', async () => {
  const captureResult = capture();
  const code = await runDaemon(
    baseArgs(
      compositionFile({
        schemaVersion: 1,
        id: 'no-triggers',
        nodes: { plan: { kind: 'forager', config: { connection: 'codex', prompt: 'p' } } },
        edges: [],
      }),
      tempDirectory('wax-daemon-project-'),
      tempDirectory('wax-daemon-state-'),
    ),
    captureResult.deps,
  );

  assert.equal(code, 2);
  assert.match(captureResult.stderr.join('\n'), /no scheduled triggers/);
});

test('a past at trigger runs a forager through the fake adapter', async () => {
  const adapter = new FakeAdapter({ output: 'DAEMON-FORAGER-OUT' });
  const captureResult = capture();
  const controller = new AbortController();
  const project = tempDirectory('wax-daemon-project-');
  const state = tempDirectory('wax-daemon-state-');
  const compositionPath = compositionFile(
    scheduledComposition({ id: 'daemon-forager', targetKind: 'forager' }),
  );
  const paths = honeyPaths(state, apiaryForProject(project), 'daemon-forager');
  const lockPath = join(paths.directory, 'daemon.lock');

  const running = runDaemon(baseArgs(compositionPath, project, state), {
    ...captureResult.deps,
    createAdapter: async () => adapter,
    signal: controller.signal,
  });

  let code = -1;
  try {
    await waitFor(() => adapter.prompts.length === 1, 'the scheduled forager prompt');
    await waitFor(
      () => hasLogEvent(paths.log, 'node.completed', 'node'),
      'the completed forager log entry',
    );
  } finally {
    controller.abort();
    code = await running;
  }

  assert.equal(code, 0);
  assert.deepEqual(adapter.prompts, ['scheduled ']);
  assert.equal(adapter.stopCalls, 1);
  assert.equal(existsSync(lockPath), false, 'the lock is released on shutdown');
  assert.ok(hasLogEvent(paths.log, 'pheromone.enqueued', 'node'));
  assert.ok(hasLogEvent(paths.log, 'node.completed', 'node'));
  assert.ok(captureResult.stdout.some((line) => line.startsWith('daemon started ')));

  const field = JSON.parse(readFileSync(paths.field, 'utf8')) as { rest: boolean };
  assert.equal(field.rest, true);

  const scheduler = JSON.parse(readFileSync(paths.scheduler, 'utf8')) as {
    triggers: Record<string, { kind: string; fired?: boolean }>;
  };
  assert.equal(scheduler.triggers['once']?.kind, 'at');
  assert.equal(scheduler.triggers['once']?.fired, true);

  const serializedLog = readFileSync(paths.log, 'utf8');
  assert.equal(serializedLog.includes('DAEMON-FORAGER-OUT'), false);
});

test('a past at trigger runs through a selected dsh adapter', async () => {
  const adapter = new FakeAdapter({ output: 'DAEMON-DSH-OUT' });
  const captureResult = capture();
  const controller = new AbortController();
  const project = tempDirectory('wax-daemon-project-');
  const state = tempDirectory('wax-daemon-state-');
  const dshRoot = tempDirectory('wax-daemon-dsh-');
  const compositionPath = compositionFile(
    scheduledComposition({ id: 'daemon-dsh', targetKind: 'forager' }),
  );
  const paths = honeyPaths(state, apiaryForProject(project), 'daemon-dsh');
  const requests: AdapterRequest[] = [];

  const running = runDaemon(
    [
      'daemon',
      compositionPath,
      '--project',
      project,
      '--harness',
      'dsh',
      '--dsh-root',
      dshRoot,
      '--state-dir',
      state,
    ],
    {
      ...captureResult.deps,
      createAdapter: async (request) => {
        requests.push(request);
        return adapter;
      },
      signal: controller.signal,
    },
  );

  let code = -1;
  try {
    await waitFor(() => adapter.prompts.length === 1, 'the scheduled dsh prompt');
    await waitFor(
      () => hasLogEvent(paths.log, 'node.completed', 'node'),
      'the completed dsh log entry',
    );
  } finally {
    controller.abort();
    code = await running;
  }

  assert.equal(code, 0);
  assert.deepEqual(requests, [{ harness: 'dsh', dshRoot }]);
  assert.deepEqual(adapter.prompts, ['scheduled ']);
  assert.ok(captureResult.stdout.some((line) => line.startsWith('daemon started ')));
  assert.equal(existsSync(join(paths.directory, 'daemon.lock')), false);
});

test('runDaemon forwards --composition-tools to the adapter factory', async () => {
  const adapter = new FakeAdapter({ output: 'DAEMON-TOOLS-OUT' });
  const captureResult = capture();
  const controller = new AbortController();
  const project = tempDirectory('wax-daemon-project-');
  const state = tempDirectory('wax-daemon-state-');
  const compositionPath = compositionFile(
    scheduledComposition({ id: 'daemon-tools', targetKind: 'forager' }),
  );
  const requests: AdapterRequest[] = [];

  const running = runDaemon(
    [...baseArgs(compositionPath, project, state), '--composition-tools'],
    {
      ...captureResult.deps,
      createAdapter: async (request) => {
        requests.push(request);
        return adapter;
      },
      signal: controller.signal,
    },
  );

  let code = -1;
  try {
    await waitFor(() => adapter.prompts.length === 1, 'the scheduled forager prompt');
  } finally {
    controller.abort();
    code = await running;
  }

  assert.equal(code, 0);
  assert.deepEqual(requests, [{ harness: 'codex', compositionTools: true }]);
});

test('simultaneous past triggers both run despite the node minimum interval', async () => {
  const adapter = new FakeAdapter({ output: 'TWO' });
  const captureResult = capture();
  const controller = new AbortController();
  const project = tempDirectory('wax-daemon-project-');
  const state = tempDirectory('wax-daemon-state-');
  const at = new Date(Date.now() - 60_000).toISOString();
  const compositionPath = compositionFile({
    schemaVersion: 1,
    id: 'daemon-two-triggers',
    nodes: { node: { kind: 'forager', config: { connection: 'codex', prompt: 'go' } } },
    edges: [],
    triggers: [
      { id: 'first', target: 'node', schedule: { kind: 'at', at } },
      { id: 'second', target: 'node', schedule: { kind: 'at', at } },
    ],
  });

  const running = runDaemon(baseArgs(compositionPath, project, state), {
    ...captureResult.deps,
    createAdapter: async () => adapter,
    signal: controller.signal,
  });

  let code = -1;
  try {
    await waitFor(() => adapter.prompts.length === 2, 'both scheduled prompts', 15_000);
  } finally {
    controller.abort();
    code = await running;
  }

  assert.equal(code, 0);
  assert.deepEqual(adapter.prompts, ['go', 'go']);
});

test('a past at trigger runs a worker and records its metadata only', async () => {
  const adapter = new FakeAdapter();
  const captureResult = capture();
  const controller = new AbortController();
  const project = tempDirectory('wax-daemon-project-');
  const state = tempDirectory('wax-daemon-state-');
  const body = 'WORKER-TRIGGER-BODY';
  const compositionPath = compositionFile(
    scheduledComposition({
      id: 'daemon-worker',
      targetKind: 'worker',
      config: {
        command: process.execPath,
        args: ['-e', `process.stdout.write(${JSON.stringify(body)})`],
      },
    }),
  );
  const paths = honeyPaths(state, apiaryForProject(project), 'daemon-worker');

  const running = runDaemon(baseArgs(compositionPath, project, state), {
    ...captureResult.deps,
    createAdapter: async () => adapter,
    signal: controller.signal,
  });

  let code = -1;
  try {
    await waitFor(
      () => hasLogEvent(paths.log, 'node.completed', 'node'),
      'the completed worker log entry',
    );
  } finally {
    controller.abort();
    code = await running;
  }

  assert.equal(code, 0);
  assert.deepEqual(adapter.prompts, [], 'a worker trigger does not need a model');
  assert.ok(hasLogEvent(paths.log, 'pheromone.enqueued', 'node'));
  const completed = logEntries(paths.log).find(
    (entry) => entry['event'] === 'node.completed' && entry['nodeId'] === 'node',
  );
  assert.ok(completed !== undefined);
  assert.equal(completed['nodeKind'], 'worker');
  assert.equal(completed['stdoutBytes'], Buffer.byteLength(body));
  assert.equal(readFileSync(paths.log, 'utf8').includes(body), false);
});

test('a daemon approval is rejected by default and logged', async () => {
  const adapter = new FakeAdapter({ askApproval: true, output: 'GUARDED' });
  const captureResult = capture();
  const controller = new AbortController();
  const project = tempDirectory('wax-daemon-project-');
  const state = tempDirectory('wax-daemon-state-');
  const compositionPath = compositionFile(
    scheduledComposition({ id: 'daemon-guard', targetKind: 'forager' }),
  );
  const paths = honeyPaths(state, apiaryForProject(project), 'daemon-guard');

  const running = runDaemon(baseArgs(compositionPath, project, state), {
    ...captureResult.deps,
    createAdapter: async () => adapter,
    signal: controller.signal,
  });

  let code = -1;
  try {
    await waitFor(() => adapter.approvals.length === 1, 'the guard decision');
    await waitFor(
      () => hasLogEvent(paths.log, 'node.completed', 'node'),
      'the completed guarded run',
    );
  } finally {
    controller.abort();
    code = await running;
  }

  assert.equal(code, 0);
  assert.deepEqual(adapter.approvals.map((decision) => decision.kind), ['reject_once']);
  const entries = logEntries(paths.log);
  assert.ok(entries.some((entry) => entry['event'] === 'guard.opened'));
  const resolved = entries.find((entry) => entry['event'] === 'guard.resolved');
  assert.ok(resolved !== undefined);
  assert.equal(resolved['outcome'], 'reject_once');
  assert.equal(entries.some((entry) => entry['outcome'] === 'allow_once'), false);
});

test('runCli dispatches the daemon command', async () => {
  const captureResult = capture();
  const code = await runCli(
    baseArgs(
      compositionFile({
        schemaVersion: 1,
        id: 'dispatch-daemon',
        nodes: { plan: { kind: 'forager', config: { connection: 'codex', prompt: 'p' } } },
        edges: [],
      }),
      tempDirectory('wax-daemon-project-'),
      tempDirectory('wax-daemon-state-'),
    ),
    captureResult.deps,
  );

  assert.equal(code, 2);
  assert.match(captureResult.stderr.join('\n'), /no scheduled triggers/);
});

test('a restored active forager is left unknown and never replayed', async () => {
  const adapter = new FakeAdapter();
  const captureResult = capture();
  const controller = new AbortController();
  const project = tempDirectory('wax-daemon-project-');
  const state = tempDirectory('wax-daemon-state-');
  const raw = scheduledComposition({
    id: 'daemon-restore',
    targetKind: 'forager',
    atMs: Date.now() + 60 * 60 * 1000,
  });
  const compositionPath = compositionFile(raw);
  const definition = parseComposition(raw);
  const apiary = apiaryForProject(project);
  const paths = honeyPaths(state, apiary, 'daemon-restore');
  const store = HoneyStore.forComposition(state, apiary, 'daemon-restore');
  store.save({
    schemaVersion: 1,
    compositionId: 'daemon-restore',
    graphRevision: definition.graphRevision,
    rest: false,
    nodes: {
      node: {
        queue: [],
        active: {
          id: 'ph_active_forager',
          traceId: 'tr_active_forager',
          value: { kind: 'text', text: 'x' },
          at: new Date().toISOString(),
        },
      },
    },
  });

  const running = runDaemon(baseArgs(compositionPath, project, state), {
    ...captureResult.deps,
    createAdapter: async () => adapter,
    signal: controller.signal,
  });

  let code = -1;
  try {
    await waitFor(
      () => hasLogEvent(paths.log, 'runtime.restored'),
      'the restored field log entry',
    );
  } finally {
    controller.abort();
    code = await running;
  }

  assert.equal(code, 0);
  assert.deepEqual(adapter.prompts, [], 'an active forager is never replayed');
  const field = JSON.parse(readFileSync(paths.field, 'utf8')) as {
    rest: boolean;
    nodes: Record<string, { active?: unknown; state?: Record<string, unknown> }>;
  };
  assert.equal(field.rest, true);
  const node = field.nodes['node'];
  assert.ok(node !== undefined);
  assert.equal(node.active, undefined);
  assert.equal(node.state?.['lastOutcome'], 'unknown');
  assert.equal(node.state?.['needsAttention'], true);
});

test('a second daemon for the same composition is refused by the lock', async () => {
  const firstAdapter = new FakeAdapter();
  const secondAdapter = new FakeAdapter();
  const controller = new AbortController();
  const project = tempDirectory('wax-daemon-project-');
  const state = tempDirectory('wax-daemon-state-');
  const future = Date.now() + 60 * 60 * 1000;
  const compositionPath = compositionFile(
    scheduledComposition({ id: 'daemon-lock', targetKind: 'forager', atMs: future }),
  );
  const paths = honeyPaths(state, apiaryForProject(project), 'daemon-lock');
  const lockPath = join(paths.directory, 'daemon.lock');

  const firstCapture = capture();
  const first = runDaemon(baseArgs(compositionPath, project, state), {
    ...firstCapture.deps,
    createAdapter: async () => firstAdapter,
    signal: controller.signal,
  });

  await waitFor(() => existsSync(lockPath), 'the first daemon lock');

  const secondCapture = capture();
  const secondCode = await runDaemon(baseArgs(compositionPath, project, state), {
    ...secondCapture.deps,
    createAdapter: async () => secondAdapter,
  });

  controller.abort();
  const firstCode = await first;

  assert.equal(secondCode, 1);
  assert.match(secondCapture.stderr.join('\n'), /another daemon is already running/);
  assert.equal(secondAdapter.startCalls, 0, 'the refused daemon never starts an adapter');
  assert.equal(firstCode, 0);
  assert.equal(existsSync(lockPath), false);
});

test('a malformed lock is not stolen', async () => {
  const adapter = new FakeAdapter();
  const project = tempDirectory('wax-daemon-project-');
  const state = tempDirectory('wax-daemon-state-');
  const compositionPath = compositionFile(
    scheduledComposition({ id: 'bad-lock', targetKind: 'forager' }),
  );
  const paths = honeyPaths(state, apiaryForProject(project), 'bad-lock');
  mkdirSync(paths.directory, { recursive: true });
  const lockPath = join(paths.directory, 'daemon.lock');
  writeFileSync(lockPath, '{ not json');

  const captureResult = capture();
  const code = await runDaemon(baseArgs(compositionPath, project, state), {
    ...captureResult.deps,
    createAdapter: async () => adapter,
  });

  assert.equal(code, 1);
  assert.match(captureResult.stderr.join('\n'), /malformed|refusing to steal/);
  assert.equal(adapter.startCalls, 0);
  assert.equal(existsSync(lockPath), true, 'the unreadable lock is left in place');
});

test('the daemon heartbeat expires a merge deadline without new IPC', async () => {
  const START = Date.parse('2026-06-01T00:00:00.000Z');
  const deadline = START + 1000;
  const adapter = new FakeAdapter();
  const captureResult = capture();
  const controller = new AbortController();
  const project = tempDirectory('wax-daemon-project-');
  const state = tempDirectory('wax-daemon-state-');
  const raw = {
    schemaVersion: 1,
    id: 'daemon-merge-timeout',
    nodes: {
      plan: { kind: 'forager', config: { connection: 'codex', prompt: 'plan' } },
      merge: {
        kind: 'merge',
        config: { required: ['a', 'b'], combine: 'text', timeoutMs: 600_000 },
      },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
    },
    edges: [{ id: 'e1', from: 'merge', to: 'done' }],
    triggers: [
      {
        id: 'later',
        target: 'plan',
        schedule: { kind: 'at', at: new Date(START + 3_600_000).toISOString() },
      },
    ],
  };
  const compositionPath = compositionFile(raw);
  const definition = parseComposition(raw);
  const apiary = apiaryForProject(project);
  const paths = honeyPaths(state, apiary, 'daemon-merge-timeout');
  const store = HoneyStore.forComposition(state, apiary, 'daemon-merge-timeout');

  const field = new PheromoneRuntime(definition, {
    executeForager: {
      async execute(_node, input) {
        return input;
      },
    },
    now: () => START,
  }).exportField();
  field.rest = false;
  field.nodes['merge'] = {
    queue: [],
    joins: {
      fk_wait: {
        arrived: [
          {
            id: 'ph_wait_a',
            traceId: 'tr_wait',
            forkId: 'fk_wait',
            branchId: 'a',
            value: { kind: 'text' as const, text: 'A' },
            at: new Date(START).toISOString(),
          },
        ],
        deadlineAt: deadline,
      },
    },
  };
  store.save(field);

  let clock = START;
  const running = runDaemon(baseArgs(compositionPath, project, state), {
    ...captureResult.deps,
    createAdapter: async () => adapter,
    signal: controller.signal,
    now: () => clock,
  });

  let code = -1;
  try {
    await waitFor(() => hasLogEvent(paths.log, 'runtime.restored'), 'the restored field');
    // Move the runtime clock past the deadline; the existing 500 ms heartbeat
    // is the only wake the daemon needs.
    clock = deadline + 1000;
    await waitFor(() => hasLogEvent(paths.log, 'merge.timed-out'), 'the merge timeout');
  } finally {
    controller.abort();
    code = await running;
  }

  assert.equal(code, 0);
  assert.deepEqual(adapter.prompts, [], 'the timed-out join never emitted');
  const saved = JSON.parse(readFileSync(paths.field, 'utf8')) as {
    rest: boolean;
    nodes: Record<string, { joins?: Record<string, Record<string, unknown>> }>;
  };
  assert.equal(saved.rest, true);
  const join = Object.values(saved.nodes['merge']?.joins ?? {})[0];
  assert.ok(join !== undefined);
  assert.ok(typeof join['timedOutAt'] === 'string');
  assert.equal(join['deadlineAt'], undefined);
  assert.deepEqual(join['arrived'], []);
});

test('an early abort stops the daemon before a future trigger fires', async () => {
  const adapter = new FakeAdapter();
  const captureResult = capture();
  const controller = new AbortController();
  const project = tempDirectory('wax-daemon-project-');
  const state = tempDirectory('wax-daemon-state-');
  const compositionPath = compositionFile(
    scheduledComposition({
      id: 'daemon-stop',
      targetKind: 'forager',
      atMs: Date.now() + 60 * 60 * 1000,
    }),
  );

  const running = runDaemon(baseArgs(compositionPath, project, state), {
    ...captureResult.deps,
    createAdapter: async () => adapter,
    signal: controller.signal,
  });
  controller.abort();

  const code = await running;
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(code, 0);
  assert.deepEqual(adapter.prompts, []);
  assert.equal(adapter.stopCalls, 1);
});
