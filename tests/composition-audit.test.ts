import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  runCompositionCli,
  type CompositionCliDependencies,
} from '../src/composition-cli.js';
import { compositionAuditPath } from '../src/composition-edit.js';
import { parseComposition } from '../src/runtime/index.js';

interface Capture {
  readonly stdout: string[];
  readonly stderr: string[];
  readonly deps: CompositionCliDependencies;
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

function stateDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'wax-composition-audit-'));
}

function workDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'wax-composition-recover-'));
}

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

function compositionFixture(id: string, prompt = 'body {{input}}'): unknown {
  return {
    schemaVersion: 1,
    id,
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt } },
    },
    edges: [],
  };
}

function revisionOf(composition: unknown): string {
  return parseComposition(composition).graphRevision;
}

function auditEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    at: '2026-03-01T00:00:00.000Z',
    compositionId: 'alpha',
    oldRevision: 'old-1',
    newRevision: 'new-1',
    file: '/tmp/composition.json',
    mode: 'replace',
    ...overrides,
  };
}

function writeAudit(stateDir: string, lines: readonly string[]): string {
  const path = compositionAuditPath(stateDir);
  writeFileSync(path, lines.map((line) => `${line}\n`).join(''));
  return path;
}

function auditEntries(
  stateDir: string,
  entries: readonly Record<string, unknown>[],
): string {
  return writeAudit(
    stateDir,
    entries.map((entry) => JSON.stringify(entry)),
  );
}

function snapshot(directory: string): Record<string, string> {
  const contents: Record<string, string> = {};
  for (const name of readdirSync(directory).sort()) {
    contents[name] = readFileSync(join(directory, name), 'utf8');
  }
  return contents;
}

test('revisions --json returns the audit in file order with metadata only', () => {
  const state = stateDirectory();
  auditEntries(state, [
    auditEntry({ prompt: 'SECRET-AUDIT-PROMPT' }),
    auditEntry({
      compositionId: 'beta',
      oldRevision: 'old-2',
      newRevision: 'new-2',
      nodes: { start: { config: { prompt: 'SECRET-AUDIT-NODES' } } },
    }),
  ]);
  const result = capture();

  const code = runCompositionCli(
    ['composition', 'revisions', '--json', '--state-dir', state],
    result.deps,
  );

  assert.equal(code, 0);
  const parsed = soleJsonObject(result);
  assert.deepEqual(Object.keys(parsed).sort(), [
    'command',
    'entries',
    'malformed',
    'ok',
  ]);
  assert.equal(parsed['ok'], true);
  assert.equal(parsed['command'], 'revisions');
  assert.equal(parsed['malformed'], 0);
  const entries = parsed['entries'] as Record<string, unknown>[];
  assert.equal(entries.length, 2);
  for (const entry of entries) {
    assert.deepEqual(Object.keys(entry).sort(), [
      'at',
      'compositionId',
      'file',
      'mode',
      'newRevision',
      'oldRevision',
    ]);
  }
  assert.equal(entries[0]?.['compositionId'], 'alpha');
  assert.equal(entries[1]?.['compositionId'], 'beta');

  const raw = result.stdout[0] as string;
  for (const secret of ['SECRET-AUDIT-PROMPT', 'SECRET-AUDIT-NODES', '"prompt"', '"nodes"']) {
    assert.equal(raw.includes(secret), false, `audit output leaked ${secret}`);
  }
});

