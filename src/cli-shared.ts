import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import { CodexAppServerAdapter } from './adapters/codex/adapter.js';
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
  readonly executable?: string;
}

export async function createDefaultAdapter(request: AdapterRequest): Promise<HarnessAdapter> {
  if (request.harness === 'dsh') {
    throw new CliUsageError('the dsh bridge is not wired in Stage 2A; run with --harness codex');
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
