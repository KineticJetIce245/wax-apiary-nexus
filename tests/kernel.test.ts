import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createKernel } from '../src/kernel.js';

function createProjectDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'unified-workspace-g001-'));
}

test('registers an existing directory and finds it by ID', () => {
  const kernel = createKernel();
  const directory = createProjectDirectory();

  const project = kernel.registerProject(directory);
  const found = kernel.getProject(project.id);

  assert.notEqual(project.id, '');
  assert.equal(project.directory, directory);
  assert.ok(found !== null);
  assert.equal(found.id, project.id);
  assert.equal(found.directory, directory);
});

test('returns null for an unknown project ID', () => {
  const kernel = createKernel();

  assert.equal(kernel.getProject('missing'), null);
});

test('rejects a duplicate ID without replacing the registered project', () => {
  const kernel = createKernel();
  const firstDirectory = createProjectDirectory();
  const secondDirectory = createProjectDirectory();
  const project = kernel.registerProject(firstDirectory, 'fixed-id');

  assert.throws(
    () => kernel.registerProject(secondDirectory, 'fixed-id'),
    /already registered/,
  );

  const found = kernel.getProject('fixed-id');
  assert.equal(found?.id, project.id);
  assert.equal(found?.directory, firstDirectory);
});

test('rejects a missing directory without reserving the ID', () => {
  const kernel = createKernel();
  const missingDirectory = join(createProjectDirectory(), 'missing');

  assert.throws(
    () => kernel.registerProject(missingDirectory, 'missing-id'),
    /does not exist/,
  );

  const directory = createProjectDirectory();
  kernel.registerProject(directory, 'missing-id');
  assert.equal(kernel.getProject('missing-id')?.directory, directory);
});

test('rejects a path that is a regular file', () => {
  const kernel = createKernel();
  const directory = createProjectDirectory();
  const file = join(directory, 'notes.txt');
  writeFileSync(file, 'not a project directory');

  assert.throws(
    () => kernel.registerProject(file, 'file-id'),
    /not a directory/,
  );
  assert.equal(kernel.getProject('file-id'), null);
});

test('keeps the state of separate kernels independent', () => {
  const firstKernel = createKernel();
  const secondKernel = createKernel();
  const firstDirectory = createProjectDirectory();
  const secondDirectory = createProjectDirectory();

  firstKernel.registerProject(firstDirectory, 'shared-id');

  assert.equal(secondKernel.getProject('shared-id'), null);

  secondKernel.registerProject(secondDirectory, 'shared-id');

  assert.equal(firstKernel.getProject('shared-id')?.directory, firstDirectory);
  assert.equal(secondKernel.getProject('shared-id')?.directory, secondDirectory);
});
