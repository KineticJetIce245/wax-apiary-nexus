import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Project } from '../../src/project/kernel.js';
import { foragerDefinition } from './control-server-fixtures.js';

interface ManifestFixture {
  readonly root: string;
  readonly compositionPath: string;
  readonly manifestPath: string;
  readonly composition: Record<string, unknown>;
  readonly manifest: Record<string, unknown>;
}

interface ManifestFixtureOptions {
  readonly graphId?: string;
  readonly harness?: string;
  readonly bindings?: Record<string, unknown>;
  readonly project?: Project;
  readonly composition?: Record<string, unknown>;
}

/** Writes a real sidecar manifest plus the composition it names. */
export function writeManifestFixture(
  env: { readonly project: Project },
  options: ManifestFixtureOptions = {},
): ManifestFixture {
  const root = mkdtempSync(join(tmpdir(), 'wax-control-manifest-'));
  const project = options.project ?? env.project;
  const composition =
    options.composition ??
    foragerDefinition(options.graphId ?? 'manifest-graph', 'manifest {{message}}');
  const compositionPath = join(root, 'composition.json');
  writeFileSync(compositionPath, JSON.stringify(composition));
  const manifest: Record<string, unknown> = {
    schemaVersion: 1,
    composition: 'composition.json',
    project: { id: project.id, directory: project.directory },
    harness: options.harness ?? 'codex',
    bindings: options.bindings ?? { only: { kind: 'fresh' } },
  };
  const manifestPath = join(root, 'graph.wax.json');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return { root, compositionPath, manifestPath, composition, manifest };
}

export function writeManifestVariant(root: string, name: string, value: unknown): string {
  const path = join(root, name);
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
  return path;
}

/** A valid composition whose only node kind cannot be triggered manually. */
export function untriggerableComposition(id: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id,
    nodes: {
      cond: { kind: 'condition', config: { when: { path: 'flag', equals: true } } },
    },
    edges: [
      { id: 'yes', from: 'cond', to: 'cond', when: 'true' },
      { id: 'no', from: 'cond', to: 'cond', when: 'false' },
    ],
  };
}
