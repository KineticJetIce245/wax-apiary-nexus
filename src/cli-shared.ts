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

export function loadCompositionFile(path: string): CompositionDefinition {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new CliUsageError(`cannot read composition file ${path}: ${messageOf(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new CliUsageError(`composition file ${path} is not valid JSON: ${messageOf(error)}`);
  }

  try {
    return parseComposition(parsed);
  } catch (error) {
    if (error instanceof CompositionValidationError) {
      throw new CliUsageError(error.message);
    }
    throw error;
  }
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
