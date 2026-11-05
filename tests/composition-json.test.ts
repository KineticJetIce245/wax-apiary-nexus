import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  runCompositionCli,
  type CompositionCliDependencies,
} from '../src/composition-cli.js';
import { compositionAuditPath } from '../src/composition-edit.js';
import {
  compositionToolExitCode,
  compositionToolFailure,
} from '../src/composition-tool.js';
import { honeyPaths } from '../src/honey.js';
import { parseComposition } from '../src/runtime/index.js';

const CURRENT_COMPOSITION = {
  schemaVersion: 1,
  id: 'json-demo',
  nodes: {
    start: {
      kind: 'forager',
      config: { connection: 'codex', prompt: 'SECRET-OLD-PROMPT {{input}}' },
    },
  },
  edges: [],
};

const NEXT_COMPOSITION = {
  schemaVersion: 1,
  id: 'json-demo',
  nodes: {
    start: {
      kind: 'forager',
      config: { connection: 'codex', prompt: 'SECRET-NEW-PROMPT {{input}}' },
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

function writeCompositionPair(): CompositionFiles {
  const directory = mkdtempSync(join(tmpdir(), 'wax-composition-json-'));
  const currentText = `${JSON.stringify(CURRENT_COMPOSITION, null, 2)}\n`;
  const nextText = `${JSON.stringify(NEXT_COMPOSITION, null, 2)}\n`;
  const currentPath = join(directory, 'composition.json');
  const nextPath = join(directory, 'next.json');
  writeFileSync(currentPath, currentText);
  writeFileSync(nextPath, nextText);
  return { directory, currentPath, nextPath, currentText, nextText };
}

function stateDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'wax-composition-json-state-'));
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

/** Asserts stdout is exactly one JSON object and returns it. */
function soleJsonObject(result: Capture): Record<string, unknown> {
  assert.deepEqual(result.stderr, [], 'JSON mode must not write to stderr');
  assert.equal(result.stdout.length, 1, 'JSON mode must write exactly one line');
  const line = result.stdout[0];
  assert.ok(line !== undefined);
  assert.equal(line.includes('\n'), false);
  assert.equal(line.startsWith('{'), true);
  assert.equal(line.endsWith('}'), true);
  const parsed: unknown = JSON.parse(line);
  assert.ok(typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed));
  return parsed as Record<string, unknown>;
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
  return text.split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
}