test('revisions filters by composition and limits to the newest matches', () => {
  const state = stateDirectory();
  auditEntries(state, [
    auditEntry({ compositionId: 'alpha', oldRevision: 'a1', newRevision: 'a2' }),
    auditEntry({ compositionId: 'beta', oldRevision: 'b1', newRevision: 'b2' }),
    auditEntry({ compositionId: 'alpha', oldRevision: 'a2', newRevision: 'a3' }),
  ]);

  const filtered = capture();
  assert.equal(
    runCompositionCli(
      [
        'composition',
        'revisions',
        '--json',
        '--state-dir',
        state,
        '--composition',
        'alpha',
      ],
      filtered.deps,
    ),
    0,
  );
  const filteredJson = soleJsonObject(filtered);
  const filteredEntries = filteredJson['entries'] as Record<string, unknown>[];
  assert.equal(filteredEntries.length, 2);
  assert.deepEqual(
    filteredEntries.map((entry) => entry['oldRevision']),
    ['a1', 'a2'],
  );

  const limited = capture();
  assert.equal(
    runCompositionCli(
      [
        'composition',
        'revisions',
        '--json',
        '--state-dir',
        state,
        '--composition',
        'alpha',
        '--limit',
        '1',
      ],
      limited.deps,
    ),
    0,
  );
  const limitedJson = soleJsonObject(limited);
  const limitedEntries = limitedJson['entries'] as Record<string, unknown>[];
  assert.equal(limitedEntries.length, 1);
  assert.equal(limitedEntries[0]?.['oldRevision'], 'a2');
  assert.equal(limitedEntries[0]?.['newRevision'], 'a3');
});

test('revisions keeps the 50 newest entries by default', () => {
  const state = stateDirectory();
  const many: Record<string, unknown>[] = [];
  for (let index = 0; index < 55; index += 1) {
    many.push(
      auditEntry({
        at: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
        oldRevision: `r${String(index)}`,
        newRevision: `r${String(index + 1)}`,
      }),
    );
  }
  auditEntries(state, many);
  const result = capture();

  const code = runCompositionCli(
    ['composition', 'revisions', '--json', '--state-dir', state],
    result.deps,
  );

  assert.equal(code, 0);
  const entries = soleJsonObject(result)['entries'] as Record<string, unknown>[];
  assert.equal(entries.length, 50);
  assert.equal(entries[0]?.['oldRevision'], 'r5');
  assert.equal(entries[49]?.['oldRevision'], 'r54');
});

test('revisions fails on a malformed line instead of skipping it', () => {
  const state = stateDirectory();
  writeAudit(state, [
    JSON.stringify(auditEntry()),
    '{"at":"SECRET-BROKEN-CONTENT',
    JSON.stringify(auditEntry({ compositionId: 'trailing' })),
  ]);
  const result = capture();

  const code = runCompositionCli(
    ['composition', 'revisions', '--json', '--state-dir', state],
    result.deps,
  );

  assert.equal(code, 1);
  const parsed = soleJsonObject(result);
  assert.deepEqual(Object.keys(parsed).sort(), ['code', 'command', 'error', 'ok']);
  assert.equal(parsed['ok'], false);
  assert.equal(parsed['command'], 'revisions');
  assert.equal(parsed['code'], 'parse');
  assert.match(String(parsed['error']), /malformed revision audit line 2/);
  assert.match(String(parsed['error']), /not valid JSON/);
  assert.equal(('entries' in parsed), false);
  assert.equal((result.stdout[0] as string).includes('SECRET-BROKEN-CONTENT'), false);

  const human = capture();
  assert.equal(
    runCompositionCli(
      ['composition', 'revisions', '--state-dir', state],
      human.deps,
    ),
    1,
  );
  assert.deepEqual(human.stdout, []);
  assert.match(human.stderr.join('\n'), /malformed revision audit line 2/);
  assert.equal(human.stderr.join('\n').includes('SECRET-BROKEN-CONTENT'), false);
});

test('revisions rejects a JSON object that is not an audit record', () => {
  const state = stateDirectory();
  writeAudit(state, [
    JSON.stringify(auditEntry()),
    JSON.stringify({ at: '2026-03-01T00:00:00.000Z', compositionId: 'alpha' }),
  ]);
  const result = capture();

  const code = runCompositionCli(
    ['composition', 'revisions', '--json', '--state-dir', state],
    result.deps,
  );

  assert.equal(code, 1);
  const parsed = soleJsonObject(result);
  assert.equal(parsed['code'], 'parse');
  assert.match(String(parsed['error']), /line 2/);
  assert.match(String(parsed['error']), /'oldRevision'/);
});

