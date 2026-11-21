#!/usr/bin/env node
/**
 * Disposable run root for the WAX test entry points.
 *
 * Every test run owns exactly one directory under the system temp root. The
 * child processes get TEMP/TMP/TMPDIR pointed at it, so every temporary file a
 * run creates lives inside that one root and is removed when the run ends.
 *
 * Removing that root is the only recursive delete in this repository. It is
 * narrowed to this run's own root by `assertSafeRunRoot`: the path must be
 * absolute, contain no wildcard syntax, resolve (realpath) to a direct child
 * of the system temp root, carry the unique `wax-test-<timestamp>-<pid>` name
 * created by this run, and be a real directory rather than a symlink or
 * reparse point. Anything else is refused with exit code 1 and nothing is
 * removed.
 *
 * Usage:
 *   node scripts/test-temp.mjs --self-check
 *   node scripts/test-temp.mjs --e2e
 *
 * `--self-check` covers the run-root contract itself. `--e2e` drives the real
 * test entry points (`scripts/test.mjs`, `scripts/test-runner.mjs`) and asserts
 * the cleanup paths: a failing build, a failing cleanup (`CLEANUP_FAILED`), and
 * cleanup on SIGINT. The e2e mode needs no build and never touches `dist/`.
 *
 * Exit codes: 0 = checks passed, 1 = a check failed.
 */

import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const RUN_ROOT_NAME = /^wax-test-\d+-\d+$/;
const WILDCARD = /[*?[\]]/;
const MAX_ATTEMPTS = 5;
const MAX_LINK_ATTEMPTS = 20;
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

/** A refused or failed run-root operation. `exitCode` is always non-zero. */
export class RunRootError extends Error {
  constructor(reason, detail, root) {
    super(`run root ${reason}: ${detail}`);
    this.name = 'RunRootError';
    this.reason = reason;
    this.root = root;
    this.exitCode = 1;
  }
}

function fail(reason, detail, root) {
  throw new RunRootError(reason, detail, root);
}

