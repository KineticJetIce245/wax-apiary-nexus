import { ControlClientError, discoverDaemon } from '../control/client.js';
import { QueueClient } from '../control/live-client.js';
import { CliUsageError, messageOf } from './cli-shared.js';
import {
  parseCliTokens,
  type ControlCliDependencies,
} from './control-cli.js';

const QUEUE_USAGE =
  'usage: wax queue status <queueId> [--json] [--daemon-dir <dir>]';
const QUEUE_FLAGS = new Set(['--daemon-dir']);
const MAX_QUEUE_ID_LENGTH = 512;

type Writer = (line: string) => void;

export interface QueueStatusCommand {
  readonly kind: 'status';
  readonly queueId: string;
  readonly json: boolean;
  readonly daemonDir?: string;
}

function requireQueueId(value: string | undefined): string {
  if (
    value === undefined ||
    value.trim() === '' ||
    value.length > MAX_QUEUE_ID_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new CliUsageError(
      `queue id must be a non-empty string of at most ` +
        `${String(MAX_QUEUE_ID_LENGTH)} characters`,
    );
  }
  return value;
}

/**
 * `wax queue status`. Parsing never discovers a daemon or calls HTTP, so every
 * malformed invocation exits 2 without touching the control channel.
 */
export function parseQueueArgs(argv: readonly string[]): QueueStatusCommand {
  const [command, subcommand, ...rest] = argv;
  if (command !== 'queue' || subcommand === undefined) {
    throw new CliUsageError(QUEUE_USAGE);
  }
  if (subcommand !== 'status') {
    throw new CliUsageError(`unknown queue command '${subcommand}'`);
  }
  const parsed = parseCliTokens(rest, QUEUE_FLAGS);
  if (parsed.positionals.length !== 1) {
    throw new CliUsageError('expected exactly one queue id after "wax queue status"');
  }
  const daemonDir = parsed.flags.get('--daemon-dir');
  return {
    kind: 'status',
    queueId: requireQueueId(parsed.positionals[0]),
    json: parsed.json,
    ...(daemonDir === undefined ? {} : { daemonDir }),
  };
}

function createClient(
  daemonDir: string | undefined,
  deps: ControlCliDependencies,
): QueueClient {
  const discovery = discoverDaemon({
    ...(daemonDir === undefined ? {} : { daemonDir }),
    ...(daemonDir === undefined && deps.env !== undefined ? { env: deps.env } : {}),
  });
  return new QueueClient({
    baseUrl: discovery.baseUrl,
    token: discovery.token,
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
  });
}

/**
 * `wax queue status`. One read over the real control HTTP API. The queue is in
 * memory only, so an unknown id is a normal 404 (exit 1) and is never retried:
 * a queued item can complete between two calls, and hiding that behind a retry
 * would misreport the queue.
 */
export async function runQueueCli(
  argv: readonly string[],
  deps: ControlCliDependencies = {},
): Promise<number> {
  const out = deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  try {
    const command = parseQueueArgs(argv);
    const client = createClient(command.daemonDir, deps);

    let queue: Record<string, unknown>;
    try {
      queue = await client.getQueue(command.queueId);
    } catch (error) {
      if (error instanceof ControlClientError && error.status === 404) {
        err(`error: queue item '${command.queueId}' is unknown`);
        return 1;
      }
      throw error;
    }

    if (command.json) {
      writeJson(out, queue);
    } else {
      out(queueLine(queue));
    }
    return 0;
  } catch (error) {
    return reportCliError(error, err);
  }
}

/**
 * One line per item: `<queueId> <status>`, then the optional fields only when
 * the item carries them. Prompts, outputs and tokens are never part of a queue
 * item, so nothing else is printed.
 */
function queueLine(queue: Record<string, unknown>): string {
  const fields = [String(queue['queueId']), String(queue['status'])];
  const position = queue['position'];
  if (typeof position === 'number') {
    fields.push(`position=${String(position)}`);
  }
  const runId = queue['runId'];
  if (typeof runId === 'string') {
    fields.push(`runId=${runId}`);
  }
  return fields.join(' ');
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
    throw new Error('queue response could not be serialized as JSON');
  }
  out(text);
}

function oneLine(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').trim();
}
