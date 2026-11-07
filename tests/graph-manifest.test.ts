import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  GraphManifestError,
  loadGraphManifest,
} from '../src/graph/manifest.js';

/** Includes a field the runtime schema does not know: the loader must not parse it. */
const COMPOSITION = {
  schemaVersion: 1,
  id: 'manifest-graph',
  nodes: {
    only: {
      kind: 'forager',
      config: { connection: 'fake', prompt: 'hello' },
    },
  },
  edges: [],
  loaderNote: 'raw-json-is-preserved',
};

interface Fixture {
  readonly root: string;
  readonly projectDirectory: string;
  readonly compositionPath: string;
}

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeFixture(): Fixture {
  const root = tempDir('wax-graph-manifest-');
  const projectDirectory = join(root, 'project');
  mkdirSync(projectDirectory, { recursive: true });
  const compositionPath = join(root, 'graph.json');
  writeFileSync(compositionPath, JSON.stringify(COMPOSITION));
  return { root, projectDirectory, compositionPath };
}

function baseManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    composition: 'graph.json',
    project: { id: 'manifest-project', directory: 'project' },
    harness: 'codex',
    bindings: { only: { kind: 'fresh' } },
    ...overrides,
  };
}

function writeManifest(root: string, value: unknown, name = 'graph.wax.json'): string {
  const path = join(root, name);
  writeFileSync(
    path,
    typeof value === 'string' ? value : JSON.stringify(value),
  );
  return path;
}

function expectManifestError(run: () => unknown, pattern: RegExp): GraphManifestError {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  assert.ok(
    caught instanceof GraphManifestError,
    `expected GraphManifestError, got ${String(caught)}`,
  );
  assert.match(caught.message, pattern);
  return caught;
}

test('loads a valid manifest and resolves relative paths against the manifest directory', () => {
  const fixture = makeFixture();
  const manifestPath = writeManifest(
    fixture.root,
    baseManifest({ idleTtlMs: 2_500 }),
  );

  const spec = loadGraphManifest(manifestPath);

  // Raw JSON, not a parsed CompositionDefinition.
  assert.deepEqual(spec.definition, COMPOSITION);
  assert.deepEqual(spec.bindings, { only: { kind: 'fresh' } });
  assert.equal(spec.project.id, 'manifest-project');
  assert.equal(spec.project.directory, resolve(fixture.projectDirectory));
  assert.equal(spec.harness, 'codex');
  assert.equal(spec.idleTtlMs, 2_500);

  // The same manifest in a different working directory still resolves.
  const previous = process.cwd();
  try {
    process.chdir(tmpdir());
    const again = loadGraphManifest(manifestPath);
    assert.deepEqual(again.definition, COMPOSITION);
    assert.equal(again.project.directory, resolve(fixture.projectDirectory));
  } finally {
    process.chdir(previous);
  }
});

test('accepts absolute paths and the project id boundary', () => {
  const fixture = makeFixture();
  const otherRoot = tempDir('wax-graph-manifest-abs-');
  const projectDirectory = join(otherRoot, 'elsewhere');
  mkdirSync(projectDirectory, { recursive: true });
  const manifestPath = writeManifest(
    otherRoot,
    baseManifest({
      composition: fixture.compositionPath,
      project: { id: 'x'.repeat(256), directory: projectDirectory },
    }),
  );

  const spec = loadGraphManifest(manifestPath);

  assert.deepEqual(spec.definition, COMPOSITION);
  assert.equal(spec.project.id, 'x'.repeat(256));
  assert.equal(spec.project.directory, resolve(projectDirectory));
});

test('expands ~ paths using the injected home directory', () => {
  const home = tempDir('wax-graph-manifest-home-');
  const projectDirectory = join(home, 'project');
  mkdirSync(projectDirectory, { recursive: true });
  const compositionPath = join(home, 'graph.json');
  writeFileSync(compositionPath, JSON.stringify(COMPOSITION));
  const fixture = makeFixture();
  const manifestPath = writeManifest(
    fixture.root,
    baseManifest({
      composition: '~/graph.json',
      project: { id: 'home-project', directory: '~' },
    }),
  );

  const spec = loadGraphManifest(manifestPath, { home });

  assert.deepEqual(spec.definition, COMPOSITION);
  assert.equal(spec.project.directory, resolve(home));
});