function normalized(path) {
  const absolute = resolve(path);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

/** The canonical system temp directory: the only allowed parent. */
export function systemTempRoot() {
  return realpathSync.native(tmpdir());
}

function assertPathShape(root) {
  if (typeof root !== 'string' || root.length === 0) {
    fail('invalid-path', 'path must be a non-empty string', String(root));
  }
  if (!isAbsolute(root)) {
    fail('invalid-path', `path must be absolute: ${root}`, root);
  }
  if (WILDCARD.test(root)) {
    fail('wildcard-path', `path must not contain wildcard syntax: ${root}`, root);
  }
}

function assertRealDirectory(root) {
  let stats;
  try {
    stats = lstatSync(root);
  } catch {
    fail('not-found', `path does not exist: ${root}`, root);
  }
  if (stats.isSymbolicLink()) {
    fail('reparse-point', `path is a symlink or reparse point: ${root}`, root);
  }
  if (!stats.isDirectory()) {
    fail('not-directory', `path is not a directory: ${root}`, root);
  }
}

function assertDirectChildOfTemp(realRoot) {
  const tempRoot = normalized(systemTempRoot());
  if (normalized(dirname(realRoot)) !== tempRoot) {
    fail('outside-temp', `${realRoot} is not a direct child of ${tempRoot}`, realRoot);
  }
}

function assertOwnName(realRoot, expectedName) {
  const name = basename(realRoot);
  if (!RUN_ROOT_NAME.test(name)) {
    fail('bad-name', `${name} does not match ${RUN_ROOT_NAME}`, realRoot);
  }
  if (expectedName !== undefined) {
    if (!RUN_ROOT_NAME.test(expectedName) || name !== expectedName) {
      fail('name-mismatch', `${name} is not this run's root ${expectedName}`, realRoot);
    }
  }
}

/**
 * Validate a run root for deletion. Read-only: it never removes anything.
 * Returns the realpath that a caller may delete.
 */
export function assertSafeRunRoot(root, expectedName) {
  assertPathShape(root);
  assertRealDirectory(root);
  const realRoot = realpathSync.native(root);
  assertRealDirectory(realRoot);
  assertDirectChildOfTemp(realRoot);
  assertOwnName(realRoot, expectedName);
  return realRoot;
}

let lastStamp = 0;
const activeRoots = new Map();

function nextName() {
  lastStamp = Math.max(Date.now(), lastStamp + 1);
  return `wax-test-${lastStamp}-${process.pid}`;
}

function collectTree(root) {
  const files = [];
  const dirs = [root];
  for (let index = 0; index < dirs.length; index += 1) {
    for (const entry of readdirSync(dirs[index], { withFileTypes: true })) {
      const child = join(dirs[index], entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink() && isRealDirectory(child)) {
        dirs.push(child);
      } else {
        files.push(child);
      }
    }
  }
  return { files, dirs };
}

function isRealDirectory(path) {
  try {
    const stats = lstatSync(path);
    return stats.isDirectory() && !stats.isSymbolicLink();
  } catch {
    return false;
  }
}

/** Delete one entry without following it: a link is removed, not traversed. */
function removeEntry(path) {
  try {
    unlinkSync(path);
  } catch (error) {
    if (error.code !== 'EPERM' && error.code !== 'EISDIR' && error.code !== 'EACCES') {
      throw error;
    }
    rmdirSync(path);
  }
}

function removeTree(root) {
  const { files, dirs } = collectTree(root);
  for (const file of files) {
    removeEntry(file);
  }
  for (let index = dirs.length - 1; index >= 0; index -= 1) {
    rmdirSync(dirs[index]);
  }
  return files.length;
}

function removeRoot(root, expectedName) {
  if (typeof expectedName !== 'string' || expectedName.length === 0) {
    fail('not-own-root', `refusing to remove ${root} without this run's name`, root);
  }
  const realRoot = assertSafeRunRoot(root, expectedName);
  const files = removeTree(realRoot);
  if (existsSync(realRoot)) {
    fail('remove-incomplete', `root still exists after removal: ${realRoot}`, realRoot);
  }
  activeRoots.delete(realRoot);
  return { root: realRoot, files, cleaned: true };
}

/**
 * Create this run's unique root and register it for exit-time cleanup.
 * Returns `{ root, name }`; pass the same handle to `cleanupRunRoot`.
 */
export function createRunRoot() {
  installExitCleanup();
  const tempRoot = systemTempRoot();
  let lastError;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const name = nextName();
    const root = join(tempRoot, name);
    try {
      mkdirSync(root);
    } catch (error) {
      lastError = error;
      continue;
    }
    const realRoot = assertSafeRunRoot(root, name);
    const handle = { root: realRoot, name };
    activeRoots.set(realRoot, handle);
    return handle;
  }
  fail('create-failed', `cannot allocate a unique run root: ${lastError?.message}`, tempRoot);
}

function ownRootHandle(handle) {
  if (handle === null || typeof handle !== 'object' || typeof handle?.root !== 'string') {
    fail(
      'not-own-root',
      'cleanup needs the { root, name } handle created by createRunRoot',
      String(handle),
    );
  }
  if (typeof handle.name !== 'string' || handle.name.length === 0) {
    fail('not-own-root', `cleanup of ${handle.root} needs this run's root name`, handle.root);
  }
  return { root: handle.root, name: handle.name };
}

/**
 * Delete this run's root, refusing anything the narrow exception does not cover.
 * Only the `{ root, name }` handle returned by `createRunRoot` is accepted: a
 * bare path string cannot prove that this run created the directory.
 */
export function cleanupRunRoot(handle) {
  const { root, name } = ownRootHandle(handle);
  return removeRoot(root, name);
}

/** Child environment with every temp variable pointed at the run root. */
export function childEnv(root) {
  return { ...process.env, TEMP: root, TMP: root, TMPDIR: root };
}

/** One machine-readable line; never contains prompts, output, or secrets. */
export function formatRunRootSummary(result) {
  return `runRoot=${result.root} files=${result.files} cleaned=${result.cleaned}`;
}

function removeActiveRoots() {
  for (const handle of [...activeRoots.values()]) {
    try {
      process.stdout.write(`${formatRunRootSummary(removeRoot(handle.root, handle.name))}\n`);
    } catch (error) {
      process.stderr.write(`CLEANUP_FAILED ${handle.root}\n`);
      process.exitCode = process.exitCode || error.exitCode || 1;
    }
  }
}

