import type { Value } from '../runtime/index.js';
import type { ControlCliDependencies, ParsedCliTokens } from './control-cli.js';
import { parseCliTokens } from './control-cli.js';
import { CliUsageError } from './cli-shared.js';
import {
  createClient,
  readInputValue,
  reportCliError,
  writeJson,
} from './live-cli-shared.js';

type Writer = (line: string) => void;

const TRIGGER_USAGE =
  'usage: wax trigger <liveId> <beeId> ' +
  '[--input <text> | --input-json <json> | --input-file <path>] ' +
  '[--daemon-dir <dir>] [--json]';
const ANSWER_USAGE =
  'usage: wax answer <liveId> <beeId> ' +
  '[--input <text> | --input-json <json> | --input-file <path>] ' +
  '[--token <token>] [--daemon-dir <dir>] [--json]';

const TRIGGER_FLAGS = new Set([
  '--input',
  '--input-json',
  '--input-file',
  '--daemon-dir',
]);
const ANSWER_FLAGS = new Set([
  '--input',
  '--input-json',
  '--input-file',
  '--token',
  '--daemon-dir',
]);

export async function runTriggerCli(
  argv: readonly string[],
  deps: ControlCliDependencies = {},
): Promise<number> {
  return runDelivery(argv, deps, 'trigger', TRIGGER_USAGE, TRIGGER_FLAGS);
}

export async function runAnswerCli(
  argv: readonly string[],
  deps: ControlCliDependencies = {},
): Promise<number> {
  return runDelivery(argv, deps, 'answer', ANSWER_USAGE, ANSWER_FLAGS);
}

async function runDelivery(
  argv: readonly string[],
  deps: ControlCliDependencies,
  kind: 'trigger' | 'answer',
  usage: string,
  flags: ReadonlySet<string>,
): Promise<number> {
  const out = deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  try {
    const parsed = parseCliTokens(argv.slice(1), flags, {
      allowEmpty: new Set(['--input']),
    });
    const { liveId, beeId } = deliveryTarget(parsed, usage);
    const input = deliveryInput(parsed);
    const client = createClient(parsed, deps);
    if (kind === 'trigger') {
      await client.trigger(liveId, beeId, input);
    } else {
      await client.answerLive(liveId, beeId, input, parsed.flags.get('--token'));
    }
    if (parsed.json) {
      writeJson(out, { ok: true });
    } else {
      printAccepted(out);
    }
    return 0;
  } catch (error) {
    return reportCliError(error, err);
  }
}

function deliveryTarget(
  parsed: ParsedCliTokens,
  usage: string,
): { readonly liveId: string; readonly beeId: string } {
  if (parsed.positionals.length !== 2) {
    throw new CliUsageError(usage);
  }
  const [liveId, beeId] = parsed.positionals;
  if (liveId === undefined || beeId === undefined) {
    throw new CliUsageError(usage);
  }
  return { liveId, beeId };
}

function deliveryInput(parsed: ParsedCliTokens): string | Value {
  const structured = readInputValue(parsed);
  if (structured !== undefined) {
    if (parsed.flags.has('--input')) {
      throw new CliUsageError(
        '--input cannot be combined with --input-json or --input-file',
      );
    }
    return structured;
  }
  return parsed.flags.get('--input') ?? '';
}

function printAccepted(out: Writer): void {
  out('accepted');
}
