import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DshAcpAdapter } from '../src/adapters/dsh-acp/adapter.js';
import { apiaryForProject, CliUsageError, parseRunArgs, runCli, type CliDependencies } from '../src/cli.js';
import { createDefaultAdapter, findDshPluginPatch, type AdapterRequest } from '../src/cli-shared.js';
import { HoneyStore, honeyPaths } from '../src/honey.js';
import { parseComposition, PheromoneRuntime } from '../src/runtime/index.js';
import type { HoverSpec, UserNode, Value } from '../src/runtime/index.js';
import { FakeAdapter } from './support/fake-adapter.js';

const COMPOSITION = {
  schemaVersion: 1,
  id: 'cli-demo',
  nodes: {
    start: { kind: 'forager', config: { connection: 'codex', prompt: 'reply to {{input}}' } },
  },
  edges: [],
};

const BRANCHING_COMPOSITION = {
  schemaVersion: 1,
  id: 'branch',
  nodes: {
    check: { kind: 'condition', config: { mode: 'text', contains: 'go' } },
    yes: { kind: 'forager', config: { connection: 'codex', prompt: 'yes' } },
    no: { kind: 'forager', config: { connection: 'codex', prompt: 'no' } },
  },
  edges: [
    { id: 'e1', from: 'check', to: 'yes', when: 'true' },
    { id: 'e2', from: 'check', to: 'no', when: 'false' },
  ],
};

const ASK_COMPOSITION = {
  schemaVersion: 1,
  id: 'ask',
  nodes: {
    start: { kind: 'forager', config: { connection: 'codex', prompt: 'plan {{input}}' } },
    ask: { kind: 'user', config: { modality: 'text', prompt: 'Approve?' } },
    done: { kind: 'forager', config: { connection: 'codex', prompt: 'finish' } },
  },
  edges: [
    { id: 'e1', from: 'start', to: 'ask' },
    { id: 'e2', from: 'ask', to: 'done' },
  ],
};

const MERGE_TIMEOUT_COMPOSITION = {
  schemaVersion: 1,
  id: 'cli-merge-timeout',
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
    merge: {
      kind: 'merge',
      config: { required: ['a', 'b'], combine: 'text', timeoutMs: 5000 },
    },
    done: { kind: 'forager', config: { connection: 'codex', prompt: 'done' } },
  },
  edges: [
    { id: 'e1', from: 'start', to: 'fork' },
    { id: 'e2', from: 'merge', to: 'done' },
  ],
};

function compositionFile(contents: unknown = COMPOSITION): string {
  const directory = mkdtempSync(join(tmpdir(), 'wax-cli-composition-'));
  const path = join(directory, 'composition.json');
  writeFileSync(path, JSON.stringify(contents));
  return path;
}

function projectDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'wax-cli-project-'));
}

function stateDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'wax-cli-state-'));
}

function baseArgs(compositionPath: string, project: string, state: string): string[] {
  return ['run', compositionPath, '--project', project, '--harness', 'codex', '--state-dir', state];
}

