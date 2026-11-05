import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import test from 'node:test';

import { runCli } from '../src/cli.js';
import {
  runCompositionCli,
  type CompositionCliDependencies,
} from '../src/composition-cli.js';
import { compositionAuditPath, replaceComposition } from '../src/composition-edit.js';
import { isProcessAlive } from '../src/daemon-lock.js';
import { honeyPaths } from '../src/honey.js';
import { parseComposition } from '../src/runtime/index.js';

const CURRENT_COMPOSITION = {
  schemaVersion: 1,
  id: 'edit-demo',
  nodes: {
    start: {
      kind: 'forager',
      config: { connection: 'codex', prompt: 'old {{input}}' },
    },
  },
  edges: [],
};

const NEXT_COMPOSITION = {
  schemaVersion: 1,
  id: 'edit-demo',
  nodes: {
    start: {
      kind: 'forager',
      config: { connection: 'codex', prompt: 'new {{input}}' },
    },
  },
  edges: [],
};

interface CompositionFiles {
  readonly directory: string;
  readonly currentPath: string;
  readonly nextPath: string;
  readonly currentText: string;
  readonly nextText: string;
}

interface Capture {
  readonly stdout: string[];
  readonly stderr: string[];
  readonly deps: CompositionCliDependencies;
}

function writeCompositionPair(
  current: unknown = CURRENT_COMPOSITION,
  next: unknown = NEXT_COMPOSITION,
): CompositionFiles {
  const directory = mkdtempSync(join(tmpdir(), 'wax-composition-edit-'));
  const currentText = `${JSON.stringify(current, null, 2)}\n`;
  const nextText = `${JSON.stringify(next, null, 2)}\n`;
  const currentPath = join(directory, 'composition.json');
  const nextPath = join(directory, 'next.json');
  writeFileSync(currentPath, currentText);
  writeFileSync(nextPath, nextText);
  return { directory, currentPath, nextPath, currentText, nextText };
}

function stateDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'wax-composition-state-'));
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

function revisionOf(value: unknown): string {
  return parseComposition(value).graphRevision;
}

function auditLines(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) {
    return [];
  }
  const text = readFileSync(path, 'utf8').trim();
  if (text === '') {
    return [];
  }
  return text
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function pheromone(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ph_1',
    traceId: 'tr_1',
    value: { kind: 'text', text: 'payload' },
    at: '2026-03-01T00:00:00.000Z',
    ...overrides,
  };
}

function writeField(
  stateDir: string,
  apiary: string,
  compositionId: string,
  nodes: unknown,
  options: { readonly graphRevision?: string; readonly rest?: boolean } = {},
): string {
  const paths = honeyPaths(stateDir, apiary, compositionId);
  mkdirSync(dirname(paths.field), { recursive: true });
  const field = {
    schemaVersion: 1,
    compositionId,
    graphRevision: options.graphRevision ?? 'field-revision',
    rest: options.rest ?? false,
    nodes,
  };
  writeFileSync(paths.field, `${JSON.stringify(field, null, 2)}\n`);
  return paths.field;
}

