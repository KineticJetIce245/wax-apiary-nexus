import { ControlClientError, discoverDaemon } from '../control/client.js';
import { GuardClient } from '../control/client-guard.js';
import type { PendingGuardSummary } from '../control/guard-broker.js';
import type { GuardDecision } from '../runtime/index.js';
import { CliUsageError, messageOf } from './cli-shared.js';
import {
  parseCliTokens,
  type ControlCliDependencies,
  type ParsedCliTokens,
} from './control-cli.js';

const GUARD_USAGE =
  'usage: wax guard <list|decide <requestId> ' +
  '--decision allow_once|reject_once|cancelled> [--json] [--daemon-dir <dir>]';
const MAX_REQUEST_ID_LENGTH = 512;
const LIST_FLAGS = new Set(['--daemon-dir']);
const DECIDE_FLAGS = new Set(['--daemon-dir', '--decision']);

type Writer = (line: string) => void;

interface GuardCommon {
  readonly json: boolean;
  readonly daemonDir?: string;
}

export type GuardCommand =
  | (GuardCommon & { readonly kind: 'list' })
  | (GuardCommon & {
      readonly kind: 'decide';
      readonly requestId: string;
      readonly decision: GuardDecision;
    });

function commonOf(parsed: ParsedCliTokens): GuardCommon {
  const daemonDir = parsed.flags.get('--daemon-dir');
  return {
    json: parsed.json,
    ...(daemonDir === undefined ? {} : { daemonDir }),
  };
}

function requirePositionals(parsed: ParsedCliTokens, count: number, message: string): void {
  if (parsed.positionals.length !== count) {
    throw new CliUsageError(message);
  }
}

function requireRequestId(value: string | undefined): string {
  if (
    value === undefined ||
    value.trim() === '' ||
    value.length > MAX_REQUEST_ID_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new CliUsageError(
      `request id must be a non-empty string of at most ` +
        `${String(MAX_REQUEST_ID_LENGTH)} characters`,
    );
  }
  return value;
}

function requireDecision(parsed: ParsedCliTokens): GuardDecision {
  const value = parsed.flags.get('--decision');
  if (value === undefined) {
    throw new CliUsageError("missing required option '--decision'");
  }
  if (value !== 'allow_once' && value !== 'reject_once' && value !== 'cancelled') {
    throw new CliUsageError(
      "--decision must be 'allow_once', 'reject_once' or 'cancelled'",
    );
  }
  return value;
}

/**
 * `wax guard list` and `wax guard decide`. Parsing never performs discovery or
 * HTTP, so every malformed invocation exits 2 without touching a daemon.
 */
export function parseGuardArgs(argv: readonly string[]): GuardCommand {
  const [command, subcommand, ...rest] = argv;
  if (command !== 'guard') {
    throw new CliUsageError(GUARD_USAGE);
  }
  if (subcommand === 'list') {
    const parsed = parseCliTokens(rest, LIST_FLAGS);
    requirePositionals(parsed, 0, 'expected no arguments after "wax guard list"');
    return { kind: 'list', ...commonOf(parsed) };
  }
  if (subcommand === 'decide') {
    const parsed = parseCliTokens(rest, DECIDE_FLAGS);
    requirePositionals(parsed, 1, 'expected exactly one request id after "wax guard decide"');
    return {
      kind: 'decide',
      requestId: requireRequestId(parsed.positionals[0]),
      decision: requireDecision(parsed),
      ...commonOf(parsed),
    };
  }
  if (subcommand === undefined) {
    throw new CliUsageError(GUARD_USAGE);
  }
  throw new CliUsageError(`unknown guard command '${subcommand}'`);
}

function createClient(
  daemonDir: string | undefined,
  deps: ControlCliDependencies,
): GuardClient {
  const discovery = discoverDaemon({
    ...(daemonDir === undefined ? {} : { daemonDir }),
    ...(daemonDir === undefined && deps.env !== undefined ? { env: deps.env } : {}),
  });
  return new GuardClient({
    baseUrl: discovery.baseUrl,
    token: discovery.token,
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
  });
}

/**
 * `wax guard list|decide`. One attempt over the real control HTTP API. A 404
 * or 409 decision is a normal failure (exit 1) and is never retried: a guard
 * decision has side effects, so an uncertain attempt must stay visible.
 */
export async function runGuardCli(
  argv: readonly string[],
  deps: ControlCliDependencies = {},
): Promise<number> {
  const out = deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  try {
    const command = parseGuardArgs(argv);
    const client = createClient(command.daemonDir, deps);

    if (command.kind === 'list') {
      const guards = await client.listGuards();
      if (command.json) {
        writeJson(out, { guards });
      } else {
        for (const guard of guards) {
          out(guardLine(guard));
        }
      }
      return 0;
    }

    try {
      await client.decideGuard(command.requestId, command.decision);
    } catch (error) {
      if (error instanceof ControlClientError) {
        const line = decisionFailureLine(error, command.requestId);
        if (line !== undefined) {
          err(line);
          return 1;
        }
      }
      throw error;
    }
    if (command.json) {
      writeJson(out, {
        requestId: command.requestId,
        decision: command.decision,
      });
    } else {
      out(`decided ${command.requestId} ${command.decision}`);
    }
    return 0;
  } catch (error) {
    return reportCliError(error, err);
  }
}

/** Explain the control failure classes a native guard decision can produce. */
function decisionFailureLine(
  error: ControlClientError,
  requestId: string,
): string | undefined {
  if (error.status === 404) {
    return `error: guard request '${requestId}' is unknown`;
  }
  if (error.status === 409 && error.code === 'guard-expired') {
    return `error: guard request '${requestId}' has expired`;
  }
  if (error.status === 409) {
    return `error: guard request '${requestId}' has already been settled`;
  }
  return undefined;
}

function reportCliError(error: unknown, err: Writer): number {
  if (error instanceof CliUsageError) {
    err(oneLine(error.message));
    return 2;
  }
  if (error instanceof ControlClientError) {
    const details = [`code=${error.code}`];
    if (error.status !== undefined) {
      details.unshift(`status=${String(error.status)}`);
    }
    err(`error: ${oneLine(error.message)} (${details.join(', ')})`);
    return 1;
  }
  err(`error: ${oneLine(messageOf(error))}`);
  return 1;
}

function writeJson(out: Writer, value: unknown): void {
  const text = JSON.stringify(value);
  if (text === undefined) {
    throw new Error('guard response could not be serialized as JSON');
  }
  out(text);
}

/**
 * One line per pending guard. The summary is native tool metadata, so it is
 * flattened to keep one guard on one line; prompts, outputs and tokens are not
 * part of the listing at all.
 */
function guardLine(guard: PendingGuardSummary): string {
  return (
    `${guard.requestId} execution=${guard.executionId} created=${guard.createdAt} ` +
    `options=${guard.options.join(',')} summary=${oneLine(guard.summary)}`
  );
}

function oneLine(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').trim();
}