let exitCleanupInstalled = false;

/** Exit-time fallback for failures and signals that skip the normal finally. */
export function installExitCleanup() {
  if (exitCleanupInstalled) {
    return;
  }
  exitCleanupInstalled = true;
  process.on('exit', removeActiveRoots);
  process.on('SIGINT', () => {
    removeActiveRoots();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    removeActiveRoots();
    process.exit(143);
  });
}

function expectReject(label, root, expectedName, reason) {
  let caught;
  try {
    assertSafeRunRoot(root, expectedName);
  } catch (error) {
    caught = error;
  }
  if (caught === undefined) {
    throw new Error(`${label}: expected ${reason}, nothing was rejected`);
  }
  if (!(caught instanceof RunRootError) || caught.reason !== reason) {
    throw new Error(`${label}: expected ${reason}, got ${caught.message}`);
  }
  if (caught.exitCode !== 1) {
    throw new Error(`${label}: rejection must exit non-zero`);
  }
}

function checkLifecycle() {
  const handle = createRunRoot();
  writeFileSync(join(handle.root, 'first.txt'), 'a');
  mkdirSync(join(handle.root, 'nested'));
  writeFileSync(join(handle.root, 'nested', 'second.txt'), 'b');
  const summary = cleanupRunRoot(handle);
  if (summary.files !== 2) {
    throw new Error(`expected 2 files, counted ${summary.files}`);
  }
  if (summary.cleaned !== true || existsSync(handle.root)) {
    throw new Error('root still exists after cleanup');
  }
  return 'create+clean files=2 cleaned=true exists=false';
}

function checkRefusals() {
  const tempRoot = systemTempRoot();
  const missing = join(tempRoot, `wax-test-9${process.pid}-1`);
  if (existsSync(missing)) {
    throw new Error(`refusal probe unexpectedly exists: ${missing}`);
  }
  expectReject('missing', missing, undefined, 'not-found');
  expectReject('wildcard', join(tempRoot, 'wax-test-*-1'), undefined, 'wildcard-path');
  expectReject('outside-temp', join(process.cwd(), 'scripts'), 'wax-test-1-1', 'outside-temp');
  return 'missing + wildcard + outside-temp refused (exitCode=1, nothing deleted)';
}

function checkForeignName() {
  const handle = createRunRoot();
  expectReject('name-mismatch', handle.root, `${handle.name}1`, 'name-mismatch');
  if (!existsSync(handle.root)) {
    throw new Error('a mismatched name must not delete the root');
  }
  cleanupRunRoot(handle);
  return 'foreign name refused, own root untouched';
}

/**
 * Next candidate name for a junction probe. It must never equal the run root
 * that is being linked to: a symlink cannot be created where a directory
 * already exists, and silently colliding with our own root is exactly the bug
 * that used to turn this check into a skip. `lastStamp` is monotonic, so every
 * name handed out is distinct from every earlier run root in this process.
 */
function nextReparseName(targetName) {
  for (let attempt = 0; attempt < MAX_LINK_ATTEMPTS; attempt += 1) {
    const candidate = nextName();
    if (candidate !== targetName) {
      return candidate;
    }
  }
  throw new Error(`cannot pick a link name distinct from ${targetName}`);
}

/**
 * Create a junction to `targetRoot` under a name that is free. An `EEXIST`
 * (a previous crashed run left the name behind) is retried with the next
 * candidate; any other creation error is a hard failure. `preferredNames` lets
 * the self-check force an `EEXIST` on the first attempt.
 */
function createReparseProbe(targetRoot, preferredNames = []) {
  const targetName = basename(targetRoot);
  const tempRoot = systemTempRoot();
  let lastError;
  for (let attempt = 0; attempt < MAX_LINK_ATTEMPTS; attempt += 1) {
    const linkName = preferredNames[attempt] ?? nextReparseName(targetName);
    if (linkName === targetName || !RUN_ROOT_NAME.test(linkName)) {
      continue;
    }
    const linkPath = join(tempRoot, linkName);
    try {
      symlinkSync(targetRoot, linkPath, 'junction');
    } catch (error) {
      lastError = error;
      if (error.code === 'EEXIST') {
        continue;
      }
      throw new Error(`cannot create junction ${linkPath}: ${error.code} ${error.message}`);
    }
    return { linkName, linkPath };
  }
  throw new Error(
    `cannot create a unique junction for ${targetRoot}: ${lastError?.message ?? 'all names taken'}`,
  );
}

