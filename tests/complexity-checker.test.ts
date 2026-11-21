import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

function findRepositoryRoot(start: string): string {
  let current = start;
  for (;;) {
    if (existsSync(join(current, 'scripts', 'complexity.mjs'))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(`cannot find the repository root above ${start}`);
    }
    current = parent;
  }
}

const REPO_ROOT = findRepositoryRoot(dirname(fileURLToPath(import.meta.url)));
const CHECKER = join(REPO_ROOT, 'scripts', 'complexity.mjs');

interface RunRoot {
  root: string;
  name: string;
}

const testTemp = (await import(
  pathToFileURL(join(REPO_ROOT, 'scripts', 'test-temp.mjs')).href
)) as {
  createRunRoot: () => RunRoot;
  cleanupRunRoot: (handle: RunRoot) => { root: string; files: number; cleaned: boolean };
};
const FIXTURE_ROOT = testTemp.createRunRoot();

after(() => {
  const cleaned = testTemp.cleanupRunRoot(FIXTURE_ROOT);
  assert.equal(cleaned.cleaned, true);
  assert.equal(existsSync(cleaned.root), false);
});

function lines(count: number, label: string): string {
  return Array.from({ length: count }, (_, index) => `// ${label} ${index + 1}`).join('\n') + '\n';
}

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(FIXTURE_ROOT.root, 'case-'));
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

function writeMetricsBaseline(
  root: string,
  metrics: Record<string, Record<string, number>>,
): string {
  const path = join(root, 'metrics-baseline.json');
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, metrics }, null, 2));
  return path;
}

function functionOfLines(total: number, name = 'big'): string {
  const body = Array.from({ length: total - 2 }, (_, index) => `  void ${index};`);
  return `function ${name}(): void {\n${body.join('\n')}\n}\n`;
}

function functionWithCyclomatic(decisions: number, name = 'branchy'): string {
  const body = Array.from(
    { length: decisions },
    (_, index) => `  if (x === ${index}) { void ${index}; }`,
  );
  return `function ${name}(x: number): void {\n${body.join('\n')}\n}\n`;
}

function functionWithNesting(depth: number, name = 'deep'): string {
  const lines: string[] = [];
  for (let level = 0; level < depth; level += 1) {
    lines.push(`${'  '.repeat(level + 1)}if (x) {`);
  }
  lines.push(`${'  '.repeat(depth + 1)}void 0;`);
  for (let level = depth - 1; level >= 0; level -= 1) {
    lines.push(`${'  '.repeat(level + 1)}}`);
  }
  return `function ${name}(x: boolean): void {\n${lines.join('\n')}\n}\n`;
}

function functionWithParameters(count: number, name = 'wide'): string {
  const parameters = Array.from({ length: count }, (_, index) => `a${index}: number`);
  return `function ${name}(${parameters.join(', ')}): void {}\n`;
}

function classWithBodyLines(total: number, name = 'BigClass'): string {
  const members = Array.from(
    { length: total - 2 },
    (_, index) => `  private p${index} = ${index};`,
  );
  return `class ${name} {\n${members.join('\n')}\n}\n`;
}

function classWithPublicMethods(count: number, name = 'ManyMethods'): string {
  const methods = Array.from({ length: count }, (_, index) => `  m${index}(): void {}`);
  return `class ${name} {\n${methods.join('\n')}\n}\n`;
}

function classWithConstructorDependencies(count: number, name = 'ManyDeps'): string {
  const parameters = Array.from(
    { length: count },
    (_, index) => `private readonly d${index}: string`,
  );
  return `class ${name} {\n  constructor(${parameters.join(', ')}) {}\n}\n`;
}

function runChecker(
  root: string,
  baseline: string,
  metricsBaseline?: string,
): { status: number | null; output: string } {
  const args = [CHECKER, '--root', root, '--baseline', baseline];
  if (metricsBaseline !== undefined) {
    args.push('--metrics-baseline', metricsBaseline);
  }
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
  });
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
  assert.match(output, /functions\/classes checked/);
  assert.match(output, /metrics baselined/);
});

