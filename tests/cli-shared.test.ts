import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { findDshPluginPatch, sessionDisplayName } from '../src/cli-shared.js';

test('caps session display names at the DSH native title byte limit', () => {
  const name = sessionDisplayName('a'.repeat(64), 'b'.repeat(64));
  assert.equal(name.length, 80);
  assert.equal(Buffer.byteLength(name, 'utf8'), 80);
  assert.match(name, /^wax-apiary-nexus-session-/);
  assert.doesNotMatch(name, /[-.]$/);
});

test('keeps short session display names unchanged', () => {
  assert.equal(
    sessionDisplayName('apiary', 'composition'),
    'wax-apiary-nexus-session-apiary-composition',
  );
});

test('finds dsh-plugins/acp.patch.yml by walking up from the module', () => {
  const root = mkdtempSync(join(tmpdir(), 'wax-plugin-root-'));
  const pluginDir = join(root, 'dsh-plugins');
  mkdirSync(pluginDir);
  const patch = join(pluginDir, 'acp.patch.yml');
  writeFileSync(patch, '[]\n');
  const start = pathToFileURL(join(root, 'repo', 'dist', 'src', 'cli-shared.js'));
  assert.equal(findDshPluginPatch(start), patch);
});

test('returns undefined when no dsh-plugins overlay is within the search depth', () => {
  let directory = mkdtempSync(join(tmpdir(), 'wax-plugin-none-'));
  for (let depth = 0; depth < 13; depth += 1) {
    directory = join(directory, `level-${depth}`);
  }
  mkdirSync(directory, { recursive: true });
  assert.equal(findDshPluginPatch(pathToFileURL(join(directory, 'cli-shared.js'))), undefined);
});
