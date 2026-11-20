#!/usr/bin/env node
/**
 * Integration-test entry point.
 *
 * Creates this run's disposable root, points the child's TEMP/TMP/TMPDIR at it,
 * runs `node --test <targets...>`, then deletes the root in a finally block and
 * passes the child's exit code through. Any cleanup failure prints
 * `CLEANUP_FAILED <path>` and exits non-zero.
 *
 * Usage:
 *   node scripts/test-runner.mjs <test-target...>
 *
 * Exit codes: the child's exit code (1 if cleanup fails on an otherwise green run).
 */

import { spawnSync } from 'node:child_process';
import {
  childEnv,
  cleanupRunRoot,
  createRunRoot,
  formatRunRootSummary,
} from './test-temp.mjs';

const targets = process.argv.slice(2);

if (targets.length === 0) {
  process.stderr.write('usage: node scripts/test-runner.mjs <test-target...>\n');
  process.exitCode = 2;
} else {
  runTests(targets);
}

function runTests(testTargets) {
  const runRoot = createRunRoot();
  let exitCode = 1;
  let summary;
  let cleanupError;

  try {
    const result = spawnSync(process.execPath, ['--test', ...testTargets], {
      stdio: 'inherit',
      env: childEnv(runRoot.root),
    });
    if (result.error !== undefined) {
      process.stderr.write(`test-runner: cannot start node --test: ${result.error.message}\n`);
    } else {
      exitCode = result.status ?? 1;
    }
  } finally {
    try {
      summary = cleanupRunRoot(runRoot);
    } catch (error) {
      cleanupError = error;
    }
    process.exitCode = exitCode;
    if (summary === undefined) {
      process.stderr.write(`CLEANUP_FAILED ${runRoot.root}\n`);
      process.stderr.write(`cleanup: ${cleanupError?.message ?? 'unknown error'}\n`);
      process.exitCode = exitCode === 0 ? 1 : exitCode;
    } else {
      process.stdout.write(`${formatRunRootSummary(summary)}\n`);
    }
  }
}
