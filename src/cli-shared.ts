import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import { CodexAppServerAdapter } from './adapters/codex/adapter.js';
import { DshAcpAdapter } from './adapters/dsh-acp/adapter.js';
import type { HarnessAdapter } from './adapters/harness.js';
import { createCodexConnection, type HarnessKind } from './connection.js';
import {
  CompositionValidationError,
  parseComposition,
  type CompositionDefinition,
} from './runtime/index.js';

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

/**
 * The composition file could not be read from disk. It stays a
 * `CliUsageError` so the human CLI keeps its existing exit-2 behavior; the
 * typed JSON layer classifies it as an IO failure.
 */
export class CompositionReadError extends CliUsageError {
  constructor(message: string) {
    super(message);
    this.name = 'CompositionReadError';
  }
}

/** The composition file is not JSON or does not satisfy `parseComposition`. */
export class CompositionParseError extends CliUsageError {
  constructor(message: string) {
    super(message);
    this.name = 'CompositionParseError';
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

/**
 * Applies the selection policy shared by `wax run` and `wax daemon`. A dsh
 * root never has an implicit default: it must come from `--dsh-root` or
 * `DSH_ROOT`. Each per-harness override is rejected on the other harness.
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
    // ACP process; this factory only selects it.
    return new DshAcpAdapter({ dshRoot: request.dshRoot });
  }
  const connection = await createCodexConnection(
    request.executable === undefined ? {} : { executable: request.executable },
  );
  return new CodexAppServerAdapter({ launch: connection.launch });
}

export interface LoadedCompositionFile {
  readonly definition: CompositionDefinition;
  /** The exact file text, so a replace can preserve formatting. */
  readonly text: string;
}

export function readCompositionFile(path: string): LoadedCompositionFile {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new CompositionReadError(`cannot read composition file ${path}: ${messageOf(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new CompositionParseError(
      `composition file ${path} is not valid JSON: ${messageOf(error)}`,
    );
  }

  try {
    return { definition: parseComposition(parsed), text };
  } catch (error) {
    if (error instanceof CompositionValidationError) {
      throw new CompositionParseError(error.message);
    }
    throw error;
  }
}

export function loadCompositionFile(path: string): CompositionDefinition {
  return readCompositionFile(path).definition;
}

/** Default apiary id: a filesystem-safe slug of the project directory name. */
export function apiaryForProject(projectDirectory: string): string {
  const slug = basename(resolve(projectDirectory))
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? 'apiary' : slug.slice(0, 64);
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
