import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { apiaryForProject, CliUsageError, parseRunArgs, runCli, type CliDependencies } from '../src/cli.js';
import { honeyPaths } from '../src/honey.js';
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
  assert.match(second.stderr.join('\n'), /must be a forager or user node/);
});

test('the dsh harness is rejected until its bridge exists', async () => {
  const withoutRoot = capture();
  const withRoot = capture();

  const first = await runCli(
    ['run', compositionFile(), '--project', projectDirectory(), '--harness', 'dsh', '--trigger', 'start'],
    withoutRoot.deps,
  );
  const second = await runCli(
    [
      'run',
      compositionFile(),
      '--project',
      projectDirectory(),
      '--harness',
      'dsh',
      '--dsh-root',
      projectDirectory(),
      '--trigger',
      'start',
    ],
    withRoot.deps,
  );

  assert.equal(first, 2);
  assert.match(withoutRoot.stderr.join('\n'), /requires --dsh-root/);
  assert.equal(second, 2);
  assert.match(withRoot.stderr.join('\n'), /not wired in Stage 2A/);
});

test('--codex-exe is rejected for the dsh harness', async () => {
  const captureResult = capture();

  const code = await runCli(
    [
      'run',
      compositionFile(),
      '--project',
      projectDirectory(),
      '--harness',
      'dsh',
      '--dsh-root',
      projectDirectory(),
      '--codex-exe',
      'C:/tools/codex.exe',
      '--trigger',
      'start',
    ],
    captureResult.deps,
  );

  assert.equal(code, 2);
  assert.match(captureResult.stderr.join('\n'), /only applies to --harness codex/);
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