interface Capture {
  readonly stdout: string[];
  readonly stderr: string[];
  readonly deps: CliDependencies;
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

function withAdapter(adapter: FakeAdapter, base: Capture, extra: Partial<CliDependencies> = {}): CliDependencies {
  return {
    ...base.deps,
    createAdapter: async () => adapter,
    ...extra,
  };
}

test('parses a full run command', () => {
  const command = parseRunArgs([
    'run',
    'composition.json',
    '--project',
    'C:/work',
    '--harness',
    'codex',
    '--trigger',
    'start',
    '--input',
    'hello world',
    '--apiary',
    'demo',
  ]);

  assert.equal(command.compositionPath, 'composition.json');
  assert.equal(command.projectDirectory, 'C:/work');
  assert.equal(command.harness, 'codex');
  assert.equal(command.trigger, 'start');
  assert.equal(command.input, 'hello world');
  assert.equal(command.apiary, 'demo');
  assert.equal(command.resume, false);
  assert.equal(command.stateDir, '~/.wax');
});

test('trigger is optional when resuming', () => {
  const command = parseRunArgs(['run', 'c.json', '--project', 'p', '--harness', 'codex', '--resume']);
  assert.equal(command.trigger, undefined);
  assert.equal(command.resume, true);
});

test('parses --composition-tools as an opt-in boolean', () => {
  const off = parseRunArgs(['run', 'c.json', '--project', 'p', '--harness', 'codex', '--trigger', 's']);
  assert.equal(off.compositionTools, false);

  const on = parseRunArgs([
    'run',
    'c.json',
    '--project',
    'p',
    '--harness',
    'codex',
    '--trigger',
    's',
    '--composition-tools',
  ]);
  assert.equal(on.compositionTools, true);

  assert.throws(
    () =>
      parseRunArgs([
        'run',
        'c.json',
        '--project',
        'p',
        '--harness',
        'codex',
        '--trigger',
        's',
        '--composition-tools',
        '--composition-tools',
      ]),
    /more than once/,
  );
});

test('rejects missing, duplicated and unknown options', () => {
  assert.throws(
    () => parseRunArgs(['run', 'c.json', '--harness', 'codex', '--trigger', 'start']),
    /missing required option --project/,
  );
  assert.throws(
    () => parseRunArgs(['run', 'c.json', '--project', 'p', '--harness', 'codex']),
    /missing required option --trigger/,
  );
  assert.throws(() => parseRunArgs(['plan', 'c.json']), CliUsageError);
  assert.throws(
    () => parseRunArgs(['run', 'c.json', '--project', 'p', '--project', 'q', '--harness', 'codex', '--trigger', 's']),
    /more than once/,
  );
  assert.throws(
    () => parseRunArgs(['run', 'c.json', '--project', 'p', '--harness', 'codex', '--trigger', 's', '--bogus', 'x']),
    /unknown option '--bogus'/,
  );
  assert.throws(
    () => parseRunArgs(['run', 'c.json', '--project', 'p', '--harness', 'other', '--trigger', 's']),
    /--harness must be 'codex' or 'dsh'/,
  );
});

test('parses an explicit codex executable', () => {
  const command = parseRunArgs([
    'run',
    'c.json',
    '--project',
    'p',
    '--harness',
    'codex',
    '--trigger',
    'start',
    '--codex-exe',
    'C:/tools/codex.exe',
  ]);
  assert.equal(command.codexExe, 'C:/tools/codex.exe');
});

test('apiaryForProject produces a filesystem-safe slug', () => {
  assert.equal(apiaryForProject('C:/work/My Project!'), 'my-project');
  assert.equal(apiaryForProject('C:/work/项目'), 'apiary');
});

test('runs a composition to Rest through the fake adapter', async () => {
  const adapter = new FakeAdapter({ output: 'CLI-OK' });
  const captureResult = capture();
  const state = stateDirectory();

  const code = await runCli(
    [...baseArgs(compositionFile(), projectDirectory(), state), '--trigger', 'start', '--input', 'hi'],
    withAdapter(adapter, captureResult),
  );

  assert.equal(code, 0);
  assert.ok(captureResult.stdout.includes('composition  cli-demo'));
  assert.ok(captureResult.stdout.includes('rest         true'));
  assert.ok(captureResult.stdout.includes('output       CLI-OK'));
  assert.ok(captureResult.stdout.some((line) => line.startsWith('log          ')));
  assert.deepEqual(adapter.prompts, ['reply to hi']);
  assert.equal(adapter.stopCalls, 1);
});

test('passes the stable WAX session display name to the adapter', async () => {
  const adapter = new FakeAdapter({ output: 'NAMED' });
  const captureResult = capture();
  const state = stateDirectory();
  const project = projectDirectory();

  const code = await runCli(
    [...baseArgs(compositionFile(), project, state), '--trigger', 'start'],
    withAdapter(adapter, captureResult),
  );

  assert.equal(code, 0);
  assert.deepEqual(adapter.displayNames, [
    `wax-apiary-nexus-session-${apiaryForProject(project)}-cli-demo`,
  ]);
});

test('runs a worker through the registered project directory', async () => {
  const adapter = new FakeAdapter({ output: 'FORAGER' });
  const captureResult = capture();
  const state = stateDirectory();
  const project = projectDirectory();
  const composition = {
    schemaVersion: 1,
    id: 'cli-worker',
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'start' } },
      work: {
        kind: 'worker',
        config: {
          command: process.execPath,
          args: ['-e', 'process.stdout.write("WORKER-CLI-BODY")'],
        },
      },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'finish {{input}}' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'work' },
      { id: 'e2', from: 'work', to: 'done' },
    ],
  };

  const code = await runCli(
    [...baseArgs(compositionFile(composition), project, state), '--trigger', 'start'],
    withAdapter(adapter, captureResult),
  );

  assert.equal(code, 0);
  assert.deepEqual(adapter.prompts, ['start', 'finish WORKER-CLI-BODY']);

  const paths = honeyPaths(state, apiaryForProject(project), 'cli-worker');
  const entries = readFileSync(paths.log, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const completed = entries.find(
    (entry) => entry['event'] === 'node.completed' && entry['nodeId'] === 'work',
  );
  assert.ok(completed !== undefined);
  assert.equal(completed['nodeKind'], 'worker');
  assert.equal(completed['program'], process.execPath);
  assert.equal(completed['stdoutBytes'], Buffer.byteLength('WORKER-CLI-BODY'));
  assert.equal(readFileSync(paths.log, 'utf8').includes('WORKER-CLI-BODY'), false);
});

