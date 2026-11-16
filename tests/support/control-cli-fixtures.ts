import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CliUsageError } from '../../src/cli/cli-shared.js';
import type { ControlCliDependencies } from '../../src/cli/control-cli.js';
import type { HarnessKind } from '../../src/session/connection.js';
import { FakeAdapter } from './fake-adapter.js';

export interface Invocation {
  readonly code: number;
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
}

type ControlRunner = (
  argv: readonly string[],
  deps: ControlCliDependencies,
) => Promise<number>;

export class TrackingFakeAdapter extends FakeAdapter {
  readonly closedNativeIds: string[] = [];

  override async closeConversation(nativeId: string): Promise<void> {
    this.closedNativeIds.push(nativeId);
    await super.closeConversation(nativeId);
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

export function deferred<T>(): Deferred<T> {
  let settle: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolvePromise) => {
    settle = resolvePromise;
  });
  return {
    promise,
    resolve: (value: T) => {
      settle?.(value);
    },
  };
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${String(timeoutMs)} ms`));
    }, timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function tempJson(value: unknown, name = 'input.json'): string {
  const path = join(tempDir('wax-control-cli-file-'), name);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

export function tempRaw(text: string, name = 'input.json'): string {
  const path = join(tempDir('wax-control-cli-file-'), name);
  writeFileSync(path, text);
  return path;
}

export function foragerComposition(id: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id,
    nodes: {
      only: {
        kind: 'forager',
        config: { connection: 'fake', prompt: 'echo {{input}}' },
      },
    },
    edges: [],
  };
}

export function parkedComposition(id: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id,
    nodes: {
      only: {
        kind: 'forager',
        config: { connection: 'fake', prompt: 'echo {{input}}' },
      },
      ask: {
        kind: 'user',
        config: { modality: 'text', prompt: 'Approve?' },
      },
    },
    edges: [],
  };
}

export function userForagerComposition(id: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id,
    nodes: {
      idle: {
        kind: 'forager',
        config: { connection: 'fake', prompt: 'idle {{input}}' },
      },
      ask: {
        kind: 'user',
        config: { modality: 'text', prompt: 'Approve?' },
      },
    },
    edges: [],
  };
}

export function freshBindings(): Record<string, unknown> {
  return { only: { kind: 'fresh' } };
}

interface ManifestFixture {
  readonly root: string;
  readonly project: string;
  readonly composition: string;
  readonly manifestPath: string;
  readonly manifest: Record<string, unknown>;
}

interface ManifestFixtureOptions {
  readonly graphId?: string;
  readonly projectId?: string;
  readonly idleTtlMs?: number;
  readonly harness?: HarnessKind;
  readonly composition?: Record<string, unknown>;
  readonly bindings?: Record<string, unknown>;
}

export function manifestFixture(options: ManifestFixtureOptions = {}): ManifestFixture {
  const root = tempDir('wax-control-cli-manifest-');
  const project = join(root, 'project');
  mkdirSync(project, { recursive: true });
  const composition = join(root, 'composition.json');
  writeFileSync(
    composition,
    JSON.stringify(options.composition ?? foragerComposition(options.graphId ?? 'manifest-graph')),
  );
  const manifest: Record<string, unknown> = {
    schemaVersion: 1,
    composition: 'composition.json',
    project: { id: options.projectId ?? 'manifest-project-id', directory: 'project' },
    harness: options.harness ?? 'codex',
    bindings: options.bindings ?? freshBindings(),
    ...(options.idleTtlMs === undefined ? {} : { idleTtlMs: options.idleTtlMs }),
  };
  const manifestPath = join(root, 'graph.wax.json');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return { root, project, composition, manifestPath, manifest };
}

export function writeManifestVariant(root: string, name: string, value: unknown): string {
  const path = join(root, name);
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
  return path;
}

export async function invokeControl(
  runner: ControlRunner,
  argv: readonly string[],
  options: { readonly daemonDir?: string; readonly fetchImpl?: typeof fetch } = {},
): Promise<Invocation> {
  const full = [...argv];
  if (options.daemonDir !== undefined) {
    full.push('--daemon-dir', options.daemonDir);
  }
  const stdout: string[] = [];
  const stderr: string[] = [];
  const deps: ControlCliDependencies = {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
    env: {},
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  };
  const code = await runner(full, deps);
  return { code, stdout, stderr };
}

export function singleJson(invocation: Invocation): Record<string, unknown> {
  assert.equal(invocation.code, 0, `stderr: ${invocation.stderr.join(' | ')}`);
  assert.equal(
    invocation.stdout.length,
    1,
    `expected exactly one stdout line, got ${JSON.stringify(invocation.stdout)}`,
  );
  const text = invocation.stdout[0] as string;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    assert.fail(`stdout is not JSON: ${text}`);
  }
  assert.equal(typeof parsed, 'object');
  assert.notEqual(parsed, null);
  assert.equal(Array.isArray(parsed), false);
  return parsed as Record<string, unknown>;
}

export function asRecord(value: unknown): Record<string, any> {
  assert.equal(typeof value, 'object');
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  return value as Record<string, any>;
}

export function assertUsage(run: () => unknown): void {
  assert.throws(run, (error: unknown) => error instanceof CliUsageError);
}

export function assertNoSecret(haystack: readonly string[], secret: string): void {
  for (const text of haystack) {
    assert.equal(text.includes(secret), false, 'error output leaked a secret');
  }
}

export async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolvePromise, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => resolvePromise());
  });
  const address = probe.address();
  assert.ok(address !== null && typeof address === 'object');
  const port = address.port;
  await new Promise<void>((resolvePromise) => probe.close(() => resolvePromise()));
  return port;
}