test('fails a new function over the 50-line limit', () => {
  const root = fixture({ 'src/new-debt.ts': functionOfLines(51) });

  const result = runChecker(root, writeBaseline(root, {}));

  assert.equal(result.status, 1, result.output);
  assert.match(
    result.output,
    /src\/new-debt\.ts::function big: lines 51 > 50 \(no metrics baseline entry\)/,
  );
});

test('fails a new function over the cyclomatic limit', () => {
  const root = fixture({ 'src/branchy.ts': functionWithCyclomatic(10) });

  const result = runChecker(root, writeBaseline(root, {}));

  assert.equal(result.status, 1, result.output);
  assert.match(
    result.output,
    /src\/branchy\.ts::function branchy: cyclomatic 11 > 10 \(no metrics baseline entry\)/,
  );
});

test('fails a new function over the nesting limit', () => {
  const root = fixture({ 'src/deep.ts': functionWithNesting(5) });

  const result = runChecker(root, writeBaseline(root, {}));

  assert.equal(result.status, 1, result.output);
  assert.match(
    result.output,
    /src\/deep\.ts::function deep: nesting 5 > 4 \(no metrics baseline entry\)/,
  );
});

test('fails a new function over the parameter limit', () => {
  const root = fixture({ 'src/wide.ts': functionWithParameters(7) });

  const result = runChecker(root, writeBaseline(root, {}));

  assert.equal(result.status, 1, result.output);
  assert.match(
    result.output,
    /src\/wide\.ts::function wide: parameters 7 > 6 \(no metrics baseline entry\)/,
  );
});

test('fails a new class over the 250-line body limit', () => {
  const root = fixture({ 'src/big-class.ts': classWithBodyLines(251) });

  const result = runChecker(root, writeBaseline(root, {}));

  assert.equal(result.status, 1, result.output);
  assert.match(
    result.output,
    /src\/big-class\.ts::class BigClass: body 251 > 250 lines \(no metrics baseline entry\)/,
  );
});

test('fails a new class over the public-method limit', () => {
  const root = fixture({ 'src/many-methods.ts': classWithPublicMethods(13) });

  const result = runChecker(root, writeBaseline(root, {}));

  assert.equal(result.status, 1, result.output);
  assert.match(
    result.output,
    /src\/many-methods\.ts::class ManyMethods: public methods 13 > 12 \(no metrics baseline entry\)/,
  );
});

test('fails a new class over the constructor-dependency limit', () => {
  const root = fixture({ 'src/many-deps.ts': classWithConstructorDependencies(9) });

  const result = runChecker(root, writeBaseline(root, {}));

  assert.equal(result.status, 1, result.output);
  assert.match(
    result.output,
    /src\/many-deps\.ts::class ManyDeps: constructor dependencies 9 > 8 \(no metrics baseline entry\)/,
  );
});

test('accepts a baselined class at its recorded metric values', () => {
  const root = fixture({ 'src/legacy-class.ts': classWithBodyLines(251) });
  const metricsBaseline = writeMetricsBaseline(root, {
    'src/legacy-class.ts::class BigClass': {
      bodyLines: 251,
      publicMethods: 0,
      constructorDependencies: 0,
    },
  });

  const result = runChecker(root, writeBaseline(root, {}), metricsBaseline);

  assert.equal(result.status, 0, result.output);
});

test('fails a baselined class that grows past its recorded metric value', () => {
  const root = fixture({ 'src/legacy-class.ts': classWithBodyLines(252) });
  const metricsBaseline = writeMetricsBaseline(root, {
    'src/legacy-class.ts::class BigClass': {
      bodyLines: 251,
      publicMethods: 0,
      constructorDependencies: 0,
    },
  });

  const result = runChecker(root, writeBaseline(root, {}), metricsBaseline);

  assert.equal(result.status, 1, result.output);
  assert.match(
    result.output,
    /src\/legacy-class\.ts::class BigClass: bodyLines grew from the baselined 251 to 252/,
  );
});

test('accepts a baselined function at its recorded metric values', () => {
  const root = fixture({ 'src/legacy.ts': functionOfLines(60) });
  const metricsBaseline = writeMetricsBaseline(root, {
    'src/legacy.ts::function big': {
      lines: 60,
      cyclomatic: 1,
      nesting: 0,
      parameters: 0,
    },
  });

  const result = runChecker(root, writeBaseline(root, {}), metricsBaseline);

  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /1 metrics baselined/);
});