function checkReparsePoint() {
  const target = createRunRoot();
  let probe;
  try {
    probe = createReparseProbe(target.root);
    if (probe.linkName === target.name) {
      throw new Error('the junction link must not reuse the run root name');
    }
    if (!lstatSync(probe.linkPath).isSymbolicLink()) {
      throw new Error(`junction ${probe.linkPath} is not a reparse point`);
    }
    expectReject('reparse-point', probe.linkPath, probe.linkName, 'reparse-point');
    if (!existsSync(target.root)) {
      throw new Error('a reparse point must not delete its target');
    }
    let cleanupRejection;
    try {
      cleanupRunRoot({ root: probe.linkPath, name: probe.linkName });
    } catch (error) {
      cleanupRejection = error;
    }
    if (
      !(cleanupRejection instanceof RunRootError) ||
      cleanupRejection.reason !== 'reparse-point' ||
      cleanupRejection.exitCode !== 1
    ) {
      throw new Error(
        `deleting a reparse point as a run root must be refused, got ${
          cleanupRejection?.message ?? 'no error'
        }`,
      );
    }
    if (!existsSync(target.root)) {
      throw new Error('a refused cleanup of a reparse point must not delete its target');
    }
  } finally {
    if (probe !== undefined && existsSync(probe.linkPath)) {
      removeEntry(probe.linkPath);
    }
    cleanupRunRoot(target);
  }
  if (probe !== undefined && existsSync(probe.linkPath)) {
    throw new Error('junction probe was not removed');
  }
  return `junction ${probe.linkName} created, refused as reparse point, target untouched`;
}

/**
 * Force the `EEXIST` retry: occupy the first preferred name with a real
 * junction, then ask for a probe that wants that name. The second junction must
 * end up under a different name and still be refused as a reparse point.
 */
function checkReparseRetry() {
  const target = createRunRoot();
  let blocker;
  let probe;
  try {
    blocker = createReparseProbe(target.root);
    probe = createReparseProbe(target.root, [blocker.linkName]);
    if (probe.linkName === blocker.linkName) {
      throw new Error('EEXIST retry reused the occupied link name');
    }
    expectReject('retry', probe.linkPath, probe.linkName, 'reparse-point');
  } finally {
    if (probe !== undefined && existsSync(probe.linkPath)) {
      removeEntry(probe.linkPath);
    }
    if (blocker !== undefined && existsSync(blocker.linkPath)) {
      removeEntry(blocker.linkPath);
    }
    cleanupRunRoot(target);
  }
  return `EEXIST on ${blocker.linkName} retried to ${probe.linkName}`;
}

function checkBareStringRefused() {
  const handle = createRunRoot();
  for (const candidate of [handle.root, { root: handle.root }]) {
    let caught;
    try {
      cleanupRunRoot(candidate);
    } catch (error) {
      caught = error;
    }
    if (!(caught instanceof RunRootError) || caught.reason !== 'not-own-root') {
      throw new Error(`expected not-own-root, got ${caught?.message ?? 'no error'}`);
    }
    if (caught.exitCode !== 1) {
      throw new Error('refusal must exit non-zero');
    }
    if (!existsSync(handle.root)) {
      throw new Error('a refused cleanup must not delete the root');
    }
  }
  cleanupRunRoot(handle);
  if (existsSync(handle.root)) {
    throw new Error('own handle cleanup failed');
  }
  return 'bare string and missing name refused, own root untouched, handle cleaned';
}

