import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { apiaryForProject, runCli } from '../src/cli/cli.js';
import { daemonLockState } from '../src/daemon/daemon-lock.js';
import { honeyPaths } from '../src/storage/honey.js';
import {
  runInspectCli,
  type InspectCliDependencies,
} from '../src/cli/inspect-cli.js';
import { parseComposition } from '../src/runtime/index.js';

const COMPOSITION = {
  schemaVersion: 1,
  id: 'inspect-demo',
  nodes: {
    start: {
      kind: 'forager',
      config: { connection: 'codex', prompt: 'hello {{input}}' },
    },
    ask: { kind: 'user', config: { modality: 'text', prompt: 'Approve?' } },
    gate: { kind: 'worker', config: { command: 'node' } },
    merge: {
      kind: 'merge',
      config: { required: ['a', 'b'], combine: 'text', timeoutMs: 5000 },
    },
  },
  edges: [
    { id: 'e1', from: 'start', to: 'ask' },
    { id: 'e2', from: 'ask', to: 'merge' },
  ],
};

interface Fixture {
  readonly root: string;
  readonly compositionPath: string;
  readonly stateDir: string;
  readonly projectDir: string;
}

interface Invocation {
  readonly code: number;
  readonly stdout: string[];
  readonly stderr: string[];
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'wax-inspect-'));
  const compositionPath = join(root, 'composition.json');
  writeFileSync(compositionPath, `${JSON.stringify(COMPOSITION, null, 2)}\n`);
  return {
    root,
    compositionPath,
    stateDir: mkdtempSync(join(root, 'state-')),
    projectDir: mkdtempSync(join(root, 'project-')),
  };
}

function revision(): string {
  return parseComposition(COMPOSITION).graphRevision;
}

function pathsOf(f: Fixture, apiary = apiaryForProject(f.projectDir)) {
  return honeyPaths(f.stateDir, apiary, 'inspect-demo');
}

