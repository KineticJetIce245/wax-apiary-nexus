import type { SessionParams } from '../b/types.js';
import type { DispatchOptions } from '../b/dispatch-service.js';
import type { Value } from '../runtime/index.js';
import { CliUsageError } from './cli-shared.js';
import {
  parseCliTokens,
  type ControlCliDependencies,
  type ParsedCliTokens,
} from './control-cli.js';
import {
  createClient,
  harnessOf,
  optionalFlag,
  projectOf,
  readInputValue,
  reportCliError,
  writeJson,
} from './live-cli-shared.js';

const DISPATCH_USAGE =
  'usage: wax dispatch ' +
  '[<input>|--input <text>|--input-json <json>|--input-file <path>] ' +
  '[--session <sessionId>] [--harness <codex|dsh>] [--model <model>] ' +
  '[--reasoning <reasoning>] [--project <dir>] [--daemon-dir <dir>] [--json]';

const DISPATCH_FLAGS = new Set([
  '--daemon-dir',
  '--harness',
  '--project',
  '--input',
  '--input-json',
  '--input-file',
  '--session',
  '--model',
  '--reasoning',
]);

/** One dispatch; it never creates a LiveHive and never retries. */
export async function runDispatchCli(
  argv: readonly string[],
  deps: ControlCliDependencies = {},
): Promise<number> {
  const out = deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  try {
    const parsed = parseCliTokens(argv.slice(1), DISPATCH_FLAGS);
    const command = dispatchCommand(parsed);
    await createClient(parsed, deps).dispatch(command.input, command.options);
    if (parsed.json) {
      writeJson(out, { ok: true });
    } else {
      out('accepted');
    }
    return 0;
  } catch (error) {
    return reportCliError(error, err);
  }
}

function dispatchCommand(parsed: ParsedCliTokens): {
  readonly input: string | Value;
  readonly options: DispatchOptions;
} {
  if (parsed.positionals.length > 1) {
    throw new CliUsageError(DISPATCH_USAGE);
  }
  const structured = readInputValue(parsed);
  if (structured !== undefined) {
    // A structured input is the whole Value; mixing it with a string source
    // would make which one wins unclear.
    if (parsed.flags.has('--input') || parsed.positionals.length > 0) {
      throw new CliUsageError(
        '--input-json/--input-file cannot be combined with a positional or --input',
      );
    }
    return { input: structured, options: dispatchOptions(parsed) };
  }
  const input = parsed.flags.get('--input') ?? parsed.positionals[0];
  if (input === undefined || input.trim() === '') {
    throw new CliUsageError(DISPATCH_USAGE);
  }
  return { input, options: dispatchOptions(parsed) };
}

function dispatchOptions(parsed: ParsedCliTokens): DispatchOptions {
  const harness = harnessOf(parsed);
  const sessionParams: SessionParams = {
    ...(harness === undefined ? {} : { harness }),
    ...optionalFlag(parsed, '--model'),
    ...optionalFlag(parsed, '--reasoning'),
  };
  const sessionId = parsed.flags.get('--session');
  if (sessionId !== undefined && sessionId.trim() === '') {
    throw new CliUsageError('--session must not be empty');
  }
  const useFreshSession = sessionId === undefined;
  return {
    ...(useFreshSession || Object.keys(sessionParams).length > 0
      ? { sessionParams }
      : {}),
    ...(sessionId === undefined ? {} : { sessionId }),
    project: projectOf(parsed),
  };
}