test('fails a baselined function that grows past its recorded metric value', () => {
  const root = fixture({ 'src/legacy.ts': functionOfLines(61) });
  const metricsBaseline = writeMetricsBaseline(root, {
    'src/legacy.ts::function big': {
      lines: 60,
      cyclomatic: 1,
      nesting: 0,
      parameters: 0,
    },
  });

  const result = runChecker(root, writeBaseline(root, {}), metricsBaseline);

  assert.equal(result.status, 1, result.output);
  assert.match(
    result.output,
    /src\/legacy\.ts::function big: lines grew from the baselined 60 to 61/,
  );
});

test('fails a baselined function that shrinks until the metrics baseline is lowered', () => {
  const root = fixture({ 'src/legacy.ts': functionOfLines(60) });
  const metricsBaseline = writeMetricsBaseline(root, {
    'src/legacy.ts::function big': {
      lines: 61,
      cyclomatic: 1,
      nesting: 0,
      parameters: 0,
    },
  });

  const result = runChecker(root, writeBaseline(root, {}), metricsBaseline);

  assert.equal(result.status, 1, result.output);
  assert.match(
    result.output,
    /src\/legacy\.ts::function big: metrics baseline is stale for lines: recorded 61, actual 60/,
  );
  assert.match(result.output, /lower the entry to 60/);
});

test('fails a metrics baseline entry for a function back under the limits', () => {
  const root = fixture({ 'src/legacy.ts': functionOfLines(40) });
  const metricsBaseline = writeMetricsBaseline(root, {
    'src/legacy.ts::function big': {
      lines: 51,
      cyclomatic: 1,
      nesting: 0,
      parameters: 0,
    },
  });

  const result = runChecker(root, writeBaseline(root, {}), metricsBaseline);

  assert.equal(result.status, 1, result.output);
  assert.match(
    result.output,
    /src\/legacy\.ts::function big: no longer exceeds the function hard limits; remove the metrics baseline entry/,
  );
});

test('fails an unmatched metrics baseline entry', () => {
  const root = fixture({ 'src/other.ts': '// no declarations\n' });
  const metricsBaseline = writeMetricsBaseline(root, {
    'src/ghost.ts::function ghost': {
      lines: 51,
      cyclomatic: 1,
      nesting: 0,
      parameters: 0,
    },
  });

  const result = runChecker(root, writeBaseline(root, {}), metricsBaseline);

  assert.equal(result.status, 1, result.output);
  assert.match(
    result.output,
    /src\/ghost\.ts::function ghost: metrics baseline entry does not match a scanned function or class/,
  );
});

test('does not count decisions in a nested function toward the outer function', () => {
  const innerBody = Array.from(
    { length: 10 },
    (_, index) => `    if (y === ${index}) { void ${index}; }`,
  );
  const root = fixture({
    'src/nested.ts':
      'function outer(x: number): void {\n' +
      '  function inner(y: number): void {\n' +
      `${innerBody.join('\n')}\n` +
      '  }\n' +
      '  inner(x);\n' +
      '}\n',
  });

  const result = runChecker(root, writeBaseline(root, {}));

  assert.equal(result.status, 1, result.output);
  assert.match(
    result.output,
    /src\/nested\.ts::function inner: cyclomatic 11 > 10 \(no metrics baseline entry\)/,
  );
  assert.doesNotMatch(result.output, /function outer:/);
});

test('prints the metrics baseline without writing it', () => {
  const root = fixture({ 'src/print.ts': functionOfLines(51) });

  const result = spawnSync(
    process.execPath,
    [CHECKER, '--root', root, '--print-metrics-baseline'],
    { cwd: root, encoding: 'utf8' },
  );

  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout) as {
    schemaVersion: number;
    metrics: Record<string, Record<string, number>>;
  };
  assert.equal(parsed.schemaVersion, 1);
  assert.deepEqual(Object.keys(parsed.metrics), ['src/print.ts::function big']);
  assert.equal(parsed.metrics['src/print.ts::function big']?.lines, 51);
});
