import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCodexHostConfig,
  buildDshMcpServers,
  parseDelegationCliArgs,
  resolveCodexExecutableOption,
} from '../src/delegation-cli.js';

const info = { url: 'http://127.0.0.1:1234/delegate', token: 'test-token' };
const bridgePath = 'C:/workspace/dist/src/mcp-delegate-bridge.js';

test('defaults to a Codex host and a DSH worker', () => {
  const options = parseDelegationCliArgs(['./project']);
  assert.equal(options?.projectDir, './project');
  assert.equal(options?.host, 'codex');
  assert.equal(options?.worker, 'dsh');
  assert.equal(options?.maxTaskChars, 20_000);
  assert.equal(options?.task, undefined);
});

test('parses host, worker, task and state directory', () => {
  const options = parseDelegationCliArgs([
    './project',
    '--host',
    'dsh',
    '--worker',
    'codex',
    '--task',
    'reply WORKER-OK',
    '--state-dir',
    './state',
    '--max-task-chars',
    '500',
  ]);
  assert.equal(options?.host, 'dsh');
  assert.equal(options?.worker, 'codex');
  assert.equal(options?.task, 'reply WORKER-OK');
  assert.equal(options?.stateDirectory, './state');
  assert.equal(options?.maxTaskChars, 500);
});

test('rejects missing project, unknown options and invalid values', () => {
  assert.throws(() => parseDelegationCliArgs([]), /Missing project directory/);
  assert.throws(() => parseDelegationCliArgs(['./p', '--host', 'other']), /--host/);
  assert.throws(() => parseDelegationCliArgs(['./p', '--worker', 'other']), /--worker/);
  assert.throws(() => parseDelegationCliArgs(['./p', '--nope']), /Unknown option/);
  assert.throws(() => parseDelegationCliArgs(['./p', '--max-task-chars', '0']), /max-task-chars/);
  assert.throws(() => parseDelegationCliArgs(['./p', '--host']), /Missing value/);
});

test('builds the Codex MCP config with an object env', () => {
  const config = buildCodexHostConfig(bridgePath, info, 'dsh');
  const server = (config.mcp_servers as Record<string, Record<string, unknown>>).unified_delegate;
  assert.equal(server?.command, process.execPath);
  assert.deepEqual(server?.args, [bridgePath]);
  assert.deepEqual(server?.env, {
    UW_GATEWAY_URL: info.url,
    UW_GATEWAY_TOKEN: info.token,
    UW_WORKER: 'dsh',
  });
});

test('builds the DSH mcpServers declaration with an array env', () => {
  const servers = buildDshMcpServers(bridgePath, info, 'codex');
  assert.equal(servers.length, 1);
  const server = servers[0];
  assert.equal(server?.name, 'unified_delegate');
  assert.equal(server?.command, process.execPath);
  assert.deepEqual(server?.args, [bridgePath]);
  assert.deepEqual(server?.env, [
    { name: 'UW_GATEWAY_URL', value: info.url },
    { name: 'UW_GATEWAY_TOKEN', value: info.token },
    { name: 'UW_WORKER', value: 'codex' },
  ]);
});

test('prefers --codex-exe, then CODEX_EXE, then PATH lookup', () => {
  assert.equal(resolveCodexExecutableOption({ codexExe: 'C:/flag/codex.exe' }, { CODEX_EXE: 'C:/env/codex.exe' }), 'C:/flag/codex.exe');
  assert.equal(resolveCodexExecutableOption({}, { CODEX_EXE: 'C:/env/codex.exe' }), 'C:/env/codex.exe');
  assert.equal(resolveCodexExecutableOption({}, { CODEX_EXE: '   ' }), undefined);
  assert.equal(resolveCodexExecutableOption({}, {}), undefined);
});
