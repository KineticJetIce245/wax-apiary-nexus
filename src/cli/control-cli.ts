import {
  ControlClient,
  ControlClientError,
  discoverDaemon,
  type SessionSummary,
  type SweepSessionsReport,
} from '../control/client.js';
import type { HarnessKind } from '../session/connection.js';
import { CliUsageError, messageOf } from './cli-shared.js';

const SESSION_USAGE =
  'usage: wax session <list|close <sessionId>|sweep> [--json] [--daemon-dir <dir>] ' +
  '[--harness <codex|dsh>]';
const MAX_SESSION_ID_LENGTH = 512;

/** Injected by the CLI entry points and by tests. */
export interface ControlCliDependencies {
  readonly env?: NodeJS.ProcessEnv;
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
  /** Test seam: count or fail HTTP calls without replacing the real server. */
  readonly fetchImpl?: typeof fetch;
}

type Writer = (line: string) => void;

export interface ParsedCliTokens {
  readonly positionals: readonly string[];
  readonly flags: ReadonlyMap<string, string>;
  readonly json: boolean;
}

export interface ParseCliTokensOptions {
  /** `waxd` has no `--json` switch. */
  readonly allowJson?: boolean;
  /** Flags for which an empty string is a meaningful value (for example --input). */
  readonly allowEmpty?: ReadonlySet<string>;
}

/**
 * Shared token parser for the B CLI front ends and waxd.
 *
 * It deliberately mirrors the existing CLI style: `--json` is a boolean,
 * every other `--flag` consumes exactly one value, duplicates are usage
 * errors, and anything that is not a flag is positional.
 */
export function parseCliTokens(
  tokens: readonly string[],
  valueFlags: ReadonlySet<string>,
  options: ParseCliTokensOptions = {},
): ParsedCliTokens {
  const positionals: string[] = [];
  const flags = new Map<string, string>();
  let json = false;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) {
      continue;
    }
    if (token === '--json') {
      if (options.allowJson === false) {
        throw new CliUsageError(`unknown option '${token}'`);
      }
      if (json) {
        throw new CliUsageError("option '--json' was given more than once");
      }
      json = true;
      continue;
    }
    if (token.startsWith('--')) {
      if (!valueFlags.has(token)) {
        throw new CliUsageError(`unknown option '${token}'`);
      }
      const value = tokens[index + 1];
      if (
        value === undefined ||
        value.startsWith('--') ||
        (value === '' && options.allowEmpty?.has(token) !== true)
      ) {
        throw new CliUsageError(`option '${token}' needs a value`);
      }
      if (flags.has(token)) {
        throw new CliUsageError(`option '${token}' was given more than once`);
      }
      flags.set(token, value);
      index += 1;
      continue;
    }
    positionals.push(token);
  }

  return { positionals, flags, json };
}

const SESSION_FLAGS = new Set(['--daemon-dir', '--harness']);

interface SessionCommon {
  readonly json: boolean;
  readonly daemonDir?: string;
  readonly harness?: HarnessKind;
}

export type SessionCommand =
  | (SessionCommon & { readonly kind: 'list' })
  | (SessionCommon & { readonly kind: 'close'; readonly sessionId: string })
  | (SessionCommon & { readonly kind: 'sweep' });

function harnessOf(parsed: ParsedCliTokens): { readonly harness?: HarnessKind } {
  const value = parsed.flags.get('--harness');
  if (value === undefined) {
    return {};
  }
  if (value !== 'codex' && value !== 'dsh') {
    throw new CliUsageError("--harness must be 'codex' or 'dsh'");
  }
  return { harness: value };
}

function commonOf(parsed: ParsedCliTokens): {
  readonly daemonDir?: string;
  readonly harness?: HarnessKind;
} {
  const daemonDir = parsed.flags.get('--daemon-dir');
  return {
    ...(daemonDir === undefined ? {} : { daemonDir }),
    ...harnessOf(parsed),
  };
}

function requirePositionals(parsed: ParsedCliTokens, count: number, message: string): void {
  if (parsed.positionals.length !== count) {
    throw new CliUsageError(message);
  }
}

function requireSessionId(value: string | undefined): string {
  if (
    value === undefined ||
    value.trim() === '' ||
    value.length > MAX_SESSION_ID_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new CliUsageError(
      `session id must be a non-empty string of at most ` +
        `${String(MAX_SESSION_ID_LENGTH)} characters`,
    );
  }
  return value;
}