function pheromone(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    traceId: `trace-${id}`,
    value: { kind: 'text', text: `body-${id}` },
    at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function hover(kind: 'user' | 'guard', nodeId: string, pheromoneId: string): Record<string, unknown> {
  return {
    token: `token-${nodeId}`,
    kind,
    compositionId: 'inspect-demo',
    nodeId,
    pheromoneId,
  };
}

function fieldFixture(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    compositionId: 'inspect-demo',
    graphRevision: revision(),
    rest: false,
    nodes: {
      start: {
        queue: [pheromone('q1'), pheromone('q2')],
        pending: pheromone('p1'),
        lastActivatedAt: '2026-01-01T00:00:00.000Z',
      },
      ask: {
        queue: [],
        hover: hover('user', 'ask', 'p2'),
        hoverPheromone: pheromone('p2'),
      },
      gate: {
        queue: [],
        active: pheromone('p3'),
        hover: hover('guard', 'gate', 'p4'),
        hoverPheromone: pheromone('p4'),
      },
      merge: {
        queue: [],
        joins: {
          fork1: {
            arrived: [pheromone('j1', { forkId: 'fork1', branchId: 'a' })],
            deadlineAt: 1_767_225_600_000,
          },
        },
      },
    },
  };
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeRaw(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function writeField(f: Fixture, value: unknown = fieldFixture()): string {
  const path = pathsOf(f).field;
  writeJson(path, value);
  return path;
}

function writeLog(f: Fixture, entries: readonly unknown[]): string {
  const path = pathsOf(f).log;
  writeRaw(path, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
  return path;
}

function writeTranscript(
  f: Fixture,
  conversationId: string,
  entries: readonly unknown[],
): string {
  const path = join(pathsOf(f).transcripts, `${conversationId}.jsonl`);
  writeRaw(path, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
  return path;
}

function invoke(
  args: readonly string[],
  deps: InspectCliDependencies = {},
): Invocation {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = runInspectCli(args, {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
    ...deps,
  });
  return { code, stdout, stderr };
}

function statusArgs(f: Fixture, extra: readonly string[] = []): string[] {
  return [
    'status',
    f.compositionPath,
    '--project',
    f.projectDir,
    '--state-dir',
    f.stateDir,
    ...extra,
  ];
}

function logArgs(f: Fixture, extra: readonly string[] = []): string[] {
  return [
    'log',
    f.compositionPath,
    '--project',
    f.projectDir,
    '--state-dir',
    f.stateDir,
    ...extra,
  ];
}

function honeyArgs(f: Fixture, conversationId: string, extra: readonly string[] = []): string[] {
  return [
    'honey',
    f.compositionPath,
    conversationId,
    '--project',
    f.projectDir,
    '--state-dir',
    f.stateDir,
    ...extra,
  ];
}

function statusJson(f: Fixture, extra: readonly string[] = []): Record<string, any> {
  const result = invoke(statusArgs(f, ['--json', ...extra]));
  assert.equal(result.code, 0, result.stderr.join('\n'));
  assert.deepEqual(result.stderr, []);
  assert.equal(result.stdout.length, 1);
  return JSON.parse(result.stdout[0] as string) as Record<string, any>;
}

function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
  assert.ok(child.pid !== undefined);
  return child.pid;
}

/** A stable fingerprint of every entry under `root`, including content. */
function snapshotTree(root: string): string {
  if (!existsSync(root)) {
    return '<absent>';
  }
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .map((relative) => {
      const path = join(root, relative);
      const stat = statSync(path);
      const body = stat.isDirectory()
        ? 'dir'
        : createHash('sha256').update(readFileSync(path, 'utf8')).digest('hex');
      return `${relative}|${body}|${String(stat.mtimeMs)}`;
    })
    .sort()
    .join('\n');
}

// --- status ---------------------------------------------------------------

test('status reports a missing field, exits 0 and creates nothing', () => {
  const f = fixture();
  const before = snapshotTree(f.stateDir);
  const paths = pathsOf(f);

  const status = statusJson(f);

  assert.equal(status.schemaVersion, 1);
  assert.equal(status.compositionId, 'inspect-demo');
  assert.equal(status.graphRevision, revision());
  assert.equal(status.state, 'missing');
  assert.equal(status.rest, true);
  assert.deepEqual(Object.keys(status.nodes), ['start', 'ask', 'gate', 'merge']);
  assert.deepEqual(status.nodes.start, {
    kind: 'forager',
    queueDepth: 0,
    pending: false,
    active: false,
    hover: null,
    lastActivatedAt: null,
    joins: 0,
  });
  assert.deepEqual(status.paths, {
    directory: paths.directory,
    field: paths.field,
    scheduler: paths.scheduler,
    log: paths.log,
    transcripts: paths.transcripts,
  });
  assert.equal(existsSync(paths.field), false);
  assert.equal(snapshotTree(f.stateDir), before);
});

test('status reports queue, pending, active, hovers and joins without bodies or tokens', () => {
  const f = fixture();
  writeField(f);
  const before = snapshotTree(f.stateDir);

  const status = statusJson(f);

  assert.equal(status.state, 'ok');
  assert.equal(status.rest, false);
  assert.deepEqual(Object.keys(status.nodes), ['start', 'ask', 'gate', 'merge']);
  assert.deepEqual(status.nodes.start, {
    kind: 'forager',
    queueDepth: 2,
    pending: true,
    active: false,
    hover: null,
    lastActivatedAt: '2026-01-01T00:00:00.000Z',
    joins: 0,
  });
  assert.equal(status.nodes.ask.kind, 'user');
  assert.equal(status.nodes.ask.pending, false);
  assert.equal(status.nodes.ask.active, false);
  assert.equal(status.nodes.ask.hover, 'user');
  assert.equal(status.nodes.gate.active, true);
  assert.equal(status.nodes.gate.hover, 'guard');
  assert.equal(status.nodes.merge.joins, 1);
  assert.deepEqual(status.scheduler, { state: 'absent', nextDueAt: null, fired: 0 });
  assert.deepEqual(status.daemon, {
    state: 'absent',
    pid: null,
    startedAt: null,
    error: null,
  });

  const text = JSON.stringify(status);
  for (const secret of [
    'body-q1',
    'body-p1',
    'body-p3',
    'token-ask',
    'token-gate',
    'hello {{input}}',
    'Approve?',
  ]) {
    assert.equal(text.includes(secret), false, `status leaked ${secret}`);
  }
  assert.equal(snapshotTree(f.stateDir), before);
});

test('status human output lists nodes in composition order and hides bodies', () => {
  const f = fixture();
  writeField(f);

  const result = invoke(statusArgs(f));

  assert.equal(result.code, 0);
  assert.deepEqual(result.stderr, []);
  const nodeLines = result.stdout.filter((line) => line.startsWith('node         '));
  assert.equal(nodeLines.length, 4);
  assert.match(nodeLines[0] as string, /start kind=forager queue=2 pending=yes active=no/);
  assert.match(nodeLines[3] as string, /^node         merge kind=merge /);
  const text = result.stdout.join('\n');
  assert.equal(text.includes('body-q1'), false);
  assert.equal(text.includes('token-ask'), false);
});

test('status reports scheduler nextDueAt and fired count', () => {
  const f = fixture();
  writeField(f);
  writeJson(pathsOf(f).scheduler, {
    schemaVersion: 1,
    triggers: {
      firedOnce: { kind: 'at', at: '2026-01-01T00:00:00.000Z', fired: true },
      later: { kind: 'at', at: '2030-01-01T00:00:00.000Z', fired: false },
      every: { kind: 'every', everyMs: 1000, nextDueMs: Date.parse('2029-01-01T00:00:00.000Z') },
    },
  });

  const status = statusJson(f);

  assert.deepEqual(status.scheduler, {
    state: 'ok',
    nextDueAt: '2029-01-01T00:00:00.000Z',
    fired: 1,
  });
});

test('status exits 1 when the field is not valid JSON', () => {
  const f = fixture();
  writeRaw(pathsOf(f).field, '{ not json');

  const result = invoke(statusArgs(f, ['--json']));

  assert.equal(result.code, 1);
  assert.deepEqual(result.stdout, []);
  assert.match(result.stderr.join('\n'), /field/);
  assert.match(result.stderr.join('\n'), /not valid JSON/);
});

test('status exits 1 when the field has an invalid shape', () => {
  const f = fixture();
  writeField(f, { schemaVersion: 2, compositionId: 'inspect-demo', nodes: {} });

  const result = invoke(statusArgs(f, ['--json']));

  assert.equal(result.code, 1);
  assert.deepEqual(result.stdout, []);
  assert.match(result.stderr.join('\n'), /schemaVersion/);
});

test('status exits 1 when scheduler state is corrupt', () => {
  const f = fixture();
  writeField(f);
  writeRaw(pathsOf(f).scheduler, '{ not json');

  const result = invoke(statusArgs(f, ['--json']));

  assert.equal(result.code, 1);
  assert.deepEqual(result.stdout, []);
  assert.match(result.stderr.join('\n'), /scheduler/);
});

test('status resolves the apiary from --project and --apiary wins', () => {
  const f = fixture();

  const projected = statusJson(f);
  const projectPaths = honeyPaths(
    f.stateDir,
    apiaryForProject(f.projectDir),
    'inspect-demo',
  );
  assert.equal(projected.paths.directory, projectPaths.directory);

  const explicit = invoke([
    'status',
    f.compositionPath,
    '--project',
    f.projectDir,
    '--apiary',
    'explicit-apiary',
    '--state-dir',
    f.stateDir,
    '--json',
  ]);
  assert.equal(explicit.code, 0);
  const explicitStatus = JSON.parse(explicit.stdout[0] as string) as Record<string, any>;
  assert.equal(
    explicitStatus.paths.directory,
    honeyPaths(f.stateDir, 'explicit-apiary', 'inspect-demo').directory,
  );
  assert.notEqual(explicitStatus.paths.directory, projected.paths.directory);
});

// --- daemon lock ----------------------------------------------------------

test('daemonLockState classifies absent, running, stale and invalid without touching the lock', () => {
  const directory = mkdtempSync(join(tmpdir(), 'wax-inspect-lock-'));
  const path = join(directory, 'daemon.lock');

  assert.deepEqual(daemonLockState(path), { state: 'absent' });
  assert.equal(existsSync(path), false);

  const runningText = `${JSON.stringify({
    pid: process.pid,
    nonce: 'live',
    startedAt: '2026-01-01T00:00:00.000Z',
    compositionId: 'inspect-demo',
  })}\n`;
  writeFileSync(path, runningText);
  const running = daemonLockState(path);
  assert.equal(running.state, 'running');
  if (running.state === 'running') {
    assert.equal(running.info.pid, process.pid);
    assert.equal(running.info.startedAt, '2026-01-01T00:00:00.000Z');
  }
  assert.equal(readFileSync(path, 'utf8'), runningText);

  writeFileSync(
    path,
    `${JSON.stringify({
      pid: deadPid(),
      nonce: 'stale',
      startedAt: '2026-01-01T00:00:00.000Z',
      compositionId: 'inspect-demo',
    })}\n`,
  );
  const stale = daemonLockState(path);
  assert.equal(stale.state, 'stale');
  if (stale.state === 'stale') {
    assert.ok(Number.isInteger(stale.info.pid));
  }
  assert.equal(existsSync(path), true);

  writeFileSync(path, '{ not json');
  const invalid = daemonLockState(path);
  assert.equal(invalid.state, 'invalid');
  if (invalid.state === 'invalid') {
    assert.match(invalid.error, /malformed/);
  }
  assert.equal(readFileSync(path, 'utf8'), '{ not json');
});

test('status reports a live daemon lock without modifying it', () => {
  const f = fixture();
  writeField(f);
  const lockPath = join(pathsOf(f).directory, 'daemon.lock');
  const text = `${JSON.stringify({
    pid: process.pid,
    nonce: 'live',
    startedAt: '2026-01-01T00:00:00.000Z',
    compositionId: 'inspect-demo',
  })}\n`;
  writeRaw(lockPath, text);
  const before = snapshotTree(f.stateDir);

  const status = statusJson(f);

  assert.deepEqual(status.daemon, {
    state: 'running',
    pid: process.pid,
    startedAt: '2026-01-01T00:00:00.000Z',
    error: null,
  });
  assert.equal(readFileSync(lockPath, 'utf8'), text);
  assert.equal(snapshotTree(f.stateDir), before);
});

test('status reports stale and invalid daemon locks without removing them', () => {
  const f = fixture();
  writeField(f);
  const lockPath = join(pathsOf(f).directory, 'daemon.lock');

  writeRaw(
    lockPath,
    `${JSON.stringify({
      pid: deadPid(),
      nonce: 'stale',
      startedAt: '2026-01-01T00:00:00.000Z',
      compositionId: 'inspect-demo',
    })}\n`,
  );
  const stale = statusJson(f);
  assert.equal(stale.daemon.state, 'stale');
  assert.ok(Number.isInteger(stale.daemon.pid));
  assert.equal(existsSync(lockPath), true);

  writeRaw(lockPath, '{ not json');
  const invalid = statusJson(f);
  assert.equal(invalid.daemon.state, 'invalid');
  assert.equal(invalid.daemon.pid, null);
  assert.match(String(invalid.daemon.error), /malformed/);
  assert.equal(readFileSync(lockPath, 'utf8'), '{ not json');
});

// --- log ------------------------------------------------------------------

test('log --json returns the last N entries in file order', () => {
  const f = fixture();
  const entries = Array.from({ length: 5 }, (_, index) => ({
    at: `2026-01-01T00:00:0${String(index)}.000Z`,
    event: 'node.completed',
    compositionId: 'inspect-demo',
    graphRevision: revision(),
    nodeId: 'start',
    outcome: `out-${String(index)}`,
  }));
  writeLog(f, entries);

  const result = invoke(logArgs(f, ['--tail', '3', '--json']));

  assert.equal(result.code, 0);
  assert.deepEqual(result.stderr, []);
  assert.equal(result.stdout.length, 1);
  const logged = JSON.parse(result.stdout[0] as string) as Record<string, any>[];
  assert.deepEqual(
    logged.map((entry) => entry.outcome),
    ['out-2', 'out-3', 'out-4'],
  );
});

test('log defaults to the last 20 entries and formats human metadata lines', () => {
  const f = fixture();
  const entries = Array.from({ length: 25 }, (_, index) => ({
    at: `2026-01-01T00:00:${String(index).padStart(2, '0')}.000Z`,
    event: 'pheromone.enqueued',
    nodeId: 'start',
    outcome: index % 2 === 0 ? 'accepted' : 'pending',
  }));
  writeLog(f, entries);

  const result = invoke(logArgs(f));

  assert.equal(result.code, 0);
  assert.equal(result.stdout.length, 20);
  assert.equal(
    result.stdout[0],
    '2026-01-01T00:00:05.000Z pheromone.enqueued node=start outcome=pending',
  );
  assert.equal(
    result.stdout[19],
    '2026-01-01T00:00:24.000Z pheromone.enqueued node=start outcome=accepted',
  );
});

test('log treats a missing file as empty and creates nothing', () => {
  const f = fixture();
  const before = snapshotTree(f.stateDir);

  const json = invoke(logArgs(f, ['--json']));
  assert.equal(json.code, 0);
  assert.deepEqual(json.stdout, ['[]']);
  assert.deepEqual(json.stderr, []);

  const human = invoke(logArgs(f));
  assert.equal(human.code, 0);
  assert.deepEqual(human.stdout, []);

  assert.equal(existsSync(pathsOf(f).log), false);
  assert.equal(snapshotTree(f.stateDir), before);
});

test('log exits 1 on a malformed line and names its line number', () => {
  const f = fixture();
  writeRaw(
    pathsOf(f).log,
    '{"at":"2026-01-01T00:00:00.000Z","event":"runtime.rest"}\n' +
      '{ not json\n' +
      '{"at":"2026-01-01T00:00:01.000Z","event":"runtime.rest"}\n',
  );

  const result = invoke(logArgs(f, ['--json']));

  assert.equal(result.code, 1);
  assert.deepEqual(result.stdout, []);
  assert.match(result.stderr.join('\n'), /log line 2/);
});

test('log --json projects only metadata fields, never a body field', () => {
  const f = fixture();
  writeLog(f, [
    {
      at: '2026-01-01T00:00:00.000Z',
      event: 'node.completed',
      nodeId: 'start',
      outcome: 'ok',
      prompt: 'SECRET-PROMPT',
      output: 'SECRET-OUTPUT',
    },
  ]);

  const result = invoke(logArgs(f, ['--json']));

  assert.equal(result.code, 0);
  const text = result.stdout.join('\n');
  assert.equal(text.includes('SECRET-PROMPT'), false);
  assert.equal(text.includes('SECRET-OUTPUT'), false);
  const logged = JSON.parse(result.stdout[0] as string) as Record<string, unknown>[];
  assert.deepEqual(logged, [
    {
      at: '2026-01-01T00:00:00.000Z',
      event: 'node.completed',
      nodeId: 'start',
      outcome: 'ok',
    },
  ]);
});

// --- honey ----------------------------------------------------------------

test('honey --json returns the transcript bodies and keeps tail order', () => {
  const f = fixture();
  const events = [
    { at: '2026-01-01T00:00:00.000Z', type: 'output', text: 'first message' },
    { at: '2026-01-01T00:00:01.000Z', type: 'tool', title: 'second event' },
    { at: '2026-01-01T00:00:02.000Z', type: 'output', text: 'third message' },
  ];
  writeTranscript(f, 'conv-1', events);

  const full = invoke(honeyArgs(f, 'conv-1', ['--json']));
  assert.equal(full.code, 0);
  assert.deepEqual(JSON.parse(full.stdout[0] as string), events);

  const tail = invoke(honeyArgs(f, 'conv-1', ['--tail', '1', '--json']));
  assert.equal(tail.code, 0);
  assert.deepEqual(JSON.parse(tail.stdout[0] as string), [events[2]]);
});

test('honey human output is the transcript JSONL verbatim', () => {
  const f = fixture();
  const events = [
    { at: '2026-01-01T00:00:00.000Z', type: 'output', text: 'hello' },
    { at: '2026-01-01T00:00:01.000Z', type: 'output', text: 'world' },
  ];
  writeTranscript(f, 'conv-1', events);

  const result = invoke(honeyArgs(f, 'conv-1'));

  assert.equal(result.code, 0);
  assert.deepEqual(result.stderr, []);
  assert.deepEqual(result.stdout, events.map((event) => JSON.stringify(event)));
});

test('honey exits 1 for a missing transcript and creates nothing', () => {
  const f = fixture();
  const before = snapshotTree(f.stateDir);

  const result = invoke(honeyArgs(f, 'missing-conv', ['--json']));

  assert.equal(result.code, 1);
  assert.deepEqual(result.stdout, []);
  assert.match(result.stderr.join('\n'), /no transcript for conversation 'missing-conv'/);
  assert.equal(snapshotTree(f.stateDir), before);
});

test('honey rejects an unsafe conversation id as a usage error', () => {
  const f = fixture();

  const result = invoke(honeyArgs(f, '../escape'));

  assert.equal(result.code, 2);
  assert.deepEqual(result.stdout, []);
  assert.match(result.stderr.join('\n'), /invalid conversation id/);
});

test('honey exits 1 on a malformed transcript line and names its line number', () => {
  const f = fixture();
  const path = join(pathsOf(f).transcripts, 'conv-1.jsonl');
  writeRaw(path, '{"at":"2026-01-01T00:00:00.000Z"}\nnot json\n');

  const result = invoke(honeyArgs(f, 'conv-1', ['--json']));

  assert.equal(result.code, 1);
  assert.deepEqual(result.stdout, []);
  assert.match(result.stderr.join('\n'), /transcript line 2/);
});

// --- cross-command --------------------------------------------------------

test('inspection never creates a missing state root', () => {
  const f = fixture();
  const missing = join(f.root, 'absent-state');

  const status = invoke([
    'status',
    f.compositionPath,
    '--project',
    f.projectDir,
    '--state-dir',
    missing,
    '--json',
  ]);
  assert.equal(status.code, 0);
  assert.equal(existsSync(missing), false);

  const log = invoke([
    'log',
    f.compositionPath,
    '--project',
    f.projectDir,
    '--state-dir',
    missing,
    '--json',
  ]);
  assert.equal(log.code, 0);
  assert.deepEqual(log.stdout, ['[]']);
  assert.equal(existsSync(missing), false);

  const honey = invoke([
    'honey',
    f.compositionPath,
    'conv-1',
    '--project',
    f.projectDir,
    '--state-dir',
    missing,
    '--json',
  ]);
  assert.equal(honey.code, 1);
  assert.equal(existsSync(missing), false);
});

test('status uses the injected default state root when --state-dir is omitted', () => {
  const f = fixture();

  const result = invoke(
    ['status', f.compositionPath, '--project', f.projectDir, '--json'],
    { defaultStateDir: f.stateDir },
  );

  assert.equal(result.code, 0);
  const status = JSON.parse(result.stdout[0] as string) as Record<string, any>;
  assert.equal(
    status['paths'].directory,
    honeyPaths(f.stateDir, apiaryForProject(f.projectDir), 'inspect-demo').directory,
  );
});

test('status, log and honey never change the state directory', () => {
  const f = fixture();
  writeField(f);
  writeLog(f, [
    { at: '2026-01-01T00:00:00.000Z', event: 'runtime.rest', nodeId: 'start' },
  ]);
  writeTranscript(f, 'conv-1', [
    { at: '2026-01-01T00:00:00.000Z', type: 'output', text: 'hello' },
  ]);
  const before = snapshotTree(f.stateDir);

  const status = invoke(statusArgs(f, ['--json']));
  const log = invoke(logArgs(f, ['--json']));
  const honey = invoke(honeyArgs(f, 'conv-1', ['--json']));

  assert.equal(status.code, 0, status.stderr.join('\n'));
  assert.equal(log.code, 0, log.stderr.join('\n'));
  assert.equal(honey.code, 0, honey.stderr.join('\n'));
  assert.equal(snapshotTree(f.stateDir), before);
});

test('inspection usage errors exit 2 and never touch the state directory', () => {
  const f = fixture();
  const before = snapshotTree(f.stateDir);
  const cases: readonly string[][] = [
    // Neither --project nor --apiary.
    ['status', f.compositionPath, '--state-dir', f.stateDir],
    // --tail belongs to log and honey only.
    [
      'status',
      f.compositionPath,
      '--project',
      f.projectDir,
      '--state-dir',
      f.stateDir,
      '--tail',
      '1',
    ],
    // Zero is not a positive tail.
    [
      'log',
      f.compositionPath,
      '--project',
      f.projectDir,
      '--state-dir',
      f.stateDir,
      '--tail',
      '0',
    ],
    // honey needs the conversation id.
    ['honey', f.compositionPath, '--project', f.projectDir, '--state-dir', f.stateDir],
  ];

  for (const args of cases) {
    const result = invoke(args);
    assert.equal(result.code, 2, args.join(' '));
    assert.deepEqual(result.stdout, []);
    assert.ok(result.stderr.length > 0, args.join(' '));
  }
  assert.equal(snapshotTree(f.stateDir), before);
});

test('runCli dispatches status without starting a runtime or adapter', async () => {
  const f = fixture();
  const stdout: string[] = [];
  const stderr: string[] = [];

  const code = await runCli(
    ['status', f.compositionPath, '--project', f.projectDir, '--state-dir', f.stateDir, '--json'],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
  );

  assert.equal(code, 0);
  assert.deepEqual(stderr, []);
  assert.equal(stdout.length, 1);
  const status = JSON.parse(stdout[0] as string) as Record<string, unknown>;
  assert.equal(status['state'], 'missing');
});
