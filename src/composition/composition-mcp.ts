import { fileURLToPath } from 'node:url';

import type { HarnessKind } from '../session/connection.js';

/**
 * One opt-in MCP server per harness, named `wax_composition`, launched as
 * `process.execPath <absolute mcp-server.js>`. The declaration shapes are not
 * interchangeable: Codex takes `config.mcp_servers.<name>.env` as an object,
 * while ACP `session/new.mcpServers[].env` is an array. This module builds the
 * exact shape for each harness; no shell string is ever involved.
 */
export const COMPOSITION_MCP_SERVER_NAME = 'wax_composition';

export interface CompositionMcpBuildOptions {
  /** Node executable used to launch the server; defaults to the current one. */
  readonly execPath?: string;
  /** Built `mcp-server.js`; defaults to the sibling of this compiled module. */
  readonly serverPath?: string;
}

export interface CodexMcpServerConfig {
  readonly [key: string]: unknown;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Record<string, string>;
}

export interface CodexCompositionMcpConfig {
  readonly [key: string]: unknown;
  readonly mcp_servers: Record<string, CodexMcpServerConfig>;
}

export interface DshMcpServerDeclaration {
  readonly [key: string]: unknown;
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: ReadonlyArray<{ readonly name: string; readonly value: string }>;
}

/** Absolute path of the built server next to this module (`dist/src/cli/mcp-server.js`). */
export function compositionMcpServerPath(): string {
  return fileURLToPath(new URL('../cli/mcp-server.js', import.meta.url));
}

export function codexCompositionMcpConfig(
  options: CompositionMcpBuildOptions = {},
): CodexCompositionMcpConfig {
  const command = options.execPath ?? process.execPath;
  const serverPath = options.serverPath ?? compositionMcpServerPath();
  return {
    mcp_servers: {
      [COMPOSITION_MCP_SERVER_NAME]: { command, args: [serverPath], env: {} },
    },
  };
}

export function dshCompositionMcpServers(
  options: CompositionMcpBuildOptions = {},
): readonly DshMcpServerDeclaration[] {
  const command = options.execPath ?? process.execPath;
  const serverPath = options.serverPath ?? compositionMcpServerPath();
  return [{ name: COMPOSITION_MCP_SERVER_NAME, command, args: [serverPath], env: [] }];
}

/**
 * The adapter-specific declaration for one harness. `createDefaultAdapter`
 * spreads exactly one of these two keys into the existing adapter options, so
 * `wax run`/`wax daemon` only opt in when `--composition-tools` is given.
 */
export interface CompositionToolAdapterConfig {
  /** Codex `thread/start` config. */
  readonly config?: CodexCompositionMcpConfig;
  /** DSH ACP `session/new` MCP declarations. */
  readonly mcpServers?: readonly DshMcpServerDeclaration[];
}

export function compositionToolAdapterConfig(
  harness: HarnessKind,
  options: CompositionMcpBuildOptions = {},
): CompositionToolAdapterConfig {
  if (harness === 'codex') {
    return { config: codexCompositionMcpConfig(options) };
  }
  return { mcpServers: dshCompositionMcpServers(options) };
}
