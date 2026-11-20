#!/usr/bin/env node
/**
 * Unit-test entry point.
 *
 * Creates this run's disposable root, moves the previous build output into it
 * (a move, not a delete), builds, runs `node --test`, then deletes the root in a
 * finally block and passes the child's exit code through. Any cleanup failure
 * prints `CLEANUP_FAILED <path>` and exits non-zero.
 *
 * Exit codes: the build/test exit code (1 if cleanup fails on a green run).
 */

import { existsSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  childEnv,
  cleanupRunRoot,
  createRunRoot,
  formatRunRootSummary,
} from './test-temp.mjs';

const dist = resolve('dist');
const runRoot = createRunRoot();
let exitCode = 1;
let summary;
let cleanupError;

try {
  archiveDist(runRoot.root);
  exitCode = buildAndTest(runRoot.root);
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
}

process.exitCode = exitCode;

// TypeScript does not remove compiled files for deleted sources. Move the
// previous output aside so an old test file can never run after its source was
// deleted. The archive lives inside the run root and is removed with it.
function archiveDist(root) {
  if (!existsSync(dist)) {
    return;
  }
  renameSync(dist, join(root, 'dist-archive'));
}

function buildAndTest(root) {
  const env = childEnv(root);
  const build = spawnSync('npm', ['run', 'build'], {
    stdio: 'inherit',
    shell: true,
    env,
  });
  if (build.status !== 0) {
    return build.status ?? 1;
  }

  const tests = spawnSync('node', ['--test', 'dist/tests/*.test.js'], {
    stdio: 'inherit',
    shell: true,
    env,
  });
  return tests.status ?? 1;
}