test('revisions treats a missing audit file as empty and creates nothing', () => {
  const state = stateDirectory();
  const before = readdirSync(state).sort();
  const result = capture();

  const code = runCompositionCli(
    ['composition', 'revisions', '--json', '--state-dir', state],
    result.deps,
  );

  assert.equal(code, 0);
  assert.deepEqual(soleJsonObject(result), {
    ok: true,
    command: 'revisions',
    entries: [],
    malformed: 0,
  });
  assert.deepEqual(readdirSync(state).sort(), before);
  assert.equal(existsSync(compositionAuditPath(state)), false);
});

test('revisions rejects invalid limits as usage before reading the audit', () => {
  const state = stateDirectory();
  const cases: readonly (readonly string[])[] = [
    ['--limit', '0'],
    ['--limit', '1001'],
    ['--limit', 'abc'],
    ['--limit', '1.5'],
    ['--limit', '-1'],
    ['--limit'],
    ['--limit', '2', '--limit', '3'],
  ];

  for (const extra of cases) {
    const result = capture();
    const code = runCompositionCli(
      ['composition', 'revisions', '--json', '--state-dir', state, ...extra],
      result.deps,
    );
    assert.equal(code, 2, extra.join(' '));
    const parsed = soleJsonObject(result);
    assert.deepEqual(Object.keys(parsed).sort(), ['code', 'command', 'error', 'ok']);
    assert.equal(parsed['ok'], false);
    assert.equal(parsed['command'], 'revisions');
    assert.equal(parsed['code'], 'usage');
  }
});

test('revisions human output is a compact read-only metadata list', () => {
  const state = stateDirectory();
  auditEntries(state, [
    auditEntry({ mode: 'replace', file: '/work/composition.json' }),
    auditEntry({ compositionId: 'beta' }),
  ]);
  const result = capture();

  const code = runCompositionCli(
    ['composition', 'revisions'],
    { ...result.deps, defaultStateDir: state },
  );

  assert.equal(code, 0);
  assert.deepEqual(result.stderr, []);
  assert.equal(result.stdout[0], `audit        ${compositionAuditPath(state)}`);
  assert.equal(result.stdout[1], 'revisions    2');
  assert.match(result.stdout[2] as string, /alpha/);
  assert.match(result.stdout[2] as string, /old-1 -> new-1/);
  assert.match(result.stdout[2] as string, /replace/);
  assert.match(result.stdout[3] as string, /beta/);
  assert.equal(result.stdout.join('\n').includes('prompt'), false);
});

test('recover --json reports no candidates without touching the directory', () => {
  const directory = workDirectory();
  const compositionPath = join(directory, 'composition.json');
  writeFileSync(compositionPath, JSON.stringify(compositionFixture('active'), null, 2));
  const before = snapshot(directory);
  const result = capture();

  const code = runCompositionCli(
    ['composition', 'recover', '--json', compositionPath],
    result.deps,
  );

  assert.equal(code, 0);
  assert.deepEqual(soleJsonObject(result), {
    ok: true,
    command: 'recover',
    file: resolve(compositionPath),
    candidates: [],
  });
  assert.deepEqual(snapshot(directory), before);
});