test('persists honey/field.json and log.jsonl', async () => {
  const adapter = new FakeAdapter({ output: 'OK' });
  const captureResult = capture();
  const state = stateDirectory();
  const project = projectDirectory();

  const code = await runCli(
    [...baseArgs(compositionFile(), project, state), '--trigger', 'start'],
    withAdapter(adapter, captureResult),
  );

  assert.equal(code, 0);
  const paths = honeyPaths(state, apiaryForProject(project), 'cli-demo');
  assert.ok(existsSync(paths.field));
  assert.ok(existsSync(paths.log));

  const field = JSON.parse(readFileSync(paths.field, 'utf8')) as { rest: boolean; compositionId: string };
  assert.equal(field.compositionId, 'cli-demo');
  assert.equal(field.rest, true);

  const lines = readFileSync(paths.log, 'utf8').trim().split('\n');
  assert.ok(lines.length > 0);
  const first = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
  assert.equal(first['compositionId'], 'cli-demo');
  assert.ok(!('prompt' in first));
});

test('writes a transcript while the log keeps only a reference', async () => {
  const adapter = new FakeAdapter({ output: 'TRANSCRIPT-BODY' });
  const captureResult = capture();
  const state = stateDirectory();
  const project = projectDirectory();

  const code = await runCli(
    [...baseArgs(compositionFile(), project, state), '--trigger', 'start'],
    withAdapter(adapter, captureResult),
  );

  assert.equal(code, 0);
  const paths = honeyPaths(state, apiaryForProject(project), 'cli-demo');
  const files = readdirSync(paths.transcripts);
  assert.equal(files.length, 1);
  const transcriptFile = files[0];
  assert.ok(transcriptFile !== undefined);
  const transcript = readFileSync(join(paths.transcripts, transcriptFile), 'utf8');
  assert.match(transcript, /TRANSCRIPT-BODY/);

  const log = readFileSync(paths.log, 'utf8');
  assert.ok(!log.includes('TRANSCRIPT-BODY'), 'the metadata log never carries bodies');
  assert.match(log, /transcriptRef/);
});

test('a native approval is parked as a guard hover', async () => {
  const adapter = new FakeAdapter({ askApproval: true, output: 'GUARDED' });
  const captureResult = capture();
  const seen: string[] = [];

  const code = await runCli(
    [...baseArgs(compositionFile(), projectDirectory(), stateDirectory()), '--trigger', 'start'],
    withAdapter(adapter, captureResult, {
      askApproval: async (request) => {
        seen.push(request.requestId);
        return 'allow_once';
      },
    }),
  );

  assert.equal(code, 0);
  assert.equal(seen.length, 1);
  assert.deepEqual(adapter.approvals.map((decision) => decision.kind), ['allow_once']);
  assert.ok(captureResult.stdout.some((line) => line.includes('guard.opened')));
  assert.ok(captureResult.stdout.some((line) => line.includes('guard.resolved')));
});

