import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ArtifactError, ArtifactStore } from '../src/storage/artifact-store.js';
import type { Attachment } from '../src/shared/content.js';

function setup(maxBytes?: number) {
  const root = mkdtempSync(join(tmpdir(), 'uw-artifacts-test-'));
  const sourceDir = mkdtempSync(join(tmpdir(), 'uw-artifacts-src-'));
  const store = new ArtifactStore({ root, ...(maxBytes === undefined ? {} : { maxBytes }) });
  return { root, sourceDir, store };
}

function attachment(path: string, overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: 'source-id',
    kind: 'image',
    path,
    mimeType: 'image/png',
    name: 'image.png',
    ...overrides,
  };
}

test('registers a regular file with a content-addressed id and reads it back', () => {
  const { sourceDir, store } = setup();
  const source = join(sourceDir, 'source.bin');
  const bytes = Buffer.from('not really a png');
  writeFileSync(source, bytes);

  const artifact = store.register(attachment(source, { name: 'image.png' }));
  assert.match(artifact.id, /^[a-f0-9]{64}$/);
  assert.equal(artifact.byteLength, bytes.byteLength);
  assert.deepEqual(store.get(artifact.id), artifact);
  assert.deepEqual(store.read(artifact.id), bytes);
  assert.equal(store.get('../etc/passwd'), undefined);
  store.close();
});

test('deduplicates identical content and returns the same artifact', () => {
  const { sourceDir, store } = setup();
  const source = join(sourceDir, 'a.png');
  writeFileSync(source, Buffer.from('same'));

  const first = store.register(attachment(source));
  const second = store.register(attachment(source, { name: 'other.png' }));
  assert.equal(first.id, second.id);
  assert.equal(second.name, first.name);
  store.close();
});

test('rejects unsupported types, oversized files, missing files and symlinks', () => {
  const { root, sourceDir, store } = setup(4);
  const source = join(sourceDir, 'a.png');
  writeFileSync(source, Buffer.from('12345'));

  assert.throws(
    () => store.register(attachment(source, { mimeType: 'text/html' })),
    (error: unknown) => error instanceof ArtifactError && error.code === 'unsupported-type',
  );
  assert.throws(
    () => store.register(attachment(source)),
    (error: unknown) => error instanceof ArtifactError && error.code === 'too-large',
  );
  assert.throws(
    () => store.register(attachment(join(sourceDir, 'missing.png'))),
    (error: unknown) => error instanceof ArtifactError && error.code === 'not-a-file',
  );

  const link = join(sourceDir, 'link.png');
  try {
    symlinkSync(source, link);
    assert.throws(
      () => store.register(attachment(link)),
      (error: unknown) => error instanceof ArtifactError && error.code === 'not-a-file',
    );
  } catch (error) {
    if (process.platform !== 'win32') throw error;
    // File symlinks can require developer mode; a directory junction is a
    // reparse point available without that privilege and must also be rejected.
    const targetDir = join(sourceDir, 'target-dir');
    mkdirSync(targetDir);
    const junction = join(sourceDir, 'junction.png');
    symlinkSync(targetDir, junction, 'junction');
    assert.throws(
      () => store.register(attachment(junction)),
      (expected: unknown) => expected instanceof ArtifactError && expected.code === 'not-a-file',
    );
  }
  store.close();
  assert.equal(existsSync(root), false);
});

test('returns undefined instead of a path after close', () => {
  const { sourceDir, store } = setup();
  const source = join(sourceDir, 'a.png');
  writeFileSync(source, Buffer.from('x'));
  const artifact = store.register(attachment(source));
  store.close();
  assert.throws(() => store.read(artifact.id), /closed/);
});