function writeField(
  stateDir: string,
  apiary: string,
  compositionId: string,
  nodes: unknown,
  options: { readonly rest?: boolean } = {},
): string {
  const paths = honeyPaths(stateDir, apiary, compositionId);
  mkdirSync(dirname(paths.field), { recursive: true });
  const field = {
    schemaVersion: 1,
    compositionId,
    graphRevision: 'field-revision',
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
  const path = join(honeyPaths(stateDir, apiary, compositionId).directory, 'daemon.lock');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify({
      pid,
      nonce: 'json-test-nonce',
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

test('validate --json prints exactly one JSON object and writes nothing', () => {
  const files = writeCompositionPair();
  const before = readdirSync(files.directory).sort();
  const result = capture();

  const code = runCompositionCli(
    ['composition', 'validate', files.currentPath, '--json'],
    result.deps,
  );

  assert.equal(code, 0);
  const parsed = soleJsonObject(result);
  assert.deepEqual(parsed, {
    ok: true,
    command: 'validate',
    compositionId: 'json-demo',
    graphRevision: revisionOf(CURRENT_COMPOSITION),
  });
  assert.deepEqual(Object.keys(parsed).sort(), [
    'command',
    'compositionId',
    'graphRevision',
    'ok',
  ]);
  assert.deepEqual(readdirSync(files.directory).sort(), before);
  assert.equal(readFileSync(files.currentPath, 'utf8'), files.currentText);
});

test('replace --json succeeds, preserves policy, and carries no composition body', () => {
  const files = writeCompositionPair();
  const state = stateDirectory();
  const result = capture();

  const code = runCompositionCli(
    [
      'composition',
      'replace',
      '--json',
      files.currentPath,
      '--with',
      files.nextPath,
      '--state-dir',
      state,
    ],
    result.deps,
  );

  assert.equal(code, 0);
  const parsed = soleJsonObject(result);
  assert.deepEqual(Object.keys(parsed).sort(), [
    'activeReferences',
    'auditPath',
    'command',
    'compositionId',
    'file',
    'newRevision',
    'ok',
    'oldRevision',
  ]);
  assert.equal(parsed['ok'], true);
  assert.equal(parsed['command'], 'replace');
  assert.equal(parsed['compositionId'], 'json-demo');
  assert.equal(parsed['oldRevision'], revisionOf(CURRENT_COMPOSITION));
  assert.equal(parsed['newRevision'], revisionOf(NEXT_COMPOSITION));
  assert.notEqual(parsed['oldRevision'], parsed['newRevision']);
  assert.equal(parsed['file'], resolve(files.currentPath));
  assert.equal(parsed['auditPath'], compositionAuditPath(state));
  const active = parsed['activeReferences'] as Record<string, unknown>;
  assert.equal(active['status'], 'not-checked');
  assert.equal(typeof active['reason'], 'string');
  assert.match(String(active['reason']), /no --apiary/);

  assert.equal(readFileSync(files.currentPath, 'utf8'), files.nextText);
  assert.deepEqual(readdirSync(files.directory).filter((name) => name.includes('.tmp-')), []);
  const lines = auditLines(compositionAuditPath(state));
  assert.equal(lines.length, 1);
  assert.equal(lines[0]?.['oldRevision'], revisionOf(CURRENT_COMPOSITION));
  assert.equal(lines[0]?.['newRevision'], revisionOf(NEXT_COMPOSITION));

  const raw = result.stdout[0] as string;
  for (const body of ['SECRET-OLD-PROMPT', 'SECRET-NEW-PROMPT']) {
    assert.equal(raw.includes(body), false, 'JSON must not contain composition bodies');
  }
  assert.equal(raw.includes('"nodes"'), false);
  assert.equal(raw.includes('"prompt"'), false);
  assert.equal(raw.includes('"output"'), false);
});

test('replace --json uses the default state dir when --state-dir is omitted', () => {
  const files = writeCompositionPair();
  const state = stateDirectory();
  const result = capture();

  const code = runCompositionCli(
    ['composition', 'replace', '--json', files.currentPath, '--with', files.nextPath],
    { ...result.deps, defaultStateDir: state },
  );

  assert.equal(code, 0);
  const parsed = soleJsonObject(result);
  assert.equal(parsed['auditPath'], compositionAuditPath(state));
  assert.equal(auditLines(compositionAuditPath(state)).length, 1);
  assert.equal(readFileSync(files.currentPath, 'utf8'), files.nextText);
});

test('replace --json reports a checked field with no active references', () => {
  const files = writeCompositionPair();
  const state = stateDirectory();
  writeField(
    state,
    'demo',
    'json-demo',
    { start: { queue: [], lastActivatedAt: '2026-03-01T00:00:00.000Z', state: {} } },
    { rest: true },
  );
  const result = capture();

  const code = runCompositionCli(
    [
      'composition',
      'replace',
      '--json',
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
  const parsed = soleJsonObject(result);
  assert.deepEqual(parsed['activeReferences'], { status: 'checked' });
  assert.equal('staleLockPath' in parsed, false);
  assert.equal(readFileSync(files.currentPath, 'utf8'), files.nextText);
});

test('replace --json leaves a stale lock in place and reports its path', () => {
  const files = writeCompositionPair();
  const state = stateDirectory();
  const lockPath = writeLock(state, 'demo', 'json-demo', deadPid());
  const before = readFileSync(lockPath, 'utf8');
  const result = capture();

  const code = runCompositionCli(
    [
      'composition',
      'replace',
      '--json',
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
  const parsed = soleJsonObject(result);
  assert.equal(parsed['staleLockPath'], lockPath);
  assert.equal(readFileSync(lockPath, 'utf8'), before);
  assert.equal(readFileSync(files.currentPath, 'utf8'), files.nextText);
});

test('JSON usage failures map to code usage with exit 2 and write nothing', () => {
  const files = writeCompositionPair();
  const cases: ReadonlyArray<{
    readonly argv: readonly string[];
    readonly message: RegExp;
  }> = [
    {
      argv: [
        'composition',
        'replace',
        '--json',
        files.currentPath,
        '--with',
        files.nextPath,
        '--force',
      ],
      message: /unknown option '--force'/,
    },
    {
      argv: [
        'composition',
        'replace',
        '--json',
        files.currentPath,
        '--with',
        files.nextPath,
        '--json',
      ],
      message: /--json' was given more than once/,
    },
    {
      argv: ['composition', 'replace', '--json', files.currentPath],
      message: /missing required option --with/,
    },
  ];

  for (const usageCase of cases) {
    const result = capture();
    const code = runCompositionCli(usageCase.argv, result.deps);

    assert.equal(code, 2, usageCase.argv.join(' '));
    const parsed = soleJsonObject(result);
    assert.deepEqual(Object.keys(parsed).sort(), ['code', 'command', 'error', 'ok']);
    assert.equal(parsed['ok'], false);
    assert.equal(parsed['command'], 'replace');
    assert.equal(parsed['code'], 'usage');
    assert.match(String(parsed['error']), usageCase.message);
    assert.equal(readFileSync(files.currentPath, 'utf8'), files.currentText);
  }
  assert.equal(existsSync(files.nextPath), true);
});

test('JSON parse failures distinguish broken JSON from an invalid composition', () => {
  const files = writeCompositionPair();
  const state = stateDirectory();
  const brokenResult = capture();
  writeFileSync(files.nextPath, '{ not json');

  const brokenCode = runCompositionCli(
    [
      'composition',
      'replace',
      '--json',
      files.currentPath,
      '--with',
      files.nextPath,
      '--state-dir',
      state,
    ],
    brokenResult.deps,
  );
  assert.equal(brokenCode, 2);
  const broken = soleJsonObject(brokenResult);
  assert.equal(broken['ok'], false);
  assert.equal(broken['command'], 'replace');
  assert.equal(broken['code'], 'parse');
  assert.match(String(broken['error']), /not valid JSON/);
  assert.equal(readFileSync(files.currentPath, 'utf8'), files.currentText);
  assert.deepEqual(auditLines(compositionAuditPath(state)), []);

  const invalid = {
    schemaVersion: 1,
    id: 'json-demo',
    nodes: { start: { kind: 'unknown-kind', config: {} } },
    edges: [],
  };
  const invalidText = `${JSON.stringify(invalid, null, 2)}\n`;
  writeFileSync(files.nextPath, invalidText);
  const invalidResult = capture();

  const invalidCode = runCompositionCli(
    ['composition', 'validate', '--json', files.nextPath],
    invalidResult.deps,
  );
  assert.equal(invalidCode, 2);
  const invalidParsed = soleJsonObject(invalidResult);
  assert.equal(invalidParsed['ok'], false);
  assert.equal(invalidParsed['command'], 'validate');
  assert.equal(invalidParsed['code'], 'parse');
  assert.match(String(invalidParsed['error']), /invalid composition/);
});

test('JSON mode still refuses active references through the service layer', () => {
  const files = writeCompositionPair();
  const state = stateDirectory();
  writeField(state, 'demo', 'json-demo', {
    start: {
      queue: [
        {
          id: 'ph_1',
          traceId: 'tr_1',
          value: { kind: 'text', text: 'SECRET-QUEUED-BODY' },
          at: '2026-03-01T00:00:00.000Z',
        },
      ],
    },
  });
  const result = capture();

  const code = runCompositionCli(
    [
      'composition',
      'replace',
      '--json',
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
  const parsed = soleJsonObject(result);
  assert.equal(parsed['ok'], false);
  assert.equal(parsed['command'], 'replace');
  assert.equal(parsed['code'], 'refused');
  assert.match(String(parsed['error']), /active references exist/);
  assert.match(String(parsed['error']), /start\(queue\)/);
  assert.equal(String(parsed['error']).includes('SECRET-QUEUED-BODY'), false);
  assert.equal(readFileSync(files.currentPath, 'utf8'), files.currentText);
  assert.deepEqual(auditLines(compositionAuditPath(state)), []);
});

test('JSON mode still refuses a live daemon lock and never steals it', () => {
  const files = writeCompositionPair();
  const state = stateDirectory();
  const lockPath = writeLock(state, 'demo', 'json-demo', process.pid);
  const before = readFileSync(lockPath, 'utf8');
  const result = capture();

  const code = runCompositionCli(
    [
      'composition',
      'replace',
      '--json',
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
  const parsed = soleJsonObject(result);
  assert.equal(parsed['ok'], false);
  assert.equal(parsed['code'], 'refused');
  assert.match(String(parsed['error']), /daemon lock/);
  assert.match(String(parsed['error']), /live pid/);
  assert.equal(readFileSync(files.currentPath, 'utf8'), files.currentText);
  assert.equal(readFileSync(lockPath, 'utf8'), before);
  assert.deepEqual(auditLines(compositionAuditPath(state)), []);
});

test('JSON IO failures map to code io with exit 1 and keep the old composition', () => {
  const files = writeCompositionPair();
  const state = stateDirectory();
  const result = capture();

  const code = runCompositionCli(
    [
      'composition',
      'replace',
      '--json',
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
  const parsed = soleJsonObject(result);
  assert.equal(parsed['ok'], false);
  assert.equal(parsed['command'], 'replace');
  assert.equal(parsed['code'], 'io');
  assert.match(String(parsed['error']), /disk full/);
  assert.equal(readFileSync(files.currentPath, 'utf8'), files.currentText);
  assert.deepEqual(auditLines(compositionAuditPath(state)), []);
  assert.deepEqual(readdirSync(files.directory).filter((name) => name.includes('.tmp-')), []);
});

test('unexpected editing errors map to internal and exit 1', () => {
  const failure = compositionToolFailure('replace', new Error('boom'));
  assert.deepEqual(failure, {
    ok: false,
    command: 'replace',
    code: 'internal',
    error: 'boom',
  });
  assert.equal(compositionToolExitCode(failure), 1);
  assert.equal(
    compositionToolExitCode({
      ok: false,
      command: 'validate',
      code: 'refused',
      error: 'nope',
    }),
    2,
  );
  assert.equal(
    compositionToolExitCode({ ok: true, command: 'validate', compositionId: 'x', graphRevision: 'r' }),
    0,
  );
});

test('a JSON request without a tool subcommand stays a human usage error', () => {
  const result = capture();

  const code = runCompositionCli(['composition', '--json'], result.deps);

  assert.equal(code, 2);
  assert.deepEqual(result.stdout, []);
  assert.match(result.stderr.join('\n'), /usage: wax composition/);
});

test('the built CLI writes one JSON object to stdout and nothing to stderr', () => {
  const files = writeCompositionPair();
  const cliEntry = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const child = spawnSync(
    process.execPath,
    [cliEntry, 'composition', 'validate', '--json', files.currentPath],
    { encoding: 'utf8' },
  );

  assert.equal(child.status, 0);
  assert.equal(child.stderr, '');
  assert.equal(child.stdout.endsWith('\n'), true);
  const lines = child.stdout.trimEnd().split('\n');
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0] as string) as Record<string, unknown>;
  assert.deepEqual(parsed, {
    ok: true,
    command: 'validate',
    compositionId: 'json-demo',
    graphRevision: revisionOf(CURRENT_COMPOSITION),
  });
  assert.equal(child.stdout.includes('composition  '), false);
});

test('the built CLI exits 2 with a parseable JSON refusal', () => {
  const files = writeCompositionPair();
  const state = stateDirectory();
  writeField(state, 'demo', 'json-demo', {
    start: {
      queue: [
        {
          id: 'ph_1',
          traceId: 'tr_1',
          value: { kind: 'text', text: 'payload' },
          at: '2026-03-01T00:00:00.000Z',
        },
      ],
    },
  });
  const cliEntry = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const child = spawnSync(
    process.execPath,
    [
      cliEntry,
      'composition',
      'replace',
      '--json',
      files.currentPath,
      '--with',
      files.nextPath,
      '--state-dir',
      state,
      '--apiary',
      'demo',
    ],
    { encoding: 'utf8' },
  );

  assert.equal(child.status, 2);
  assert.equal(child.stderr, '');
  const lines = child.stdout.trimEnd().split('\n');
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0] as string) as Record<string, unknown>;
  assert.equal(parsed['ok'], false);
  assert.equal(parsed['command'], 'replace');
  assert.equal(parsed['code'], 'refused');
  assert.equal(readFileSync(files.currentPath, 'utf8'), files.currentText);
});