test('a user node asks through the injected handler and resumes the graph', async () => {
  const adapter = new FakeAdapter({ output: 'FORAGER-OUT' });
  const captureResult = capture();
  const state = stateDirectory();
  const asked: { node: UserNode; hover: HoverSpec }[] = [];

  const code = await runCli(
    [...baseArgs(compositionFile(ASK_COMPOSITION), projectDirectory(), state), '--trigger', 'start'],
    withAdapter(adapter, captureResult, {
      askUser: async (node, hover) => {
        asked.push({ node, hover });
        return { kind: 'text', text: 'yes' } satisfies Value;
      },
    }),
  );

  assert.equal(code, 0);
  assert.equal(asked.length, 1);
  assert.equal(asked[0]?.node.id, 'ask');
  assert.match(asked[0]?.hover.token ?? '', /^hv_/);
  assert.deepEqual(adapter.prompts, ['plan ', 'finish']);
  assert.ok(captureResult.stdout.some((line) => line.includes('node         ask') && line.includes('hover=no')));
});

test('a hovering user node is refused on a non-interactive stdin', async () => {
  const adapter = new FakeAdapter({ output: 'OUT' });
  const captureResult = capture();
  const state = stateDirectory();
  const project = projectDirectory();

  const code = await runCli(
    [...baseArgs(compositionFile(ASK_COMPOSITION), project, state), '--trigger', 'start'],
    withAdapter(adapter, captureResult),
  );

  assert.equal(code, 1);
  assert.match(captureResult.stderr.join('\n'), /stdin is not interactive/);
  assert.equal(adapter.prompts.length, 1, 'only the first forager ran');

  const field = JSON.parse(
    readFileSync(honeyPaths(state, apiaryForProject(project), 'ask').field, 'utf8'),
  ) as { nodes: Record<string, { hover?: unknown }> };
  assert.ok(field.nodes['ask']?.hover !== undefined, 'the hover is persisted for a later resume');
});

test('a hostile apiary id exits with a usage code', async () => {
  const captureResult = capture();
  const code = await runCli(
    [
      ...baseArgs(compositionFile(), projectDirectory(), stateDirectory()),
      '--trigger',
      'start',
      '--apiary',
      '../escape',
    ],
    captureResult.deps,
  );

  assert.equal(code, 2);
  assert.match(captureResult.stderr.join('\n'), /invalid apiary id/);
});

test('an approval handler is consulted and never auto-allowed', async () => {
  const adapter = new FakeAdapter({ askApproval: true, output: 'DONE' });
  const captureResult = capture();

  const code = await runCli(
    [...baseArgs(compositionFile(), projectDirectory(), stateDirectory()), '--trigger', 'start'],
    withAdapter(adapter, captureResult, { askApproval: async () => 'allow_once' }),
  );

  assert.equal(code, 0);
  assert.deepEqual(adapter.approvals.map((decision) => decision.kind), ['allow_once']);
  assert.ok(captureResult.stdout.includes('output       DONE'));
});

test('unknown trigger and non-forager trigger exit with a usage code', async () => {
  const adapter = new FakeAdapter();
  const first = capture();
  const second = capture();

  const unknown = await runCli(
    [...baseArgs(compositionFile(), projectDirectory(), stateDirectory()), '--trigger', 'ghost'],
    withAdapter(adapter, first),
  );
  const nonForager = await runCli(
    [...baseArgs(compositionFile(BRANCHING_COMPOSITION), projectDirectory(), stateDirectory()), '--trigger', 'check'],
    withAdapter(adapter, second),
  );

  assert.equal(unknown, 2);
  assert.match(first.stderr.join('\n'), /unknown trigger node 'ghost'/);
  assert.equal(nonForager, 2);
  assert.match(second.stderr.join('\n'), /must be a forager, worker or user node/);
});

test('parses the dsh harness with an explicit root', () => {
  const command = parseRunArgs(
    [
      'run',
      'composition.json',
      '--project',
      'C:/work',
      '--harness',
      'dsh',
      '--dsh-root',
      'C:/deepseek-harness',
      '--trigger',
      'start',
    ],
    {},
  );

  assert.equal(command.harness, 'dsh');
  assert.equal(command.dshRoot, 'C:/deepseek-harness');
});

