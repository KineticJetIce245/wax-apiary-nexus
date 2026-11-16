import type { SessionParams } from '../b/types.js';
import type { DispatchOptions } from '../b/dispatch-service.js';
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
  positiveInteger,
  projectOf,
  reportCliError,
  writeJson,
} from './live-cli-shared.js';

const DISPATCH_USAGE =
  'usage: wax dispatch [<input>|--input <text>] [--session <sessionId>] ' +
  '[--harness <codex|dsh>] [--model <model>] [--reasoning <reasoning>] ' +
  '[--timeout-ms <n>] [--project <dir>] [--daemon-dir <dir>] [--json]';

const DISPATCH_FLAGS = new Set([
  '--daemon-dir',
  '--harness',
  '--project',
  '--input',
  '--session',
  '--model',
  '--reasoning',
  '--timeout-ms',
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
    const result = await createClient(parsed, deps).dispatch(command.input, command.options);
    if (parsed.json) {
      writeJson(out, result);
    } else {
      out(result.output);
    }
    return 0;
  } catch (error) {
    return reportCliError(error, err);
  }
}

function dispatchCommand(parsed: ParsedCliTokens): {
  readonly input: string;
  readonly options: DispatchOptions;
} {
  if (parsed.positionals.length > 1) {
    throw new CliUsageError(DISPATCH_USAGE);
  }
  const input = parsed.flags.get('--input') ?? parsed.positionals[0];
  if (input === undefined || input.trim() === '') {
    throw new CliUsageError(DISPATCH_USAGE);
  }
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
  const timeoutText = parsed.flags.get('--timeout-ms');
  const useFreshSession = sessionId === undefined;
  return {
    input,
    options: {
      ...(useFreshSession || Object.keys(sessionParams).length > 0
        ? { sessionParams }
        : {}),
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(timeoutText === undefined ? {} : { timeoutMs: positiveInteger(timeoutText) }),
      project: projectOf(parsed),
    },
  };
}
