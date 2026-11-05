import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CliUsageError, parseRunArgs, runCli, type CliDependencies } from '../src/cli.js';
import { FakeAdapter, type FakeAdapterOptions } from './support/fake-adapter.js';

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

function compositionFile(contents: unknown = COMPOSITION): string {
  const directory = mkdtempSync(join(tmpdir(), 'wax-cli-composition-'));
  const path = join(directory, 'composition.json');
  writeFileSync(path, JSON.stringify(contents));
  return path;
}

function projectDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'wax-cli-project-'));
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
  ]);

  assert.equal(command.compositionPath, 'composition.json');
  assert.equal(command.projectDirectory, 'C:/work');
  assert.equal(command.harness, 'codex');
  assert.equal(command.trigger, 'start');
  assert.equal(command.input, 'hello world');
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

test('input defaults to an empty string', () => {
  const command = parseRunArgs(['run', 'c.json', '--project', 'p', '--harness', 'codex', '--trigger', 'start']);
  assert.equal(command.input, '');
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

test('runs a composition to Rest through the fake adapter', async () => {
  const adapter = new FakeAdapter({ output: 'CLI-OK' });
  const captureResult = capture();

  const code = await runCli(
    ['run', compositionFile(), '--project', projectDirectory(), '--harness', 'codex', '--trigger', 'start', '--input', 'hi'],
    withAdapter(adapter, captureResult),
  );

  assert.equal(code, 0);
  assert.ok(captureResult.stdout.includes('composition  cli-demo'));
  assert.ok(captureResult.stdout.includes('rest         true'));
  assert.ok(captureResult.stdout.includes('output       CLI-OK'));
  assert.ok(captureResult.stdout.some((line) => line.startsWith('log          ')));
  assert.deepEqual(adapter.prompts, ['reply to hi']);
  assert.equal(adapter.stopCalls, 1);
  assert.deepEqual(captureResult.stderr, []);
});

test('an approval handler is consulted and never auto-allowed', async () => {
  const adapter = new FakeAdapter({ askApproval: true, output: 'DONE' });
  const captureResult = capture();

  const code = await runCli(
    ['run', compositionFile(), '--project', projectDirectory(), '--harness', 'codex', '--trigger', 'start'],
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
    ['run', compositionFile(), '--project', projectDirectory(), '--harness', 'codex', '--trigger', 'ghost'],
    withAdapter(adapter, first),
  );
  const nonForager = await runCli(
    [
      'run',
      compositionFile(BRANCHING_COMPOSITION),
      '--project',
      projectDirectory(),
      '--harness',
      'codex',
      '--trigger',
      'check',
    ],
    withAdapter(adapter, second),
  );

  assert.equal(unknown, 2);
  assert.match(first.stderr.join('\n'), /unknown trigger node 'ghost'/);
  assert.equal(nonForager, 2);
  assert.match(second.stderr.join('\n'), /must be a forager node/);
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
    ['run', compositionFile(), '--project', projectDirectory(), '--harness', 'codex', '--trigger', 'start'],
    withAdapter(adapter, captureResult),
  );

  assert.equal(code, 1);
  assert.match(captureResult.stderr.join('\n'), /native exploded/);
  assert.ok(captureResult.stdout.includes('rest         true'));
  assert.ok(captureResult.stdout.includes('output       '));
});

test('an invalid composition file exits with a usage code', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'wax-cli-bad-'));
  const path = join(directory, 'broken.json');
  writeFileSync(path, '{ not json');
  const captureResult = capture();

  const code = await runCli(
    ['run', path, '--project', projectDirectory(), '--harness', 'codex', '--trigger', 'start'],
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
    ['run', compositionFile(), '--project', missing, '--harness', 'codex', '--trigger', 'start'],
    withAdapter(adapter, captureResult),
  );

  assert.equal(code, 1);
  assert.match(captureResult.stderr.join('\n'), /error:/);
  assert.equal(adapter.stopCalls, 1);
});