test('resolves the dsh root from DSH_ROOT and prefers the flag', () => {
  const args = ['run', 'c.json', '--project', 'p', '--harness', 'dsh', '--trigger', 'start'];
  const fromEnv = parseRunArgs(args, { DSH_ROOT: 'C:/dsh-from-env' });
  const fromFlag = parseRunArgs([...args, '--dsh-root', 'C:/dsh-from-flag'], {
    DSH_ROOT: 'C:/dsh-from-env',
  });

  assert.equal(fromEnv.harness, 'dsh');
  assert.equal(fromEnv.dshRoot, 'C:/dsh-from-env');
  assert.equal(fromFlag.dshRoot, 'C:/dsh-from-flag');
});

test('rejects a missing dsh root and cross-harness overrides', () => {
  const dsh = ['run', 'c.json', '--project', 'p', '--harness', 'dsh', '--trigger', 'start'];

  assert.throws(() => parseRunArgs(dsh, {}), /requires --dsh-root/);
  assert.throws(() => parseRunArgs(dsh, { DSH_ROOT: '' }), /requires --dsh-root/);
  assert.throws(
    () => parseRunArgs([...dsh, '--dsh-root', 'C:/dsh', '--codex-exe', 'C:/tools/codex.exe'], {}),
    /--codex-exe only applies to --harness codex/,
  );
  assert.throws(
    () =>
      parseRunArgs(
        [
          'run',
          'c.json',
          '--project',
          'p',
          '--harness',
          'codex',
          '--trigger',
          'start',
          '--dsh-root',
          'C:/dsh',
        ],
        {},
      ),
    /--dsh-root only applies to --harness dsh/,
  );
});

test('runs a composition to Rest through a selected dsh adapter', async () => {
  const adapter = new FakeAdapter({ output: 'DSH-FAKE' });
  const captureResult = capture();
  const dshRoot = projectDirectory();
  const requests: AdapterRequest[] = [];

  const code = await runCli(
    [
      'run',
      compositionFile(),
      '--project',
      projectDirectory(),
      '--harness',
      'dsh',
      '--state-dir',
      stateDirectory(),
      '--trigger',
      'start',
      '--input',
      'hi',
    ],
    {
      ...captureResult.deps,
      env: { DSH_ROOT: dshRoot },
      createAdapter: async (request) => {
        requests.push(request);
        return adapter;
      },
    },
  );

  assert.equal(code, 0);
  assert.deepEqual(requests, [{ harness: 'dsh', dshRoot }]);
  assert.deepEqual(adapter.prompts, ['reply to hi']);
  assert.ok(captureResult.stdout.includes('output       DSH-FAKE'));
});

test('createDefaultAdapter selects DshAcpAdapter and mounts the WAX overlay when present', async () => {
  const adapter = await createDefaultAdapter({ harness: 'dsh', dshRoot: projectDirectory() });
  assert.ok(adapter instanceof DshAcpAdapter);
  const patch = findDshPluginPatch();
  if (patch === undefined) {
    assert.equal(adapter.capabilities.rename, false);
  } else {
    assert.equal(adapter.capabilities.rename, true);
    assert.deepEqual(
      (adapter as unknown as { dshArgs: readonly string[] }).dshArgs,
      ['--patch', patch],
    );
    assert.equal(
      (adapter as unknown as { sidecarDir: string }).sidecarDir,
      join(homedir(), '.wax', 'dsh', 'session-names'),
    );
  }
  await assert.rejects(createDefaultAdapter({ harness: 'dsh' }), /requires --dsh-root/);
});

test('runCli forwards --composition-tools to the adapter factory', async () => {
  const adapter = new FakeAdapter({ output: 'TOOLS-FAKE' });
  const captureResult = capture();
  const requests: AdapterRequest[] = [];

  const code = await runCli(
    [
      'run',
      compositionFile(),
      '--project',
      projectDirectory(),
      '--harness',
      'codex',
      '--state-dir',
      stateDirectory(),
      '--trigger',
      'start',
      '--composition-tools',
    ],
    {
      ...captureResult.deps,
      createAdapter: async (request) => {
        requests.push(request);
        return adapter;
      },
    },
  );

  assert.equal(code, 0);
  assert.deepEqual(requests, [{ harness: 'codex', compositionTools: true }]);
});

