import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

const MINIMUM_CODEX_VERSION = { major: 0, minor: 166, patch: 0 } as const;
const VERSION_PROBE_TIMEOUT_MS = 15_000;

export type HarnessKind = 'dsh' | 'codex';

/**
 * Local connection selection. This is deliberately tiny: it names a built-in
 * driver and an optional executable override. It cannot carry scripts, extra
 * argv, credentials or dynamic modules.
 */
export interface ConnectionConfig {
  readonly harness: HarnessKind;
  readonly connection: 'local';
  readonly executable?: string;
}

export interface CodexLaunch {
  readonly file: string;
  readonly args: readonly string[];
}

export interface CodexCodexVersion {
  readonly raw: string;
  readonly version: string;
}

export class ConnectionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectionConfigError';
  }
}

export class CodexExecutableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexExecutableError';
  }
}

export function parseConnectionConfig(value: unknown): ConnectionConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConnectionConfigError('Connection config must be a JSON object');
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== 'harness' && key !== 'connection' && key !== 'executable') {
      throw new ConnectionConfigError(`Unsupported connection config field: ${key}`);
    }
  }
  const harness = record.harness;
  if (harness !== 'dsh' && harness !== 'codex') {
    throw new ConnectionConfigError(`Connection config "harness" must be "dsh" or "codex": ${String(harness)}`);
  }
  if (record.connection !== 'local') {
    throw new ConnectionConfigError(
      `Connection config "connection" must be "local"; remote connections are not implemented`,
    );
  }
  const executable = record.executable;
  if (executable !== undefined && (typeof executable !== 'string' || executable.trim() === '')) {
    throw new ConnectionConfigError('Connection config "executable" must be a non-empty string when present');
  }
  return {
    harness,
    connection: 'local',
    ...(typeof executable === 'string' ? { executable } : {}),
  };
}

export function loadConnectionConfig(path: string): ConnectionConfig {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new ConnectionConfigError(`Cannot read connection config ${path}: ${messageOf(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ConnectionConfigError(`Connection config ${path} is not valid JSON: ${messageOf(error)}`);
  }
  return parseConnectionConfig(parsed);
}

/**
 * Resolve the Codex CLI. An explicit override is used verbatim (and must be a
 * file); otherwise PATH is searched, which keeps published configs portable.
 */
export function resolveCodexExecutable(override?: string, env: NodeJS.ProcessEnv = process.env): string {
  if (override !== undefined) {
    if (!existsSync(override) || !isFile(override)) {
      throw new CodexExecutableError(`Codex executable not found: ${override}`);
    }
    return override;
  }
  const pathValue = env.PATH ?? env.Path ?? '';
  if (pathValue.trim() === '') {
    throw new CodexExecutableError(
      'Codex CLI was not found because PATH is empty. Install Codex or pass --codex-exe <path>.',
    );
  }
  const extensions =
    process.platform === 'win32'
      ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((entry) => entry !== '')
      : [''];
  const names = ['codex', ...extensions.map((extension) => `codex${extension.toLowerCase()}`)];
  for (const directory of pathValue.split(delimiter)) {
    if (directory.trim() === '') {
      continue;
    }
    for (const name of names) {
      const candidate = join(directory, name);
      if (existsSync(candidate) && isFile(candidate)) {
        return candidate;
      }
    }
  }
  throw new CodexExecutableError(
    'Codex CLI was not found on PATH. Install Codex, or point at an existing installation with --codex-exe <path>.',
  );
}

export function parseCodexVersion(output: string): string | undefined {
  const match = /codex-cli\s+(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?/.exec(output);
  if (match === null) {
    return undefined;
  }
  return `${match[1]}.${match[2]}.${match[3]}`;
}

export function isSupportedCodexVersion(version: string): boolean {
  const parts = version.split('.').map((part) => Number(part));
  const [major = Number.NaN, minor = Number.NaN, patch = Number.NaN] = parts;
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) {
    return false;
  }
  if (major !== MINIMUM_CODEX_VERSION.major) {
    return major > MINIMUM_CODEX_VERSION.major;
  }
  if (minor !== MINIMUM_CODEX_VERSION.minor) {
    return minor > MINIMUM_CODEX_VERSION.minor;
  }
  return patch >= MINIMUM_CODEX_VERSION.patch;
}

export function minimumCodexVersion(): string {
  return `${MINIMUM_CODEX_VERSION.major}.${MINIMUM_CODEX_VERSION.minor}.${MINIMUM_CODEX_VERSION.patch}`;
}

export async function assertCodexVersion(executable: string): Promise<CodexCodexVersion> {
  const output = await runVersionProbe(executable);
  const version = parseCodexVersion(output);
  if (version === undefined) {
    throw new CodexExecutableError(
      `Could not parse the Codex CLI version from "${output.trim()}". ` +
        `Run "${executable} --version" and check that the executable is Codex.`,
    );
  }
  if (!isSupportedCodexVersion(version)) {
    throw new CodexExecutableError(
      `Codex CLI ${version} is older than the supported minimum ${minimumCodexVersion()}. Upgrade Codex and retry.`,
    );
  }
  return { raw: output.trim(), version };
}

/**
 * Build the app-server launch for this driver.
 *
 * `-c notify=[]` is a per-process override, not a config edit. A Workspace
 * connection renders the same turn in its own UI, so replaying the user's
 * desktop Codex notification hook would duplicate every turn (and leak turn
 * text into whatever that hook posts to).
 */
export function buildCodexLaunch(executable: string, options: { readonly notify?: 'suppress' | 'native' } = {}): CodexLaunch {
  const notify = options.notify ?? 'suppress';
  if (notify === 'suppress') {
    return { file: executable, args: ['app-server', '-c', 'notify=[]'] };
  }
  return { file: executable, args: ['app-server'] };
}

export async function createCodexConnection(options: {
  readonly executable?: string;
  readonly notify?: 'suppress' | 'native';
  readonly env?: NodeJS.ProcessEnv;
} = {}): Promise<{ readonly launch: CodexLaunch; readonly version: CodexCodexVersion }> {
  const executable = resolveCodexExecutable(options.executable, options.env);
  const version = await assertCodexVersion(executable);
  return { launch: buildCodexLaunch(executable, options.notify === undefined ? {} : { notify: options.notify }), version };
}

function runVersionProbe(executable: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      ['--version'],
      { timeout: VERSION_PROBE_TIMEOUT_MS, windowsHide: true, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(
            new CodexExecutableError(
              `Failed to run "${executable} --version": ${messageOf(error)}${stderr.trim() === '' ? '' : ` (${stderr.trim()})`}`,
            ),
          );
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
