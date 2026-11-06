import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ConnectionConfigError,
  assertCodexVersion,
  buildCodexLaunch,
  isSupportedCodexVersion,
  loadConnectionConfig,
  parseCodexVersion,
  parseConnectionConfig,
  resolveCodexExecutable,
} from '../src/session/connection.js';

test('parses a minimal local Codex connection', () => {
  assert.deepEqual(
    parseConnectionConfig({ harness: 'codex', connection: 'local', executable: 'C:/tools/codex.exe' }),
    { harness: 'codex', connection: 'local', executable: 'C:/tools/codex.exe' },
  );
});

test('rejects remote connections and unknown fields', () => {
  assert.throws(
    () => parseConnectionConfig({ harness: 'codex', connection: 'remote' }),
    /local/,
  );
  assert.throws(
    () => parseConnectionConfig({ harness: 'codex', connection: 'local', script: 'evil.js' }),
    /Unsupported connection config field/,
  );
  assert.throws(() => parseConnectionConfig({ harness: 'cline', connection: 'local' }), /harness/);
  assert.throws(() => parseConnectionConfig('nope'), /JSON object/);
});

test('reports an unreadable or invalid config file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uw-config-'));
  assert.throws(() => loadConnectionConfig(join(dir, 'missing.json')), ConnectionConfigError);
  const bad = join(dir, 'bad.json');
  writeFileSync(bad, '{ not json', 'utf8');
  assert.throws(() => loadConnectionConfig(bad), /not valid JSON/);
});

test('rejects an explicit executable override that does not exist', () => {
  assert.throws(
    () => resolveCodexExecutable(join(tmpdir(), `uw-missing-${Date.now()}`, 'codex.exe')),
    /Codex executable not found/,
  );
});

test('finds codex on PATH without changing global state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uw-path-'));
  const name = process.platform === 'win32' ? 'codex.exe' : 'codex';
  const executable = join(dir, name);
  writeFileSync(executable, '', 'utf8');
  assert.equal(resolveCodexExecutable(undefined, { PATH: dir }), executable);
});

test('rejects Windows command shims instead of finding them', () => {
  if (process.platform !== 'win32') {
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'uw-shim-'));
  const shim = join(dir, 'codex.cmd');
  writeFileSync(shim, '@echo off\r\n', 'utf8');
  assert.throws(() => resolveCodexExecutable(undefined, { PATH: dir }), /command shim|native executables/);
  assert.throws(() => resolveCodexExecutable(shim), /command shim|native executables/);
});

test('runs the version probe against a native executable and rejects non-Codex output', async () => {
  await assert.rejects(assertCodexVersion(process.execPath), /Could not parse/);
});

test('reports a missing codex with an actionable error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uw-empty-path-'));
  assert.throws(() => resolveCodexExecutable(undefined, { PATH: dir }), /not found on PATH/);
  assert.throws(() => resolveCodexExecutable(undefined, { PATH: '' }), /PATH is empty/);
});

test('parses the codex-cli version string', () => {
  assert.equal(parseCodexVersion('codex-cli 0.166.0-alpha.5.1'), '0.166.0');
  assert.equal(parseCodexVersion('codex-cli 1.2.3'), '1.2.3');
  assert.equal(parseCodexVersion('not codex'), undefined);
});

test('enforces the documented minimum version', () => {
  assert.equal(isSupportedCodexVersion('0.166.0'), true);
  assert.equal(isSupportedCodexVersion('0.166.1'), true);
  assert.equal(isSupportedCodexVersion('0.165.9'), false);
  assert.equal(isSupportedCodexVersion('1.0.0'), true);
});

test('suppresses the native notify hook by default without editing config', () => {
  const launch = buildCodexLaunch('C:/codex.exe');
  assert.deepEqual(launch, { file: 'C:/codex.exe', args: ['app-server', '-c', 'notify=[]'] });
  const native = buildCodexLaunch('C:/codex.exe', { notify: 'native' });
  assert.deepEqual(native, { file: 'C:/codex.exe', args: ['app-server'] });
});
