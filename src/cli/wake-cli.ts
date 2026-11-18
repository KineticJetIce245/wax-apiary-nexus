import type { ControlCliDependencies } from './control-cli.js';
import { parseCliTokens } from './control-cli.js';
import { CliUsageError } from './cli-shared.js';
import {
  createClient,
  reportCliError,
  writeJson,
} from './live-cli-shared.js';

type Writer = (line: string) => void;

const WAKE_USAGE =
  'usage: wax wake <liveId> <beeId> [--input <text>] [--daemon-dir <dir>] [--json]';
const ANSWER_USAGE =
  'usage: wax answer <liveId> <beeId> [--input <text>] [--token <token>] ' +
  '[--daemon-dir <dir>] [--json]';

const WAKE_FLAGS = new Set(['--input', '--daemon-dir']);
const ANSWER_FLAGS = new Set(['--input', '--token', '--daemon-dir']);

export async function runWakeCli(
  argv: readonly string[],
  deps: ControlCliDependencies = {},
): Promise<number> {
  return runWakeLike(argv, deps, 'wake', WAKE_USAGE, WAKE_FLAGS);
}

export async function runAnswerCli(
  argv: readonly string[],
  deps: ControlCliDependencies = {},
): Promise<number> {
  return runWakeLike(argv, deps, 'answer', ANSWER_USAGE, ANSWER_FLAGS);
}

async function runWakeLike(
  argv: readonly string[],
  deps: ControlCliDependencies,
  kind: 'wake' | 'answer',
  usage: string,
  flags: ReadonlySet<string>,
): Promise<number> {
  const out = deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  try {
    const parsed = parseCliTokens(argv.slice(1), flags, {
      allowEmpty: new Set(['--input']),
    });
    if (parsed.positionals.length !== 2) {
      throw new CliUsageError(usage);
    }
    const [liveId, beeId] = parsed.positionals;
    if (liveId === undefined || beeId === undefined) {
      throw new CliUsageError(usage);
    }
    const input = parsed.flags.get('--input') ?? '';
    const client = createClient(parsed, deps);
    const result = kind === 'wake'
      ? await client.wake(liveId, beeId, input)
      : await client.answerLive(liveId, beeId, input, parsed.flags.get('--token'));
    if (parsed.json) {
      writeJson(out, result);
    } else {
      printResult(out, result);
    }
    return 0;
  } catch (error) {
    return reportCliError(error, err);
  }
}

function printResult(out: Writer, result: unknown): void {
  const record = typeof result === 'object' && result !== null
    ? (result as Record<string, unknown>)
    : {};
  out(
    `${String(record['graphId'])} rest=${String(record['rest'])} ` +
      `hovered=${String(record['hovered'])} pumps=${String(record['pumps'])} ` +
      `persisted=${String(record['persisted'])}`,
  );
}
