import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createKernel } from '../src/project/kernel.js';

function createProjectDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'wax-apiary-nexus-test-'));
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

test('does not expose mutable registry state through registration results', () => {
  const kernel = createKernel();
  const directory = createProjectDirectory();
  const registered = kernel.registerProject(directory, 'original-id');

  Reflect.set(registered, 'id', 'changed-id');
  Reflect.set(registered, 'directory', 'Z:/definitely-not-a-validated-project');

  const found = kernel.getProject('original-id');
  assert.equal(found?.id, 'original-id');
  assert.equal(found?.directory, directory);
  assert.equal(kernel.getProject('changed-id'), null);
  assert.throws(
    () => kernel.registerProject(createProjectDirectory(), 'original-id'),
    /already registered/,
  );
});

test('does not expose mutable registry state through query results', () => {
  const kernel = createKernel();
  const directory = createProjectDirectory();
  kernel.registerProject(directory, 'lookup-id');

  const found = kernel.getProject('lookup-id');
  assert.ok(found !== null);
  Reflect.set(found, 'id', 'modified-through-query');
  Reflect.set(found, 'directory', 'Z:/definitely-not-a-validated-project');

  const foundAgain = kernel.getProject('lookup-id');
  assert.equal(foundAgain?.id, 'lookup-id');
  assert.equal(foundAgain?.directory, directory);
});
