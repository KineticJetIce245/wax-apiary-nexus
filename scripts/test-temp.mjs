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
 *
 * Exit codes: 0 = checks passed, 1 = a check failed.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const RUN_ROOT_NAME = /^wax-test-\d+-\d+$/;
const WILDCARD = /[*?[\]]/;
const MAX_ATTEMPTS = 5;

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

function checkReparsePoint() {
  const target = createRunRoot();
  const linkName = `wax-test-${Date.now()}-${process.pid}`;
  const linkPath = join(systemTempRoot(), linkName);
  try {
    symlinkSync(target.root, linkPath, 'junction');
  } catch (error) {
    cleanupRunRoot(target);
    return `skipped (cannot create junction: ${error.code})`;
  }
  try {
    expectReject('reparse-point', linkPath, linkName, 'reparse-point');
    if (!existsSync(target.root)) {
      throw new Error('a reparse point must not delete its target');
    }
    cleanupRunRoot({ root: linkPath, name: linkName });
    throw new Error('a reparse point must not be deleted as a run root');
  } catch (error) {
    if (!(error instanceof RunRootError) || error.reason !== 'reparse-point') {
      throw error;
    }
  } finally {
    if (existsSync(linkPath)) {
      removeEntry(linkPath);
    }
    cleanupRunRoot(target);
  }
  if (existsSync(linkPath)) {
    throw new Error('junction probe was not removed');
  }
  return 'junction refused as reparse point, target untouched';
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

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  if (process.argv.includes('--self-check')) {
    runSelfCheck();
  } else {
    process.stderr.write('usage: node scripts/test-temp.mjs --self-check\n');
    process.exitCode = 2;
  }
}