test('rejects schema, field and project violations with typed errors', () => {
  const fixture = makeFixture();
  const cases: readonly (readonly [string, Record<string, unknown>, RegExp])[] = [
    ['missing schemaVersion', baseManifest({ schemaVersion: undefined }), /schemaVersion/],
    ['wrong schemaVersion', baseManifest({ schemaVersion: 2 }), /schemaVersion/],
    ['string schemaVersion', baseManifest({ schemaVersion: '1' }), /schemaVersion/],
    ['unknown top-level field', baseManifest({ prompt: 'PROMPT_MARKER_SECRET' }), /unknown field/],
    ['missing composition', baseManifest({ composition: undefined }), /composition/],
    ['blank composition', baseManifest({ composition: '   ' }), /composition/],
    ['missing project', baseManifest({ project: undefined }), /project/],
    ['array project', baseManifest({ project: [] }), /project/],
    [
      'unknown project field',
      baseManifest({ project: { id: 'x', directory: 'project', typo: 1 } }),
      /unknown field/,
    ],
    ['empty project.id', baseManifest({ project: { id: '', directory: 'project' } }), /project\.id/],
    [
      'oversized project.id',
      baseManifest({ project: { id: 'x'.repeat(257), directory: 'project' } }),
      /project\.id/,
    ],
    [
      'control characters in project.id',
      baseManifest({ project: { id: 'x\u0001y', directory: 'project' } }),
      /project\.id/,
    ],
    ['missing project.directory', baseManifest({ project: { id: 'x' } }), /project\.directory/],
    ['blank project.directory', baseManifest({ project: { id: 'x', directory: '  ' } }), /project\.directory/],
    ['invalid harness', baseManifest({ harness: 'claude' }), /harness/],
    ['negative idleTtlMs', baseManifest({ idleTtlMs: -1 }), /idleTtlMs/],
    ['fractional idleTtlMs', baseManifest({ idleTtlMs: 1.5 }), /idleTtlMs/],
    ['string idleTtlMs', baseManifest({ idleTtlMs: '10' }), /idleTtlMs/],
    ['missing bindings', baseManifest({ bindings: undefined }), /bindings/],
    ['array bindings', baseManifest({ bindings: [] }), /bindings/],
    ['null bindings', baseManifest({ bindings: null }), /bindings/],
    ['string bindings', baseManifest({ bindings: 'only' }), /bindings/],
  ];

  for (const [name, manifest, pattern] of cases) {
    const manifestPath = writeManifest(
      fixture.root,
      manifest,
      `bad-${name.replace(/[^a-z0-9]+/gi, '-')}.json`,
    );
    const error = expectManifestError(() => loadGraphManifest(manifestPath), pattern);
    assert.equal(
      error.message.includes('PROMPT_MARKER_SECRET'),
      false,
      `${name}: error must not echo values`,
    );
  }
});

test('rejects a non-object manifest and malformed JSON without echoing content', () => {
  const fixture = makeFixture();
  const arrayManifest = writeManifest(fixture.root, [], 'array.json');
  expectManifestError(() => loadGraphManifest(arrayManifest), /JSON object/);

  const broken = writeManifest(
    fixture.root,
    '{"schemaVersion": 1, "prompt": "MANIFEST_MARKER_SECRET"',
    'broken.json',
  );
  const error = expectManifestError(() => loadGraphManifest(broken), /not valid JSON/);
  assert.equal(error.message.includes('MANIFEST_MARKER_SECRET'), false);

  const missing = join(fixture.root, 'absent.wax.json');
  expectManifestError(() => loadGraphManifest(missing), /cannot read/);
});

test('rejects missing or malformed composition files and bad project directories', () => {
  const fixture = makeFixture();
  const cases: readonly (readonly [string, Record<string, unknown>, RegExp])[] = [
    ['missing composition', baseManifest({ composition: 'missing.json' }), /cannot read/],
    ['composition is a directory', baseManifest({ composition: 'project' }), /not a regular file/],
    [
      'project.directory is a file',
      baseManifest({ project: { id: 'x', directory: 'graph.json' } }),
      /not a directory/,
    ],
    [
      'project.directory is missing',
      baseManifest({ project: { id: 'x', directory: 'nowhere' } }),
      /cannot read/,
    ],
  ];
  for (const [name, manifest, pattern] of cases) {
    const manifestPath = writeManifest(
      fixture.root,
      manifest,
      `path-${name.replace(/[^a-z0-9]+/gi, '-')}.json`,
    );
    expectManifestError(() => loadGraphManifest(manifestPath), pattern);
  }

  const brokenComposition = join(fixture.root, 'broken-graph.json');
  writeFileSync(
    brokenComposition,
    '{"nodes": {"only": "PROMPT_MARKER_SECRET"}',
  );
  const manifestPath = writeManifest(
    fixture.root,
    baseManifest({ composition: 'broken-graph.json' }),
    'broken-composition.wax.json',
  );
  const error = expectManifestError(() => loadGraphManifest(manifestPath), /not valid JSON/);
  assert.equal(error.message.includes('PROMPT_MARKER_SECRET'), false);
});

test('rejects NUL bytes in every path field', () => {
  const fixture = makeFixture();

  const nulComposition = writeManifest(
    fixture.root,
    baseManifest({ composition: 'graph\u0000.json' }),
    'nul-composition.json',
  );
  const compositionError = expectManifestError(
    () => loadGraphManifest(nulComposition),
    /NUL/,
  );
  assert.equal(compositionError.message.includes('graph\u0000.json'), false);

  const nulProject = writeManifest(
    fixture.root,
    baseManifest({ project: { id: 'x', directory: 'project\u0000' } }),
    'nul-project.json',
  );
  expectManifestError(() => loadGraphManifest(nulProject), /NUL/);

  expectManifestError(
    () => loadGraphManifest(join(fixture.root, 'graph\u0000.wax.json')),
    /NUL/,
  );
});
