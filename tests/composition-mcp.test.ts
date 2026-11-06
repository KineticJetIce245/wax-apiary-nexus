import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import test from 'node:test';

import { DshAcpAdapter } from '../src/adapters/dsh-acp/adapter.js';
import { createDefaultAdapter } from '../src/cli/cli-shared.js';
import {
  COMPOSITION_MCP_SERVER_NAME,
  codexCompositionMcpConfig,
  compositionMcpServerPath,
  compositionToolAdapterConfig,
  dshCompositionMcpServers,
} from '../src/composition/composition-mcp.js';

const FAKE_EXEC = resolve('fake-node');
const FAKE_SERVER = resolve('fake', 'dist', 'src', 'cli', 'mcp-server.js');

test('builds the exact Codex MCP config for wax_composition', () => {
  const config = codexCompositionMcpConfig({ execPath: FAKE_EXEC, serverPath: FAKE_SERVER });

  assert.deepEqual(config, {
    mcp_servers: {
      [COMPOSITION_MCP_SERVER_NAME]: {
        command: FAKE_EXEC,
        args: [FAKE_SERVER],
        env: {},
      },
    },
  });
  assert.deepEqual(Object.keys(config.mcp_servers), ['wax_composition']);
  assert.equal(Array.isArray(config.mcp_servers['wax_composition']?.env), false);
});

test('the default Codex config uses process.execPath and the absolute built server', () => {
  const server = codexCompositionMcpConfig().mcp_servers[COMPOSITION_MCP_SERVER_NAME];
  assert.ok(server !== undefined);
  assert.equal(server.command, process.execPath);
  assert.deepEqual(server.args, [compositionMcpServerPath()]);
  assert.equal(isAbsolute(server.args[0] as string), true);
  assert.equal(existsSync(server.args[0] as string), true);
  assert.match((server.args[0] as string).replaceAll('\\', '/'), /\/dist\/src\/cli\/mcp-server\.js$/);
  assert.deepEqual(server.env, {});
});

test('builds the exact DSH ACP mcpServers declaration for wax_composition', () => {
  const declarations = dshCompositionMcpServers({ execPath: FAKE_EXEC, serverPath: FAKE_SERVER });

  assert.deepEqual(declarations, [
    {
      name: 'wax_composition',
      command: FAKE_EXEC,
      args: [FAKE_SERVER],
      env: [],
    },
  ]);
  assert.equal(Array.isArray(declarations), true);
  assert.deepEqual(declarations[0]?.name, COMPOSITION_MCP_SERVER_NAME);
});

test('the default DSH declaration uses process.execPath and the absolute built server', () => {
  const declarations = dshCompositionMcpServers();
  assert.equal(declarations.length, 1);
  const declaration = declarations[0];
  assert.ok(declaration !== undefined);
  assert.equal(declaration.command, process.execPath);
  assert.deepEqual(declaration.args, [compositionMcpServerPath()]);
  assert.equal(isAbsolute(declaration.args[0] as string), true);
  assert.equal(existsSync(declaration.args[0] as string), true);
  assert.deepEqual(declaration.env, []);
});

test('selects the harness-specific adapter config shape', () => {
  const codex = compositionToolAdapterConfig('codex', {
    execPath: FAKE_EXEC,
    serverPath: FAKE_SERVER,
  });
  assert.equal('config' in codex, true);
  assert.equal('mcpServers' in codex, false);
  assert.deepEqual(codex.config, codexCompositionMcpConfig({ execPath: FAKE_EXEC, serverPath: FAKE_SERVER }));

  const dsh = compositionToolAdapterConfig('dsh', {
    execPath: FAKE_EXEC,
    serverPath: FAKE_SERVER,
  });
  assert.equal('mcpServers' in dsh, true);
  assert.equal('config' in dsh, false);
  assert.deepEqual(dsh.mcpServers, dshCompositionMcpServers({ execPath: FAKE_EXEC, serverPath: FAKE_SERVER }));
});

test('createDefaultAdapter injects the DSH declaration only when enabled', async () => {
  const dshRoot = mkdtempSync(join(tmpdir(), 'wax-composition-mcp-dsh-'));

  const enabled = await createDefaultAdapter({
    harness: 'dsh',
    dshRoot,
    compositionTools: true,
  });
  assert.ok(enabled instanceof DshAcpAdapter);
  assert.deepEqual(
    (enabled as unknown as { mcpServers: unknown }).mcpServers,
    dshCompositionMcpServers(),
  );

  const disabled = await createDefaultAdapter({ harness: 'dsh', dshRoot });
  assert.deepEqual((disabled as unknown as { mcpServers: unknown }).mcpServers, []);
});