test('recover --json reports valid and invalid candidates and mutates nothing', () => {
  const directory = workDirectory();
  const compositionPath = join(directory, 'composition.json');
  writeFileSync(
    compositionPath,
    JSON.stringify(compositionFixture('active', 'SECRET-ACTIVE-BODY'), null, 2),
  );
  const recovered = compositionFixture('recovered', 'SECRET-RECOVERED-BODY');
  const validPath = join(directory, '.composition.json.tmp-2-valid');
  writeFileSync(validPath, JSON.stringify(recovered, null, 2));
  const invalidPath = join(directory, '.composition.json.tmp-1-broken');
  writeFileSync(invalidPath, '{"prompt":"SECRET-BROKEN-BODY"');
  const unrelatedPath = join(directory, '.other.json.tmp-x');
  writeFileSync(unrelatedPath, 'not a candidate');
  const before = snapshot(directory);
  const result = capture();

  const code = runCompositionCli(
    ['composition', 'recover', '--json', compositionPath],
    result.deps,
  );

  assert.equal(code, 0);
  const parsed = soleJsonObject(result);
  assert.deepEqual(Object.keys(parsed).sort(), [
    'candidates',
    'command',
    'file',
    'ok',
  ]);
  assert.equal(parsed['file'], resolve(compositionPath));
  const candidates = parsed['candidates'] as Record<string, unknown>[];
  assert.equal(candidates.length, 2, 'only same-basename temp files are candidates');

  const broken = candidates[0] as Record<string, unknown>;
  assert.equal(broken['path'], invalidPath);
  assert.deepEqual(Object.keys(broken).sort(), ['error', 'path', 'valid']);
  assert.equal(broken['valid'], false);
  assert.equal(broken['error'], 'not valid JSON');

  const valid = candidates[1] as Record<string, unknown>;
  assert.equal(valid['path'], validPath);
  assert.deepEqual(Object.keys(valid).sort(), [
    'compositionId',
    'graphRevision',
    'path',
    'valid',
  ]);
  assert.equal(valid['valid'], true);
  assert.equal(valid['compositionId'], 'recovered');
  assert.equal(valid['graphRevision'], revisionOf(recovered));

  const raw = result.stdout[0] as string;
  for (const secret of [
    'SECRET-ACTIVE-BODY',
    'SECRET-RECOVERED-BODY',
    'SECRET-BROKEN-BODY',
    '"prompt"',
  ]) {
    assert.equal(raw.includes(secret), false, `recovery output leaked ${secret}`);
  }
  assert.deepEqual(snapshot(directory), before);
});

test('recover reports a structurally invalid composition candidate', () => {
  const directory = workDirectory();
  const compositionPath = join(directory, 'composition.json');
  writeFileSync(compositionPath, JSON.stringify(compositionFixture('active'), null, 2));
  const invalid = {
    schemaVersion: 1,
    id: 'invalid-candidate',
    nodes: { start: { kind: 'unknown-kind', config: { prompt: 'SECRET-INVALID-BODY' } } },
    edges: [],
  };
  writeFileSync(
    join(directory, '.composition.json.tmp-1-invalid'),
    JSON.stringify(invalid, null, 2),
  );
  const result = capture();

  const code = runCompositionCli(
    ['composition', 'recover', '--json', compositionPath],
    result.deps,
  );

  assert.equal(code, 0);
  const candidates = soleJsonObject(result)['candidates'] as Record<string, unknown>[];
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.['valid'], false);
  assert.match(String(candidates[0]?.['error']), /invalid composition/);
  assert.match(String(candidates[0]?.['error']), /unknown node kind/);
  assert.equal((result.stdout[0] as string).includes('SECRET-INVALID-BODY'), false);
});

test('recover --json usage errors exit 2 with one failure object', () => {
  const directory = workDirectory();
  const compositionPath = join(directory, 'composition.json');
  writeFileSync(compositionPath, JSON.stringify(compositionFixture('active'), null, 2));
  const cases: readonly (readonly string[])[] = [
    ['composition', 'recover', '--json'],
    ['composition', 'recover', '--json', compositionPath, 'second.json'],
    ['composition', 'recover', '--json', compositionPath, '--state-dir', 'x'],
    ['composition', 'recover', '--json', '--json', compositionPath],
  ];

  for (const argv of cases) {
    const result = capture();
    const code = runCompositionCli(argv, result.deps);
    assert.equal(code, 2, argv.join(' '));
    const parsed = soleJsonObject(result);
    assert.deepEqual(Object.keys(parsed).sort(), ['code', 'command', 'error', 'ok']);
    assert.equal(parsed['ok'], false);
    assert.equal(parsed['command'], 'recover');
    assert.equal(parsed['code'], 'usage');
  }
});

