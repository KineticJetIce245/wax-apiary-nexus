import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export type GraphManifestHarness = 'codex' | 'dsh';

/** On-disk sidecar shape. `composition` and `project.directory` are paths. */
export interface GraphManifest {
  readonly schemaVersion: 1;
  readonly composition: string;
  readonly project: { readonly id: string; readonly directory: string };
  readonly harness: GraphManifestHarness;
  readonly idleTtlMs?: number;
  readonly bindings: Record<string, unknown>;
}

/** Everything the control API needs, with the manifest resolved to absolute paths. */
export interface ManifestLoadSpec {
  readonly definition: unknown;
  readonly bindings: Record<string, unknown>;
  readonly project: { readonly id: string; readonly directory: string };
  readonly harness: GraphManifestHarness;
  readonly idleTtlMs?: number;
}

export interface LoadGraphManifestOptions {
  /** Overrides `~` expansion. Tests use it instead of touching the real home. */
  readonly home?: string;
}

/**
 * A manifest or one of the files it points at is missing, malformed, or
 * contradicts the schema. Messages carry paths and field names only: the
 * composition body (which may hold prompts) is never echoed.
 */
export class GraphManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphManifestError';
  }
}

const MANIFEST_FIELDS: ReadonlySet<string> = new Set([
  'schemaVersion',
  'composition',
  'project',
  'harness',
  'idleTtlMs',
  'bindings',
]);
const PROJECT_FIELDS: ReadonlySet<string> = new Set(['id', 'directory']);
/** Matches the control server's project.id limit. */
const MAX_PROJECT_ID_LENGTH = 256;
/** The server rejects control characters in string identifiers. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Read a sidecar manifest and the raw composition it names.
 *
 * The composition is returned exactly as parsed JSON; semantic validation
 * stays on the control server. Relative paths are resolved against the
 * manifest's own directory so a manifest can be moved together with its
 * files, and both `~` and `~/` (or `~\`) expand to the home directory.
 *
 * @throws {GraphManifestError} when the manifest, composition, or paths are invalid.
 */
export function loadGraphManifest(
  manifestPath: string,
  options: LoadGraphManifestOptions = {},
): ManifestLoadSpec {
  assertNoNul(manifestPath, 'manifest path');
  if (manifestPath.trim() === '') {
    throw new GraphManifestError('manifest path must not be empty');
  }

  const manifestFile = resolve(manifestPath);
  const label = `manifest '${manifestFile}'`;
  const manifest = parseManifest(readJson(manifestFile, 'manifest'), label);

  const baseDirectory = dirname(manifestFile);
  const home = options.home ?? homedir();
  const compositionPath = resolveManifestPath(manifest.composition, baseDirectory, home);
  const projectDirectory = resolveManifestPath(manifest.project.directory, baseDirectory, home);

  assertRegularFile(compositionPath, 'composition');
  assertExistingDirectory(projectDirectory, 'project.directory');
  const definition = readJson(compositionPath, 'composition file');

  return {
    definition,
    bindings: manifest.bindings,
    project: { id: manifest.project.id, directory: projectDirectory },
    harness: manifest.harness,
    ...(manifest.idleTtlMs === undefined ? {} : { idleTtlMs: manifest.idleTtlMs }),
  };
}

function parseManifest(raw: unknown, label: string): GraphManifest {
  if (!isRecord(raw)) {
    throw new GraphManifestError(`${label} must contain a JSON object`);
  }
  assertOnlyFields(raw, MANIFEST_FIELDS, label);
  if (raw['schemaVersion'] !== 1) {
    throw new GraphManifestError(`${label}: schemaVersion must be 1`);
  }

  const composition = requireText(raw['composition'], `${label}: composition`);
  assertNoNul(composition, `${label}: composition`);

  const project = raw['project'];
  if (!isRecord(project)) {
    throw new GraphManifestError(`${label}: project must be an object`);
  }
  assertOnlyFields(project, PROJECT_FIELDS, `${label}: project`);
  const id = requireText(project['id'], `${label}: project.id`);
  if (id.length > MAX_PROJECT_ID_LENGTH) {
    throw new GraphManifestError(
      `${label}: project.id must be at most ${String(MAX_PROJECT_ID_LENGTH)} characters`,
    );
  }
  if (CONTROL_CHARS.test(id)) {
    throw new GraphManifestError(`${label}: project.id must not contain control characters`);
  }
  const directory = requireText(project['directory'], `${label}: project.directory`);
  assertNoNul(directory, `${label}: project.directory`);

  const harness = raw['harness'];
  if (harness !== 'codex' && harness !== 'dsh') {
    throw new GraphManifestError(`${label}: harness must be 'codex' or 'dsh'`);
  }

  const idleTtlMs = raw['idleTtlMs'];
  if (
    idleTtlMs !== undefined &&
    (typeof idleTtlMs !== 'number' || !Number.isSafeInteger(idleTtlMs) || idleTtlMs < 0)
  ) {
    throw new GraphManifestError(`${label}: idleTtlMs must be a non-negative integer`);
  }

  const bindings = raw['bindings'];
  if (!isRecord(bindings)) {
    throw new GraphManifestError(`${label}: bindings must be an object`);
  }

  return {
    schemaVersion: 1,
    composition,
    project: { id, directory },
    harness,
    ...(idleTtlMs === undefined ? {} : { idleTtlMs }),
    bindings,
  };
}

function readJson(path: string, subject: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new GraphManifestError(
      `cannot read ${subject} '${path}': ${ioCode(error)}`,
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    // The parser message can echo file content, so it is deliberately dropped.
    throw new GraphManifestError(`${subject} '${path}' is not valid JSON`);
  }
}

function resolveManifestPath(value: string, baseDirectory: string, home: string): string {
  return resolve(baseDirectory, expandHome(value, home));
}

function expandHome(input: string, home: string): string {
  if (input === '~') {
    return home;
  }
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return join(home, input.slice(2));
  }
  return input;
}

function assertRegularFile(path: string, field: string): void {
  let stats;
  try {
    stats = statSync(path);
  } catch (error) {
    throw new GraphManifestError(
      `cannot read ${field} '${path}': ${ioCode(error)}`,
    );
  }
  if (!stats.isFile()) {
    throw new GraphManifestError(`${field} '${path}' is not a regular file`);
  }
}

function assertExistingDirectory(path: string, field: string): void {
  let stats;
  try {
    stats = statSync(path);
  } catch (error) {
    throw new GraphManifestError(
      `cannot read ${field} '${path}': ${ioCode(error)}`,
    );
  }
  if (!stats.isDirectory()) {
    throw new GraphManifestError(`${field} '${path}' is not a directory`);
  }
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new GraphManifestError(`${field} must be a non-empty string`);
  }
  return value;
}

function assertOnlyFields(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new GraphManifestError(`${label}: unknown field ${JSON.stringify(key)}`);
    }
  }
}

function assertNoNul(value: string, field: string): void {
  if (value.includes('\u0000')) {
    throw new GraphManifestError(`${field} must not contain a NUL byte`);
  }
}

function ioCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === 'string' && code !== '' ? code : 'read failed';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
