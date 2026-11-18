import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CodexAppServerAdapter } from '../adapters/codex/adapter.js';
import { DshAcpAdapter } from '../adapters/dsh-acp/adapter.js';
import type { HarnessAdapter } from '../adapters/harness.js';
import { createCodexConnection, type HarnessKind } from '../session/connection.js';

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

export interface AdapterRequest {
  readonly harness: HarnessKind;
  /** Codex executable override; only meaningful when `harness` is `codex`. */
  readonly executable?: string;
  /** DSH checkout root; only meaningful when `harness` is `dsh`. */
  readonly dshRoot?: string;
}

export interface HarnessSelection {
  readonly harness: HarnessKind;
  readonly dshRoot?: string;
  readonly codexExe?: string;
}

const DSH_ROOT_REQUIRED = '--harness dsh requires --dsh-root <path> or DSH_ROOT';
const DSH_PLUGIN_SEARCH_DEPTH = 12;

/**
 * Locate the workspace-owned DSH overlay that mounts the WAX bridge plugin.
 * The plugin directory sits beside the WAX checkout, so the search walks up
 * from this module (source or compiled) at most twelve directories.
 * @param startUrl - module URL to start from; defaults to this module.
 * @returns the absolute patch path, or undefined when the workspace has none.
 */
function findDshPluginPatch(startUrl: string | URL = import.meta.url): string | undefined {
  let directory = dirname(fileURLToPath(startUrl));
  for (let depth = 0; depth < DSH_PLUGIN_SEARCH_DEPTH; depth += 1) {
    const candidate = join(directory, 'dsh-plugins', 'acp.patch.yml');
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      return undefined;
    }
    directory = parent;
  }
  return undefined;
}

/**
 * Applies the selection policy shared by `waxd` and the B CLI
 * and `wax session`. A dsh root never has an implicit default: it must come
 * from `--dsh-root` or `DSH_ROOT`. Each per-harness override is rejected on
 * the other harness.
 */
export function selectHarness(
  rawHarness: string | undefined,
  flags: { readonly dshRoot?: string; readonly codexExe?: string },
  env: NodeJS.ProcessEnv = process.env,
): HarnessSelection {
  if (rawHarness !== 'codex' && rawHarness !== 'dsh') {
    throw new CliUsageError(`--harness must be 'codex' or 'dsh', got '${rawHarness ?? ''}'`);
  }
  if (rawHarness === 'dsh' && flags.codexExe !== undefined) {
    throw new CliUsageError('--codex-exe only applies to --harness codex');
  }
  if (rawHarness === 'codex' && flags.dshRoot !== undefined) {
    throw new CliUsageError('--dsh-root only applies to --harness dsh');
  }
  if (rawHarness === 'codex') {
    return {
      harness: 'codex',
      ...(flags.codexExe === undefined ? {} : { codexExe: flags.codexExe }),
    };
  }

  const dshRoot = flags.dshRoot ?? env.DSH_ROOT;
  if (dshRoot === undefined || dshRoot === '') {
    throw new CliUsageError(DSH_ROOT_REQUIRED);
  }
  return { harness: 'dsh', dshRoot };
}

export async function createDefaultAdapter(request: AdapterRequest): Promise<HarnessAdapter> {
  if (request.harness === 'dsh') {
    if (request.dshRoot === undefined || request.dshRoot === '') {
      throw new CliUsageError(DSH_ROOT_REQUIRED);
    }
    // The adapter's existing start() validates the checkout and launches the
    // ACP process; this factory only selects it. When the workspace overlay is
    // present it enables native titles through the wax-bridge plugin; missing
    // overlay leaves rename off and ACP keeps WAX's title alone.
    const patch = findDshPluginPatch();
    return new DshAcpAdapter({
      dshRoot: request.dshRoot,
      ...(patch === undefined
        ? {}
        : {
            dshArgs: ['--patch', patch],
            nativeTitles: true,
            sidecarDir: join(homedir(), '.wax', 'dsh', 'session-names'),
          }),
    });
  }
  const connection = await createCodexConnection(
    request.executable === undefined ? {} : { executable: request.executable },
  );
  return new CodexAppServerAdapter({ launch: connection.launch });
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
