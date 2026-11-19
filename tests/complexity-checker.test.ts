import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const CHECKER = join(REPO_ROOT, 'scripts', 'complexity.mjs');

function lines(count: number, label: string): string {
  return Array.from({ length: count }, (_, index) => `// ${label} ${index + 1}`).join('\n') + '\n';
}

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'wax-complexity-'));
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, ...path.split('/'));
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
  return root;
}

function writeBaseline(root: string, files: Record<string, number>): string {
  const path = join(root, 'baseline.json');
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, files }, null, 2));
  return path;
}

function runChecker(root: string, baseline: string): { status: number | null; output: string } {
  const result = spawnSync(
    process.execPath,
    [CHECKER, '--root', root, '--baseline', baseline],
    { cwd: root, encoding: 'utf8' },
  );
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

test('accepts source and test files exactly at their hard limits', () => {
  const root = fixture({
    'src/at-limit.ts': lines(500, 'source'),
    'tests/at-limit.test.ts': lines(800, 'test'),
  });

  const result = runChecker(root, writeBaseline(root, {}));

  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /complexity: ok \(2 files scanned, 0 baselined/);
});

test('fails a new source file over the 500-line hard limit', () => {
  const root = fixture({ 'src/new-debt.ts': lines(501, 'source') });

  const result = runChecker(root, writeBaseline(root, {}));

  assert.equal(result.status, 1);
  assert.match(
    result.output,
    /src\/new-debt\.ts: 501 lines exceeds the 500-line hard limit \(no baseline entry\)/,
  );
});

test('fails a new test file over the 800-line hard limit', () => {
  const root = fixture({ 'tests/new-debt.test.ts': lines(801, 'test') });

  const result = runChecker(root, writeBaseline(root, {}));

  assert.equal(result.status, 1);
  assert.match(
    result.output,
    /tests\/new-debt\.test\.ts: 801 lines exceeds the 800-line hard limit \(no baseline entry\)/,
  );
});

test('allows a baselined source file at its recorded line count', () => {
  const root = fixture({ 'src/legacy.ts': lines(620, 'source') });

  const result = runChecker(root, writeBaseline(root, { 'src/legacy.ts': 620 }));

  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /1 baselined at recorded bounds/);
});

test('fails a baselined source file that grows past its recorded line count', () => {
  const root = fixture({ 'src/legacy.ts': lines(621, 'source') });

  const result = runChecker(root, writeBaseline(root, { 'src/legacy.ts': 620 }));

  assert.equal(result.status, 1);
  assert.match(
    result.output,
    /src\/legacy\.ts: grew from the baselined 620 to 621 lines/,
  );
});

test('fails a baselined file that shrinks until the baseline is lowered', () => {
  const root = fixture({ 'src/legacy.ts': lines(590, 'source') });

  const result = runChecker(root, writeBaseline(root, { 'src/legacy.ts': 620 }));

  assert.equal(result.status, 1);
  assert.match(result.output, /baseline is stale: recorded 620, actual 590/);
  assert.match(result.output, /lower the entry to 590/);
});

test('fails a baseline entry for a file that is back under the hard limit', () => {
  const root = fixture({ 'src/legacy.ts': lines(500, 'source') });

  const result = runChecker(root, writeBaseline(root, { 'src/legacy.ts': 620 }));

  assert.equal(result.status, 1);
  assert.match(
    result.output,
    /src\/legacy\.ts: no longer exceeds the 500-line hard limit; remove the baseline entry/,
  );
});

test('passes on the repository itself with the checked-in baseline', () => {
  const result = spawnSync(process.execPath, [CHECKER], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0, output);
  assert.match(output, /complexity: ok/);
});