function writeLock(
  stateDir: string,
  apiary: string,
  compositionId: string,
  pid: number,
): string {
  const path = join(
    honeyPaths(stateDir, apiary, compositionId).directory,
    'daemon.lock',
  );
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify({
      pid,
      nonce: 'test-nonce',
      startedAt: new Date().toISOString(),
      compositionId,
    })}\n`,
  );
  return path;
}

function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
  assert.ok(child.pid !== undefined);
  return child.pid;
}

const ACTIVE_REFERENCE_CASES: ReadonlyArray<{
  readonly name: string;
  readonly nodes: Record<string, unknown>;
  readonly reason: string;
}> = [
  {
    name: 'queue',
    reason: 'queue',
    nodes: { start: { queue: [pheromone()] } },
  },
  {
    name: 'pending',
    reason: 'pending',
    nodes: { start: { queue: [], pending: pheromone() } },
  },
  {
    name: 'active',
    reason: 'active',
    nodes: { start: { queue: [], active: pheromone() } },
  },
  {
    name: 'hover',
    reason: 'hover',
    nodes: {
      start: {
        queue: [],
        hover: {
          token: 'hv_1',
          kind: 'user',
          compositionId: 'edit-demo',
          nodeId: 'start',
          pheromoneId: 'ph_1',
        },
      },
    },
  },
  {
    name: 'merge join',
    reason: 'merge-waiting',
    nodes: {
      start: {
        queue: [],
        joins: {
          fk_1: {
            arrived: [pheromone({ forkId: 'fk_1', branchId: 'a' })],
            deadlineAt: Date.parse('2026-03-02T00:00:00.000Z'),
          },
        },
      },
    },
  },
];

test('runCli dispatches composition validate and writes nothing', async () => {
  const files = writeCompositionPair();
  const before = readdirSync(files.directory).sort();
  const result = capture();

  const code = await runCli(
    ['composition', 'validate', files.currentPath],
    result.deps,
  );

  assert.equal(code, 0);
  assert.deepEqual(result.stdout, [
    'composition  edit-demo',
    `revision     ${revisionOf(CURRENT_COMPOSITION)}`,
    'valid        true',
  ]);
  assert.deepEqual(result.stderr, []);
  assert.deepEqual(readdirSync(files.directory).sort(), before);
  assert.equal(readFileSync(files.currentPath, 'utf8'), files.currentText);
});

test('validate rejects broken JSON with exit 2 and no writes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'wax-composition-edit-'));
  const path = join(directory, 'broken.json');
  const text = '{ not json';
  writeFileSync(path, text);
  const before = readdirSync(directory).sort();
  const result = capture();

  const code = runCompositionCli(
    ['composition', 'validate', path],
    result.deps,
  );

  assert.equal(code, 2);
  assert.match(result.stderr.join('\n'), /not valid JSON/);
  assert.deepEqual(readdirSync(directory).sort(), before);
  assert.equal(readFileSync(path, 'utf8'), text);
});

test('validate rejects an invalid composition with exit 2 and no writes', () => {
  const files = writeCompositionPair({
    schemaVersion: 1,
    id: 'edit-demo',
    nodes: { start: { kind: 'unknown-kind', config: {} } },
    edges: [],
  });
  const before = readdirSync(files.directory).sort();
  const result = capture();

  const code = runCompositionCli(
    ['composition', 'validate', files.currentPath],
    result.deps,
  );

  assert.equal(code, 2);
  assert.match(result.stderr.join('\n'), /invalid composition/);
  assert.deepEqual(readdirSync(files.directory).sort(), before);
  assert.equal(readFileSync(files.currentPath, 'utf8'), files.currentText);
});

test('composition usage errors exit 2 and never touch files', () => {
  const cases: readonly (readonly string[])[] = [
    ['composition'],
    ['composition', 'validate'],
    ['composition', 'validate', 'a.json', 'b.json'],
    ['composition', 'validate', 'a.json', '--state-dir', 'x'],
    ['composition', 'replace', 'a.json'],
    ['composition', 'replace', 'a.json', '--with'],
    ['composition', 'replace', 'a.json', '--with', 'b.json', '--force'],
    ['composition', 'replace', 'a.json', '--with', 'b.json', '--with', 'c.json'],
  ];

  for (const argv of cases) {
    const result = capture();
    assert.equal(runCompositionCli(argv, result.deps), 2, argv.join(' '));
    assert.notDeepEqual(result.stderr, [], argv.join(' '));
  }
});

test('replace has no force option in 4A', () => {
  const result = capture();

  const code = runCompositionCli(
    ['composition', 'replace', 'c.json', '--with', 'n.json', '--force'],
    result.deps,
  );

  assert.equal(code, 2);
  assert.match(result.stderr.join('\n'), /unknown option '--force'/);
});

test('replace changes the file, reports revisions and appends one audit line', async () => {
  const files = writeCompositionPair();
  const state = stateDirectory();
  const result = capture();
  const oldRevision = revisionOf(CURRENT_COMPOSITION);
  const newRevision = revisionOf(NEXT_COMPOSITION);

  const code = await runCli(
    [
      'composition',
      'replace',
      files.currentPath,
      '--with',
      files.nextPath,
      '--state-dir',
      state,
    ],
    result.deps,
  );

  assert.equal(code, 0);
  assert.notEqual(oldRevision, newRevision);
  assert.equal(readFileSync(files.currentPath, 'utf8'), files.nextText);
  assert.ok(result.stdout.includes(`revision     ${oldRevision} -> ${newRevision}`));
  assert.ok(
    result.stdout.some((line) => line.startsWith('active references not checked')),
  );

  const auditPath = compositionAuditPath(state);
  assert.ok(result.stdout.includes(`audit        ${auditPath}`));
  const lines = auditLines(auditPath);
  assert.equal(lines.length, 1);
  const entry = lines[0];
  assert.ok(entry !== undefined);
  assert.deepEqual(
    Object.keys(entry).sort(),
    ['at', 'compositionId', 'file', 'mode', 'newRevision', 'oldRevision'].sort(),
  );
  assert.equal(entry['compositionId'], 'edit-demo');
  assert.equal(entry['oldRevision'], oldRevision);
  assert.equal(entry['newRevision'], newRevision);
  assert.equal(entry['file'], resolve(files.currentPath));
  assert.equal(entry['mode'], 'replace');
  assert.equal(typeof entry['at'], 'string');
  assert.equal(Number.isNaN(Date.parse(String(entry['at']))), false);
  assert.equal(readFileSync(auditPath, 'utf8').includes('new {{input}}'), false);
  assert.deepEqual(
    readdirSync(files.directory).filter((name) => name.includes('.tmp-')),
    [],
  );
});

test('each successful replace appends exactly one audit line', () => {
  const files = writeCompositionPair();
  const state = stateDirectory();
  const third = {
    ...NEXT_COMPOSITION,
    nodes: {
      start: {
        kind: 'forager',
        config: { connection: 'codex', prompt: 'third' },
      },
    },
  };
  const thirdPath = join(files.directory, 'third.json');
  const thirdText = `${JSON.stringify(third, null, 2)}\n`;
  writeFileSync(thirdPath, thirdText);

  const first = capture();
  assert.equal(
    runCompositionCli(
      [
        'composition',
        'replace',
        files.currentPath,
        '--with',
        files.nextPath,
        '--state-dir',
        state,
      ],
      first.deps,
    ),
    0,
  );
  const second = capture();
  assert.equal(
    runCompositionCli(
      [
        'composition',
        'replace',
        files.currentPath,
        '--with',
        thirdPath,
        '--state-dir',
        state,
      ],
      second.deps,
    ),
    0,
  );

  const lines = auditLines(compositionAuditPath(state));
  assert.equal(lines.length, 2);
  assert.equal(lines[0]?.['oldRevision'], revisionOf(CURRENT_COMPOSITION));
  assert.equal(lines[0]?.['newRevision'], revisionOf(NEXT_COMPOSITION));
  assert.equal(lines[1]?.['oldRevision'], revisionOf(NEXT_COMPOSITION));
  assert.equal(lines[1]?.['newRevision'], revisionOf(third));
  assert.equal(readFileSync(files.currentPath, 'utf8'), thirdText);
});

test('replace refuses a different composition id without writing', () => {
  const other = { ...NEXT_COMPOSITION, id: 'other-composition' };
  const files = writeCompositionPair(CURRENT_COMPOSITION, other);
  const state = stateDirectory();
  const result = capture();

  const code = runCompositionCli(
    [
      'composition',
      'replace',
      files.currentPath,
      '--with',
      files.nextPath,
      '--state-dir',
      state,
    ],
    result.deps,
  );

  assert.equal(code, 2);
  assert.match(result.stderr.join('\n'), /composition id mismatch/);
  assert.equal(readFileSync(files.currentPath, 'utf8'), files.currentText);
  assert.deepEqual(auditLines(compositionAuditPath(state)), []);
});

test('replace refuses an unparseable next file without writing', () => {
  const files = writeCompositionPair();
  writeFileSync(files.nextPath, '{ not json');
  const state = stateDirectory();
  const result = capture();

  const code = runCompositionCli(
    [
      'composition',
      'replace',
      files.currentPath,
      '--with',
      files.nextPath,
      '--state-dir',
      state,
    ],
    result.deps,
  );

  assert.equal(code, 2);
  assert.match(result.stderr.join('\n'), /not valid JSON/);
  assert.equal(readFileSync(files.currentPath, 'utf8'), files.currentText);
  assert.deepEqual(auditLines(compositionAuditPath(state)), []);
});

for (const activeCase of ACTIVE_REFERENCE_CASES) {
  test(`replace refuses an active ${activeCase.name} reference`, () => {
    const files = writeCompositionPair();
    const state = stateDirectory();
    writeField(state, 'demo', 'edit-demo', activeCase.nodes);
    const result = capture();

    const code = runCompositionCli(
      [
        'composition',
        'replace',
        files.currentPath,
        '--with',
        files.nextPath,
        '--state-dir',
        state,
        '--apiary',
        'demo',
      ],
      result.deps,
    );

    assert.equal(code, 2);
    assert.match(result.stderr.join('\n'), /active references exist/);
    assert.ok(
      result.stderr.join('\n').includes(`start(${activeCase.reason})`),
      `missing ${activeCase.reason} reference`,
    );
    assert.equal(readFileSync(files.currentPath, 'utf8'), files.currentText);
    assert.deepEqual(auditLines(compositionAuditPath(state)), []);
  });
}

test('replace allows a Honey field whose only join is a completed tombstone', () => {
  const files = writeCompositionPair();
  const state = stateDirectory();
  writeField(
    state,
    'demo',
    'edit-demo',
    {
      start: {
        queue: [],
        joins: {
          fk_done: {
            arrived: [],
            completedAt: '2026-03-01T00:00:00.000Z',
          },
        },
      },
    },
    { rest: true },
  );
  const result = capture();

  const code = runCompositionCli(
    [
      'composition',
      'replace',
      files.currentPath,
      '--with',
      files.nextPath,
      '--state-dir',
      state,
      '--apiary',
      'demo',
    ],
    result.deps,
  );

  assert.equal(code, 0, result.stderr.join('\n'));
  assert.equal(readFileSync(files.currentPath, 'utf8'), files.nextText);
});

test('replace allows a Honey field whose only join is a timed-out tombstone', () => {
  const files = writeCompositionPair();
  const state = stateDirectory();
  writeField(
    state,
    'demo',
    'edit-demo',
    {
      start: {
        queue: [],
        joins: {
          fk_timed_out: {
            arrived: [],
            timedOutAt: '2026-03-01T00:00:00.000Z',
          },
        },
      },
    },
    { rest: true },
  );
  const result = capture();

  const code = runCompositionCli(
    [
      'composition',
      'replace',
      files.currentPath,
      '--with',
      files.nextPath,
      '--state-dir',
      state,
      '--apiary',
      'demo',
    ],
    result.deps,
  );

  assert.equal(code, 0, result.stderr.join('\n'));
  assert.equal(readFileSync(files.currentPath, 'utf8'), files.nextText);
});

test('replace allows a Honey field with no active references and writes no needsAttention', () => {
  const files = writeCompositionPair();
  const state = stateDirectory();
  const fieldPath = writeField(
    state,
    'demo',
    'edit-demo',
    {
      start: {
        queue: [],
        lastActivatedAt: '2026-03-01T00:00:00.000Z',
        state: {},
      },
    },
    { rest: true },
  );
  const before = readFileSync(fieldPath, 'utf8');
  const result = capture();

  const code = runCompositionCli(
    [
      'composition',
      'replace',
      files.currentPath,
      '--with',
      files.nextPath,
      '--state-dir',
      state,
      '--apiary',
      'demo',
    ],
    result.deps,
  );

  assert.equal(code, 0);
  assert.ok(result.stdout.includes('active references checked (none)'));
  assert.equal(readFileSync(fieldPath, 'utf8'), before);
  assert.equal(before.includes('needsAttention'), false);
});

test('replace with --apiary but no Honey field says references were not checked', () => {
  const files = writeCompositionPair();
  const state = stateDirectory();
  const result = capture();

  const code = runCompositionCli(
    [
      'composition',
      'replace',
      files.currentPath,
      '--with',
      files.nextPath,
      '--state-dir',
      state,
      '--apiary',
      'demo',
    ],
    result.deps,
  );

  assert.equal(code, 0);
  assert.match(result.stdout.join('\n'), /active references not checked/);
  assert.match(result.stdout.join('\n'), /no Honey field/);
  assert.equal(readFileSync(files.currentPath, 'utf8'), files.nextText);
});

test('replace without --state-dir says active references were not checked', () => {
  const files = writeCompositionPair();
  const state = stateDirectory();
  const result = capture();

  const code = runCompositionCli(
    ['composition', 'replace', files.currentPath, '--with', files.nextPath],
    { ...result.deps, defaultStateDir: state },
  );

  assert.equal(code, 0);
  assert.match(result.stdout.join('\n'), /active references not checked/);
  assert.equal(readFileSync(files.currentPath, 'utf8'), files.nextText);
  assert.equal(auditLines(compositionAuditPath(state)).length, 1);
});

test('replace refuses a live daemon lock and keeps it', () => {
  const files = writeCompositionPair();
  const state = stateDirectory();
  const lockPath = writeLock(state, 'demo', 'edit-demo', process.pid);
  const before = readFileSync(lockPath, 'utf8');
  const result = capture();

  const code = runCompositionCli(
    [
      'composition',
      'replace',
      files.currentPath,
      '--with',
      files.nextPath,
      '--state-dir',
      state,
      '--apiary',
      'demo',
    ],
    result.deps,
  );

  assert.equal(code, 2);
  assert.match(result.stderr.join('\n'), /daemon lock/);
  assert.match(result.stderr.join('\n'), /live pid/);
  assert.equal(readFileSync(files.currentPath, 'utf8'), files.currentText);
  assert.equal(readFileSync(lockPath, 'utf8'), before);
  assert.deepEqual(auditLines(compositionAuditPath(state)), []);
});

test('replace leaves a deterministic stale daemon lock in place', () => {
  const files = writeCompositionPair();
  const state = stateDirectory();
  const pid = deadPid();
  assert.equal(isProcessAlive(pid), false);
  const lockPath = writeLock(state, 'demo', 'edit-demo', pid);
  const before = readFileSync(lockPath, 'utf8');
  const result = capture();

  const code = runCompositionCli(
    [
      'composition',
      'replace',
      files.currentPath,
      '--with',
      files.nextPath,
      '--state-dir',
      state,
      '--apiary',
      'demo',
    ],
    result.deps,
  );

  assert.equal(code, 0);
  assert.match(result.stdout.join('\n'), /stale, left in place/);
  assert.equal(readFileSync(files.currentPath, 'utf8'), files.nextText);
  assert.equal(readFileSync(lockPath, 'utf8'), before);
});

test('replace refuses a malformed daemon lock instead of stealing it', () => {
  const files = writeCompositionPair();
  const state = stateDirectory();
  const lockPath = join(
    honeyPaths(state, 'demo', 'edit-demo').directory,
    'daemon.lock',
  );
  mkdirSync(dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, '{ not json');
  const result = capture();

  const code = runCompositionCli(
    [
      'composition',
      'replace',
      files.currentPath,
      '--with',
      files.nextPath,
      '--state-dir',
      state,
      '--apiary',
      'demo',
    ],
    result.deps,
  );

  assert.equal(code, 2);
  assert.match(result.stderr.join('\n'), /malformed/);
  assert.equal(readFileSync(files.currentPath, 'utf8'), files.currentText);
  assert.equal(readFileSync(lockPath, 'utf8'), '{ not json');
  assert.deepEqual(auditLines(compositionAuditPath(state)), []);
});

test('replace refuses an unreadable Honey field instead of assuming no references', () => {
  const files = writeCompositionPair();
  const state = stateDirectory();
  const paths = honeyPaths(state, 'demo', 'edit-demo');
  mkdirSync(dirname(paths.field), { recursive: true });
  writeFileSync(paths.field, '{ not json');
  const result = capture();

  const code = runCompositionCli(
    [
      'composition',
      'replace',
      files.currentPath,
      '--with',
      files.nextPath,
      '--state-dir',
      state,
      '--apiary',
      'demo',
    ],
    result.deps,
  );

  assert.equal(code, 2);
  assert.match(result.stderr.join('\n'), /cannot verify active references/);
  assert.equal(readFileSync(files.currentPath, 'utf8'), files.currentText);
});

test('replace writes a complete same-directory temp file before renaming', () => {
  const files = writeCompositionPair();
  const state = stateDirectory();
  let tempPath: string | undefined;
  let oldAtRename: string | undefined;
  let completeAtRename: string | undefined;

  const result = replaceComposition(
    { file: files.currentPath, withFile: files.nextPath, stateDir: state },
    {
      rename: (from, to) => {
        tempPath = from;
        oldAtRename = readFileSync(to, 'utf8');
        completeAtRename = readFileSync(from, 'utf8');
        renameSync(from, to);
      },
    },
  );

  assert.ok(tempPath !== undefined);
  assert.equal(dirname(tempPath), dirname(files.currentPath));
  assert.equal(basename(tempPath).startsWith('.composition.json.tmp-'), true);
  assert.equal(oldAtRename, files.currentText);
  assert.equal(completeAtRename, files.nextText);
  assert.equal(readFileSync(files.currentPath, 'utf8'), files.nextText);
  assert.equal(result.activeReferences.status, 'not-checked');
  assert.equal(auditLines(compositionAuditPath(state)).length, 1);
});

test('a failed temp write preserves the old composition and exits 1', () => {
  const files = writeCompositionPair();
  const state = stateDirectory();
  const result = capture();

  const code = runCompositionCli(
    [
      'composition',
      'replace',
      files.currentPath,
      '--with',
      files.nextPath,
      '--state-dir',
      state,
    ],
    {
      ...result.deps,
      edit: {
        writeTemp: () => {
          throw new Error('disk full');
        },
      },
    },
  );

  assert.equal(code, 1);
  assert.match(result.stderr.join('\n'), /disk full/);
  assert.equal(readFileSync(files.currentPath, 'utf8'), files.currentText);
  assert.deepEqual(auditLines(compositionAuditPath(state)), []);
  assert.deepEqual(
    readdirSync(files.directory).filter((name) => name.includes('.tmp-')),
    [],
  );
});

test('a failed rename preserves the old composition and exits 1', () => {
  const files = writeCompositionPair();
  const state = stateDirectory();
  const result = capture();

  const code = runCompositionCli(
    [
      'composition',
      'replace',
      files.currentPath,
      '--with',
      files.nextPath,
      '--state-dir',
      state,
    ],
    {
      ...result.deps,
      edit: {
        rename: () => {
          throw new Error('rename denied');
        },
      },
    },
  );

  assert.equal(code, 1);
  assert.match(result.stderr.join('\n'), /rename denied/);
  assert.equal(readFileSync(files.currentPath, 'utf8'), files.currentText);
  assert.deepEqual(auditLines(compositionAuditPath(state)), []);
  assert.deepEqual(
    readdirSync(files.directory).filter((name) => name.includes('.tmp-')),
    [],
  );
});

test('an audit write failure after the rename exits 1 and says the file was replaced', () => {
  const files = writeCompositionPair();
  const state = stateDirectory();
  const result = capture();

  const code = runCompositionCli(
    [
      'composition',
      'replace',
      files.currentPath,
      '--with',
      files.nextPath,
      '--state-dir',
      state,
    ],
    {
      ...result.deps,
      edit: {
        appendAudit: () => {
          throw new Error('audit denied');
        },
      },
    },
  );

  assert.equal(code, 1);
  assert.match(result.stderr.join('\n'), /was replaced, but the revision audit/);
  assert.equal(readFileSync(files.currentPath, 'utf8'), files.nextText);
  assert.deepEqual(auditLines(compositionAuditPath(state)), []);
});