function runSelfCheck() {
  const checks = [
    ['lifecycle', checkLifecycle],
    ['refusals', checkRefusals],
    ['foreign-name', checkForeignName],
    ['bare-string', checkBareStringRefused],
    ['reparse-point', checkReparsePoint],
    ['reparse-retry', checkReparseRetry],
  ];
  let failed = 0;
  for (const [label, check] of checks) {
    try {
      process.stdout.write(`self-check: ${label}: ${check()} -> PASS\n`);
    } catch (error) {
      failed += 1;
      process.stdout.write(`self-check: ${label}: FAIL ${error.message}\n`);
    }
  }
  if (failed > 0) {
    process.stdout.write(`self-check: failed ${failed}/${checks.length}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`self-check: ok (${checks.length} checks)\n`);
}

// ---------------------------------------------------------------------------
// End-to-end cleanup checks (`--e2e`).
//
// These drive the real entry points in a scratch project inside one disposable
// probe root. `test.mjs` is run with its cwd set to the scratch project, so its
// `dist` is the scratch `dist` and the repository build output is never touched
// or rebuilt; the scratch `build` script is a deliberate one-line failure.
// ---------------------------------------------------------------------------

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waxTempDirectories() {
  return readdirSync(systemTempRoot(), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('wax-'))
    .map((entry) => entry.name)
    .sort();
}

function combinedOutput(result) {
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

function assertNoCleanupFailure(label, result) {
  if (combinedOutput(result).includes('CLEANUP_FAILED')) {
    throw new Error(`${label}: the cleanup unexpectedly failed:\n${combinedOutput(result)}`);
  }
}

function runRootFromSummary(stdout) {
  const match = /runRoot=(.+?) files=(\d+) cleaned=true/.exec(stdout);
  if (match === null) {
    throw new Error(`no cleaned run-root summary in:\n${stdout}`);
  }
  return { root: match[1], files: Number(match[2]) };
}

function writeScratchPackage(scratch) {
  const pkg = {
    name: 'wax-e2e-build-failure',
    private: true,
    scripts: { build: 'node fail-build.mjs' },
  };
  writeFileSync(join(scratch, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  writeFileSync(
    join(scratch, 'fail-build.mjs'),
    "process.stderr.write('e2e fixture: build fails on purpose\\n');\nprocess.exit(3);\n",
  );
  mkdirSync(join(scratch, 'dist'));
  writeFileSync(join(scratch, 'dist', 'stale.js'), 'stale build output\n');
}

/** A failing build must still propagate its exit code and clean the run root. */
function e2eBuildFailure(scratchRoot) {
  const scratch = join(scratchRoot, 'build-failure');
  mkdirSync(scratch);
  writeScratchPackage(scratch);
  const result = spawnSync(process.execPath, [join(SCRIPT_DIR, 'test.mjs')], {
    cwd: scratch,
    env: childEnv(scratchRoot),
    encoding: 'utf8',
  });
  assertNoCleanupFailure('build-failure', result);
  const summary = runRootFromSummary(result.stdout ?? '');
  if (result.status !== 3) {
    throw new Error(
      `test.mjs must pass the build exit code 3 through, got ${result.status}:\n${combinedOutput(result)}`,
    );
  }
  if (existsSync(summary.root)) {
    throw new Error(`build-failure: declared run root still exists: ${summary.root}`);
  }
  if (existsSync(join(scratch, 'dist'))) {
    throw new Error('build-failure: the stale scratch dist was not archived and removed');
  }
  return {
    detail: `test.mjs exit=3, ${summary.root} cleaned, stale dist removed (files=${summary.files})`,
    roots: [summary.root],
  };
}

/**
 * A cleanup that cannot validate its root must print `CLEANUP_FAILED` and exit
 * non-zero. A test fixture renames the run root away, so the runner's finally
 * sees `not-found` instead of the root it created.
 */
function e2eCleanupFailure(scratchRoot) {
  const scratch = join(scratchRoot, 'cleanup-failure');
  mkdirSync(scratch);
  const log = join(scratch, 'renamed-root.txt');
  const fixture = join(scratch, 'detach-root.test.mjs');
  writeFileSync(
    fixture,
    [
      "import { renameSync, writeFileSync } from 'node:fs';",
      "import { dirname, join } from 'node:path';",
      'const runRoot = process.env.TEMP;',
      'let renamed;',
      'for (let attempt = 0; attempt < 20 && renamed === undefined; attempt += 1) {',
      '  const candidate = join(dirname(runRoot), `wax-test-${Date.now()}-${process.pid}`);',
      '  try {',
      '    renameSync(runRoot, candidate);',
      '    renamed = candidate;',
      '  } catch (error) {',
      "    if (!['EEXIST', 'EPERM', 'EACCES'].includes(error.code)) throw error;",
      '    await new Promise((resolve) => setTimeout(resolve, 10));',
      '  }',
      '}',
      "if (renamed === undefined) throw new Error('could not detach the run root');",
      'writeFileSync(process.env.WAX_E2E_LOG, `${renamed}\\n`);',
      '',
    ].join('\n'),
  );
  const result = spawnSync(process.execPath, [join(SCRIPT_DIR, 'test-runner.mjs'), fixture], {
    cwd: scratch,
    env: { ...childEnv(scratchRoot), WAX_E2E_LOG: log },
    encoding: 'utf8',
  });
  const output = combinedOutput(result);
  if (result.status !== 1) {
    throw new Error(`test-runner must exit 1 on cleanup failure, got ${result.status}:\n${output}`);
  }
  if (!/CLEANUP_FAILED .*wax-test-/.test(output)) {
    throw new Error(`cleanup failure did not print CLEANUP_FAILED:\n${output}`);
  }
  if (!/cleanup: run root not-found/.test(output)) {
    throw new Error(`cleanup failure did not report not-found:\n${output}`);
  }
  if (/cleaned=true/.test(output)) {
    throw new Error('a failed cleanup must not print a cleaned summary');
  }
  const renamed = readFileSync(log, 'utf8').trim();
  if (!existsSync(renamed)) {
    throw new Error(`the detached root is missing: ${renamed}`);
  }
  return {
    detail: `test-runner exit=1 + CLEANUP_FAILED, detached root ${renamed} (removed by probe cleanup)`,
    roots: [renamed],
  };
}

/** The SIGINT handler installed by the runner must clean its roots and exit 130. */
function e2eSimulatedSigint(scratchRoot) {
  const scratch = join(scratchRoot, 'sigint');
  mkdirSync(scratch);
  const log = join(scratch, 'root.txt');
  const fixture = join(scratch, 'sigint-probe.mjs');
  const importUrl = pathToFileURL(join(SCRIPT_DIR, 'test-temp.mjs')).href;
  writeFileSync(
    fixture,
    [
      `import { createRunRoot } from ${JSON.stringify(importUrl)};`,
      "import { writeFileSync } from 'node:fs';",
      'const handle = createRunRoot();',
      'writeFileSync(process.env.WAX_E2E_LOG, `${handle.root}\\n`);',
      "process.emit('SIGINT');",
      "process.stdout.write('signal handler did not exit the process\\n');",
      '',
    ].join('\n'),
  );
  const result = spawnSync(process.execPath, [fixture], {
    cwd: scratch,
    env: { ...childEnv(scratchRoot), WAX_E2E_LOG: log },
    encoding: 'utf8',
  });
  const output = combinedOutput(result);
  if (result.status !== 130) {
    throw new Error(`SIGINT handler must exit 130, got ${result.status}:\n${output}`);
  }
  if (/signal handler did not exit/.test(output)) {
    throw new Error('the process continued after SIGINT');
  }
  const root = readFileSync(log, 'utf8').trim();
  if (existsSync(root)) {
    throw new Error(`SIGINT handler did not clean its run root: ${root}`);
  }
  return { detail: `child exit=130, ${root} cleaned`, roots: [root] };
}

/**
 * Real console Ctrl+C cannot be delivered from a non-interactive Windows
 * process: `child.kill('SIGINT')` terminates the child without running JS
 * handlers. The probe documents that limitation instead of claiming a pass.
 */
async function e2eRealSigint(scratchRoot) {
  const scratch = join(scratchRoot, 'real-sigint');
  mkdirSync(scratch);
  const log = join(scratch, 'root.txt');
  const fixture = join(scratch, 'alive-probe.mjs');
  const importUrl = pathToFileURL(join(SCRIPT_DIR, 'test-temp.mjs')).href;
  writeFileSync(
    fixture,
    [
      `import { createRunRoot } from ${JSON.stringify(importUrl)};`,
      "import { writeFileSync } from 'node:fs';",
      'const handle = createRunRoot();',
      'writeFileSync(process.env.WAX_E2E_LOG, `${handle.root}\\n`);',
      'setInterval(() => {}, 1000);',
      '',
    ].join('\n'),
  );
  const child = spawn(process.execPath, [fixture], {
    cwd: scratch,
    env: { ...childEnv(scratchRoot), WAX_E2E_LOG: log },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let childOutput = '';
  child.stdout.on('data', (chunk) => {
    childOutput += chunk;
  });
  child.stderr.on('data', (chunk) => {
    childOutput += chunk;
  });
  let root;
  for (let attempt = 0; attempt < 200 && root === undefined; attempt += 1) {
    sleepSync(25);
    if (existsSync(log)) {
      root = readFileSync(log, 'utf8').trim();
    }
  }
  if (root === undefined || root.length === 0) {
    child.kill();
    throw new Error(`real-sigint probe never reported its root:\n${childOutput}`);
  }
  child.kill('SIGINT');
  const exit = await new Promise((resolveExit) => {
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
  });
  const survived = existsSync(root);
  return {
    blocked: true,
    detail:
      `child.kill('SIGINT') -> code=${exit.code} signal=${exit.signal}, ` +
      `run root survived=${survived} (OS termination skips Node signal handlers); ` +
      `root ${root} removed by probe cleanup`,
    roots: [root],
  };
}

async function runE2E() {
  const before = waxTempDirectories();
  const probe = createRunRoot();
  const declaredRoots = [];
  const results = [];
  let failed = 0;

  const scenarios = [
    ['build-failure', () => e2eBuildFailure(probe.root), true],
    ['cleanup-failure', () => e2eCleanupFailure(probe.root), true],
    ['sigint-simulated', () => e2eSimulatedSigint(probe.root), true],
    ['sigint-real', () => e2eRealSigint(probe.root), false],
  ];

  try {
    for (const [label, scenario, blockedIsFailure] of scenarios) {
      try {
        const outcome = await scenario();
        if (outcome.blocked !== true) {
          process.stdout.write(`e2e: ${label}: PASS ${outcome.detail}\n`);
          results.push({ label, status: 'PASS' });
        } else {
          process.stdout.write(`e2e: ${label}: BLOCKED ${outcome.detail}\n`);
          results.push({ label, status: 'BLOCKED' });
          if (blockedIsFailure) {
            failed += 1;
          }
        }
        declaredRoots.push(...outcome.roots);
      } catch (error) {
        failed += 1;
        process.stdout.write(`e2e: ${label}: FAIL ${error.message}\n`);
        results.push({ label, status: 'FAIL' });
      }
    }
  } finally {
    let cleaned;
    let cleanupError;
    try {
      cleaned = cleanupRunRoot(probe);
    } catch (error) {
      cleanupError = error;
    }
    if (cleaned === undefined) {
      process.stderr.write(`CLEANUP_FAILED ${probe.root}\n`);
      process.stderr.write(`cleanup: ${cleanupError?.message ?? 'unknown error'}\n`);
      failed += 1;
    }
    const after = waxTempDirectories();
    const afterRunRoots = after.filter((name) => name.startsWith('wax-test-'));
    const planted = declaredRoots.filter((root) => existsSync(root));
    process.stdout.write(
      `e2e: temp wax-* before=${before.length} after=${after.length} ` +
        `wax-test-*=${afterRunRoots.length}\n`,
    );
    if (planted.length > 0) {
      failed += 1;
      process.stdout.write(`e2e: declared roots still exist: ${planted.join(', ')}\n`);
    }
    if (afterRunRoots.length > 0) {
      failed += 1;
      process.stdout.write(`e2e: leftover wax-test-* dirs: ${afterRunRoots.join(', ')}\n`);
    }
    if (cleaned !== undefined) {
      process.stdout.write(`${formatRunRootSummary(cleaned)}\n`);
    }
  }

  const passed = results.filter((entry) => entry.status === 'PASS').length;
  const blocked = results.filter((entry) => entry.status === 'BLOCKED').length;
  if (failed > 0) {
    process.stdout.write(`e2e: failed ${failed}/${scenarios.length}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`e2e: ok (${passed} passed, ${blocked} blocked)\n`);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  if (process.argv.includes('--self-check')) {
    runSelfCheck();
  } else if (process.argv.includes('--e2e')) {
    await runE2E();
  } else {
    process.stderr.write('usage: node scripts/test-temp.mjs --self-check|--e2e\n');
    process.exitCode = 2;
  }
}