test('a failed execution exits non-zero and still reports the field state', async () => {
  const adapter = new FakeAdapter({ terminal: 'failed', error: 'native exploded' });
  const captureResult = capture();

  const code = await runCli(
    [...baseArgs(compositionFile(), projectDirectory(), stateDirectory()), '--trigger', 'start'],
    withAdapter(adapter, captureResult),
  );

  assert.equal(code, 1);
  assert.match(captureResult.stderr.join('\n'), /native exploded/);
  assert.ok(captureResult.stdout.includes('rest         true'));
});

test('an invalid composition file exits with a usage code', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'wax-cli-bad-'));
  const path = join(directory, 'broken.json');
  writeFileSync(path, '{ not json');
  const captureResult = capture();

  const code = await runCli(
    [...baseArgs(path, projectDirectory(), stateDirectory()), '--trigger', 'start'],
    captureResult.deps,
  );

  assert.equal(code, 2);
  assert.match(captureResult.stderr.join('\n'), /not valid JSON/);
});

test('a missing project directory exits non-zero without leaking an exception', async () => {
  const adapter = new FakeAdapter();
  const captureResult = capture();
  const missing = join(tmpdir(), `wax-missing-${String(process.pid)}-${String(Date.now())}`);

  const code = await runCli(
    [...baseArgs(compositionFile(), missing, stateDirectory()), '--trigger', 'start'],
    withAdapter(adapter, captureResult),
  );

  assert.equal(code, 1);
  assert.match(captureResult.stderr.join('\n'), /error:/);
  assert.equal(adapter.stopCalls, 1);
});

test('resume continues a persisted user hover and reports the recovery', async () => {
  const state = stateDirectory();
  const project = projectDirectory();
  const compositionPath = compositionFile(ASK_COMPOSITION);

  const failed = capture();
  const first = await runCli(
    [...baseArgs(compositionPath, project, state), '--trigger', 'start'],
    withAdapter(new FakeAdapter({ output: 'OUT' }), failed, {
      askUser: async () => {
        throw new Error('no tty');
      },
    }),
  );
  assert.equal(first, 1);
  assert.match(failed.stderr.join('\n'), /no tty/);

  const resumed = capture();
  const answers: string[] = [];
  const second = await runCli(
    ['run', compositionPath, '--project', project, '--harness', 'codex', '--state-dir', state, '--resume'],
    withAdapter(new FakeAdapter({ output: 'OUT' }), resumed, {
      askUser: async (node) => {
        answers.push(node.id);
        return { kind: 'text', text: 'resumed' } satisfies Value;
      },
    }),
  );

  assert.equal(second, 0);
  assert.deepEqual(answers, ['ask']);
  assert.ok(resumed.stdout.some((line) => line.startsWith('recovered    hovers=ask')));
  assert.ok(resumed.stdout.includes('rest         true'));
});

test('resume without a persisted field is a usage error', async () => {
  const captureResult = capture();

  const code = await runCli(
    ['run', compositionFile(), '--project', projectDirectory(), '--harness', 'codex', '--state-dir', stateDirectory(), '--resume'],
    captureResult.deps,
  );

  assert.equal(code, 2);
  assert.match(captureResult.stderr.join('\n'), /nothing to resume/);
});

test('run wakes for a pending rate-limited branch before a later merge deadline', async () => {
  const START = Date.parse('2026-06-01T00:00:00.000Z');
  const adapter = new FakeAdapter({ output: 'DONE-OUT' });
  const captureResult = capture();
  const state = stateDirectory();
  const project = projectDirectory();
  const compositionPath = compositionFile(MERGE_TIMEOUT_COMPOSITION);

  let clock = START;
  const sleeps: number[] = [];
  const code = await runCli(
    [...baseArgs(compositionPath, project, state), '--trigger', 'start'],
    withAdapter(adapter, captureResult, {
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    }),
  );

  assert.equal(code, 0);
  // The second required branch is pending for minIntervalMs (1000), which is
  // earlier than the 5000 ms merge deadline.
  assert.deepEqual(sleeps, [1000]);
  assert.deepEqual(adapter.prompts, ['start ', 'done'], 'the merge emitted before the deadline');
  assert.ok(captureResult.stdout.includes('rest         true'));

  const store = HoneyStore.forComposition(state, apiaryForProject(project), 'cli-merge-timeout');
  const saved = store.load();
  assert.ok(saved !== undefined);
  const join = Object.values(saved.nodes['merge']?.joins ?? {})[0];
  assert.ok(join !== undefined);
  assert.ok(join.completedAt !== undefined);
  assert.equal(join.timedOutAt, undefined);
});

