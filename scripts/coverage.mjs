#!/usr/bin/env node
/**
 * Coverage gate.
 *
 * Builds into this run's disposable root — the repository `dist/` is never
 * written, so a coverage run cannot race another slice's build — then runs the
 * compiled unit tests under `node --test` with V8 coverage and the
 * line/function/branch thresholds below. Node prints its own coverage summary;
 * the run root is deleted in a finally block and the child's exit code is
 * passed through. A cleanup failure prints `CLEANUP_FAILED <path>`.
 *
 * Compiled tests locate the repository root from their own file location
 * (`<root>/dist/tests/x.test.js` -> `<root>`), so the run root also carries
 * junction links to the checkout's `scripts`, `src` and `tests`. The links are
 * entries of the run root and are removed with it; their targets are read only.
 *
 * Usage:
 *   node scripts/coverage.mjs [--lines <n>] [--functions <n>] [--branches <n>]
 *
 * The flags override the defaults for one run; unhappily the only way to show
 * that a raised threshold fails is to raise it. Exit codes: the build/test exit
 * code (1 if cleanup fails on an otherwise green run), 2 = usage error.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  childEnv,
  cleanupRunRoot,
  createRunRoot,
  formatRunRootSummary,
} from './test-temp.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TSC = join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

// Measured on the unit suite on 2026-11-21: lines 77.18-77.50, functions
// 83.68-83.90, branches 78.88-79.00 (the suite grew from 811 to 825 tests
// while this gate was added). The gate sits a little under the low end so
// ordinary work does not trip it while a real regression still does. The
// totals include the fake-harness fixtures the tests load from TEMP, so they
// move by a few tenths between runs; two points absorbs that.
const DEFAULT_THRESHOLDS = { lines: 75, functions: 81, branches: 76 };

const THRESHOLD_FLAGS = {
  lines: '--lines',
  functions: '--functions',
  branches: '--branches',
};

class UsageError extends Error {}

/** Parse `--flag value` / `--flag=value`; anything unrecognized is a usage error. */
function parseThresholds(argv) {
  const thresholds = { ...DEFAULT_THRESHOLDS };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const match = /^--(lines|functions|branches)(?:=(-?\d+(?:\.\d+)?))?$/.exec(argument);
    if (match === null) {
      throw new UsageError(`unknown argument: ${argument}`);
    }
    const name = match[1];
    let raw = match[2];
    if (raw === undefined) {
      raw = argv[index + 1];
      index += 1;
      if (raw === undefined || raw.startsWith('--')) {
        throw new UsageError(`${THRESHOLD_FLAGS[name]} needs a numeric value`);
      }
    }
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      throw new UsageError(`${THRESHOLD_FLAGS[name]} must be between 0 and 100, got ${raw}`);
    }
    thresholds[name] = value;
  }
  return thresholds;
}

function build(outDir, env) {
  if (!existsSync(TSC)) {
    process.stderr.write(`coverage: TypeScript is not installed at ${TSC}\n`);
    return 1;
  }
  const result = spawnSync(
    process.execPath,
    [TSC, '-p', 'tsconfig.json', '--outDir', outDir],
    { cwd: REPO_ROOT, stdio: 'inherit', env },
  );
  if (result.error !== undefined) {
    process.stderr.write(`coverage: cannot start tsc: ${result.error.message}\n`);
    return 1;
  }
  return result.status ?? 1;
}

/** Compiled unit tests only: the integration tests need a real harness. */
function unitTestFiles(outDir) {
  const testsDir = join(outDir, 'tests');
  if (!existsSync(testsDir)) {
    return [];
  }
  return readdirSync(testsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.js'))
    .map((entry) => join(testsDir, entry.name))
    .sort();
}

/**
 * The compiled tests derive the repository root from their own path, so the
 * run root must look like a checkout. Junctions keep `scripts`, `src` and
 * `tests` readable without copying them; cleanup removes the links, never the
 * checkout.
 */
const MIRRORED_DIRECTORIES = ['scripts', 'src', 'tests'];

function mirrorRepository(root) {
  for (const name of MIRRORED_DIRECTORIES) {
    const target = join(REPO_ROOT, name);
    if (!existsSync(target)) {
      continue;
    }
    try {
      symlinkSync(target, join(root, name), 'junction');
    } catch (error) {
      throw new Error(`cannot mirror ${name} into the run root: ${error.code} ${error.message}`);
    }
  }
}

function runCoverage(tests, thresholds, env) {
  const args = [
    '--test',
    '--experimental-test-coverage',
    `--test-coverage-lines=${thresholds.lines}`,
    `--test-coverage-functions=${thresholds.functions}`,
    `--test-coverage-branches=${thresholds.branches}`,
    ...tests,
  ];
  const result = spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env,
  });
  if (result.error !== undefined) {
    process.stderr.write(`coverage: cannot start node --test: ${result.error.message}\n`);
    return 1;
  }
  return result.status ?? 1;
}

function main(argv) {
  let thresholds;
  try {
    thresholds = parseThresholds(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) {
      throw error;
    }
    process.stderr.write(`coverage: ${error.message}\n`);
    process.exitCode = 2;
    return;
  }

  const runRoot = createRunRoot();
  const outDir = join(runRoot.root, 'dist');
  let exitCode = 1;
  let summary;
  let cleanupError;

  try {
    try {
      mirrorRepository(runRoot.root);
    } catch (error) {
      process.stderr.write(`coverage: ${error.message}\n`);
      return;
    }
    const buildStatus = build(outDir, childEnv(runRoot.root));
    if (buildStatus !== 0) {
      process.stderr.write(`coverage: build failed (exit ${buildStatus})\n`);
      exitCode = buildStatus;
      return;
    }
    const tests = unitTestFiles(outDir);
    if (tests.length === 0) {
      process.stderr.write(`coverage: no compiled unit tests under ${outDir}\n`);
      return;
    }
    exitCode = runCoverage(tests, thresholds, childEnv(runRoot.root));
    process.stderr.write(
      `coverage: thresholds lines=${thresholds.lines} functions=${thresholds.functions}` +
        ` branches=${thresholds.branches} files=${tests.length} exit=${exitCode}\n`,
    );
  } finally {
    try {
      summary = cleanupRunRoot(runRoot);
    } catch (error) {
      cleanupError = error;
    }
    if (summary === undefined) {
      process.stderr.write(`CLEANUP_FAILED ${runRoot.root}\n`);
      process.stderr.write(`cleanup: ${cleanupError?.message ?? 'unknown error'}\n`);
      exitCode = exitCode === 0 ? 1 : exitCode;
    } else {
      process.stdout.write(`${formatRunRootSummary(summary)}\n`);
    }
    process.exitCode = exitCode;
  }
}

main(process.argv.slice(2));