/** `wax session list|close|sweep`. */
export function parseSessionArgs(argv: readonly string[]): SessionCommand {
  const [command, subcommand, ...rest] = argv;
  if (command !== 'session') {
    throw new CliUsageError(SESSION_USAGE);
  }

  if (subcommand === 'list') {
    const parsed = parseCliTokens(rest, SESSION_FLAGS);
    requirePositionals(parsed, 0, 'expected no arguments after "wax session list"');
    return { kind: 'list', json: parsed.json, ...commonOf(parsed) };
  }
  if (subcommand === 'close') {
    const parsed = parseCliTokens(rest, SESSION_FLAGS);
    requirePositionals(parsed, 1, 'expected exactly one session id after "wax session close"');
    return {
      kind: 'close',
      sessionId: requireSessionId(parsed.positionals[0]),
      json: parsed.json,
      ...commonOf(parsed),
    };
  }
  if (subcommand === 'sweep') {
    const parsed = parseCliTokens(rest, SESSION_FLAGS);
    requirePositionals(parsed, 0, 'expected no arguments after "wax session sweep"');
    return { kind: 'sweep', json: parsed.json, ...commonOf(parsed) };
  }
  if (subcommand === undefined) {
    throw new CliUsageError(SESSION_USAGE);
  }
  throw new CliUsageError(`unknown session command '${subcommand}'`);
}

function createClient(
  daemonDir: string | undefined,
  deps: ControlCliDependencies,
): ControlClient {
  const discovery = discoverDaemon({
    ...(daemonDir === undefined ? {} : { daemonDir }),
    ...(daemonDir === undefined && deps.env !== undefined ? { env: deps.env } : {}),
  });
  return new ControlClient({
    baseUrl: discovery.baseUrl,
    token: discovery.token,
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
  });
}

/**
 * `wax session list|close|sweep`. A single attempt over the real control HTTP
 * API; a 404 close is a normal "not found" failure (exit 1), never retried.
 */
export async function runSessionCli(
  argv: readonly string[],
  deps: ControlCliDependencies = {},
): Promise<number> {
  const out = deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  try {
    const command = parseSessionArgs(argv);
    const client = createClient(command.daemonDir, deps);

    switch (command.kind) {
      case 'list': {
        const allSessions = await client.listSessions();
        const sessions =
          command.harness === undefined
            ? allSessions
            : allSessions.filter((session) => session.harness === command.harness);
        if (command.json) {
          writeJson(out, { sessions });
        } else {
          for (const session of sessions) {
            out(sessionLine(session));
          }
        }
        return 0;
      }
      case 'close': {
        const closed = await client.closeSession(command.sessionId);
        if (!closed) {
          err(`error: session '${command.sessionId}' is unknown or already closed`);
          return 1;
        }
        if (command.json) {
          writeJson(out, { closed: true });
        } else {
          out(`closed ${command.sessionId}`);
        }
        return 0;
      }
      case 'sweep': {
        const report = await client.sweepSessions();
        if (command.json) {
          writeJson(out, report);
        } else {
          printSessionSweep(out, report);
        }
        return 0;
      }
    }
  } catch (error) {
    return reportCliError(error, err);
  }
}

function reportCliError(error: unknown, err: Writer): number {
  if (error instanceof CliUsageError) {
    err(oneLine(error.message));
    return 2;
  }
  if (error instanceof ControlClientError) {
    err(controlErrorLine(error));
    return 1;
  }
  err(`error: ${oneLine(messageOf(error))}`);
  return 1;
}

function controlErrorLine(error: ControlClientError): string {
  const details = [`code=${error.code}`];
  if (error.status !== undefined) {
    details.unshift(`status=${String(error.status)}`);
  }
  return `error: ${oneLine(error.message)} (${details.join(', ')})`;
}

function writeJson(out: Writer, value: unknown): void {
  const text = JSON.stringify(value);
  if (text === undefined) {
    throw new Error('control response could not be serialized as JSON');
  }
  out(text);
}

function sessionLine(session: SessionSummary): string {
  return (
    `${session.sessionId} harness=${session.harness} ` +
    `project=${session.projectId} busy=${yesNo(session.busy)} ` +
    `bound=${yesNo(session.bound)}`
  );
}

/**
 * Human `wax session sweep` output: one count line, then one line per non-empty
 * id list. It never prints a native id, project directory, prompt, output or
 * token — the control report contains none of them.
 */
function printSessionSweep(out: Writer, report: SweepSessionsReport): void {
  out(
    `session sweep closed=${String(report.closed.length)} ` +
      `skipped=${String(report.skipped.length)} failed=${String(report.failed.length)}`,
  );
  if (report.closed.length > 0) {
    out(`closed ${report.closed.join(', ')}`);
  }
  if (report.skipped.length > 0) {
    out(`skipped ${report.skipped.join(', ')}`);
  }
  for (const failure of report.failed) {
    out(`failed ${failure.sessionId}: ${failure.error}`);
  }
}

function yesNo(value: boolean): string {
  return value ? 'yes' : 'no';
}

function oneLine(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').trim();
}