test('read-only commands reject --apply and revisions positionals', () => {
  const directory = workDirectory();
  const compositionPath = join(directory, 'composition.json');
  writeFileSync(compositionPath, JSON.stringify(compositionFixture('active'), null, 2));
  const before = snapshot(directory);

  const cases: readonly (readonly string[])[] = [
    ['composition', 'recover', compositionPath, '--apply'],
    ['composition', 'revisions', compositionPath],
  ];

  for (const argv of cases) {
    const result = capture();
    assert.equal(runCompositionCli(argv, result.deps), 2, argv.join(' '));
    assert.notDeepEqual(result.stderr, [], argv.join(' '));
  }
  assert.deepEqual(snapshot(directory), before);
});

test('recover reports an IO failure when the directory cannot be scanned', () => {
  const missingDirectory = join(
    tmpdir(),
    `wax-recovery-missing-${String(process.pid)}-${String(Date.now())}`,
  );
  const compositionPath = join(missingDirectory, 'composition.json');
  const result = capture();

  const code = runCompositionCli(
    ['composition', 'recover', '--json', compositionPath],
    result.deps,
  );

  assert.equal(code, 1);
  const parsed = soleJsonObject(result);
  assert.deepEqual(Object.keys(parsed).sort(), ['code', 'command', 'error', 'ok']);
  assert.equal(parsed['ok'], false);
  assert.equal(parsed['command'], 'recover');
  assert.equal(parsed['code'], 'io');
  assert.match(String(parsed['error']), /cannot scan directory/);

  const human = capture();
  assert.equal(
    runCompositionCli(['composition', 'recover', compositionPath], human.deps),
    1,
  );
  assert.deepEqual(human.stdout, []);
  assert.match(human.stderr.join('\n'), /cannot scan directory/);
});

test('recover human output lists candidates and says nothing was changed', () => {
  const directory = workDirectory();
  const compositionPath = join(directory, 'composition.json');
  writeFileSync(compositionPath, JSON.stringify(compositionFixture('active'), null, 2));

  const empty = capture();
  assert.equal(
    runCompositionCli(['composition', 'recover', compositionPath], empty.deps),
    0,
  );
  assert.deepEqual(empty.stderr, []);
  assert.equal(empty.stdout[0], `file         ${resolve(compositionPath)}`);
  assert.equal(empty.stdout[1], 'candidates   0');
  assert.equal(empty.stdout[2], 'mutations    none (read-only inspection)');

  const validPath = join(directory, '.composition.json.tmp-1-valid');
  writeFileSync(validPath, JSON.stringify(compositionFixture('recovered'), null, 2));
  const found = capture();
  assert.equal(
    runCompositionCli(['composition', 'recover', compositionPath], found.deps),
    0,
  );
  const lines = found.stdout.join('\n');
  assert.match(lines, /candidates   1/);
  assert.match(lines, /candidate    valid/);
  assert.match(lines, /composition=recovered/);
});

test('the built CLI exits 1 for a malformed audit line and keeps stderr empty', () => {
  const state = stateDirectory();
  writeAudit(state, [JSON.stringify(auditEntry()), '{ not json']);
  const cliEntry = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const child = spawnSync(
    process.execPath,
    [cliEntry, 'composition', 'revisions', '--json', '--state-dir', state],
    { encoding: 'utf8' },
  );

  assert.equal(child.status, 1);
  assert.equal(child.stderr, '');
  const lines = child.stdout.trimEnd().split('\n');
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0] as string) as Record<string, unknown>;
  assert.equal(parsed['ok'], false);
  assert.equal(parsed['command'], 'revisions');
  assert.equal(parsed['code'], 'parse');
  assert.match(String(parsed['error']), /line 2/);
});