test('run waits for nextWakeAt when no hover is left, then expires the join', async () => {
  const START = Date.parse('2026-06-01T00:00:00.000Z');
  const deadline = START + 5000;
  const adapter = new FakeAdapter({ output: 'UNUSED' });
  const captureResult = capture();
  const state = stateDirectory();
  const project = projectDirectory();
  const compositionPath = compositionFile(MERGE_TIMEOUT_COMPOSITION);
  const definition = parseComposition(MERGE_TIMEOUT_COMPOSITION);
  const apiary = apiaryForProject(project);
  const store = HoneyStore.forComposition(state, apiary, definition.id);

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
  const sleeps: number[] = [];
  const code = await runCli(
    ['run', compositionPath, '--project', project, '--harness', 'codex', '--state-dir', state, '--resume'],
    withAdapter(adapter, captureResult, {
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    }),
  );

  assert.equal(code, 0);
  assert.deepEqual(sleeps, [5000], 'the CLI slept exactly until the persisted deadline');
  assert.deepEqual(adapter.prompts, [], 'the timed-out join never emitted');
  assert.ok(captureResult.stdout.includes('rest         true'));

  const saved = store.load();
  assert.ok(saved !== undefined);
  assert.equal(saved.rest, true);
  const join = Object.values(saved.nodes['merge']?.joins ?? {})[0];
  assert.ok(join !== undefined);
  assert.ok(join.timedOutAt !== undefined);
  assert.equal(join.deadlineAt, undefined);
  assert.deepEqual(join.arrived, []);

  const log = readFileSync(honeyPaths(state, apiary, definition.id).log, 'utf8');
  assert.match(log, /merge\.timed-out/);
  assert.match(log, /merge\.failed/);
});

test('a queue-full trigger exits cleanly with the rejection reason', async () => {
  const state = stateDirectory();
  const project = projectDirectory();
  const composition = {
    schemaVersion: 1,
    id: 'cli-queue-max',
    defaults: { queueMax: 1 },
    nodes: {
      node: { kind: 'forager', config: { connection: 'codex', prompt: 'go {{input}}' } },
    },
    edges: [],
  };
  const compositionPath = compositionFile(composition);
  const definition = parseComposition(composition);
  const store = HoneyStore.forComposition(state, apiaryForProject(project), definition.id);
  store.save({
    schemaVersion: 1,
    compositionId: definition.id,
    graphRevision: definition.graphRevision,
    rest: false,
    nodes: {
      node: {
        queue: [
          {
            id: 'ph_full',
            traceId: 'tr_full',
            value: { kind: 'text' as const, text: 'already queued' },
            at: new Date().toISOString(),
          },
        ],
      },
    },
  });

  const adapter = new FakeAdapter({ output: 'OUT' });
  const captureResult = capture();
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
      '--trigger',
      'node',
      '--input',
      'rejected',
    ],
    withAdapter(adapter, captureResult),
  );

  assert.equal(code, 1, 'a rejected trigger is a clean exit, not a crash');
  const stderr = captureResult.stderr.join('\n');
  assert.match(stderr, /error:/);
  assert.match(stderr, /queue for node 'node' is full/);
  assert.match(stderr, /queueMax=1/);
  assert.match(stderr, /queueDepth=1/);
  assert.equal(adapter.startCalls, 1);
  assert.equal(adapter.stopCalls, 1, 'the CLI still shuts the adapter down after the rejection');
  assert.deepEqual(adapter.prompts, [], 'the rejected trigger never runs a prompt');
});
