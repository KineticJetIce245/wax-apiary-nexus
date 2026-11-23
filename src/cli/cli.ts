import { pathToFileURL } from 'node:url';

import type { ControlCliDependencies } from './control-cli.js';
import { runSessionCli } from './control-cli.js';
import { runDispatchCli } from './dispatch-cli.js';
import { runGuardCli } from './guard-cli.js';
import { runLiveCli } from './live-cli.js';
import { runTemplateCli } from './template-cli.js';
import { runAnswerCli, runWakeCli } from './wake-cli.js';
import type { WaxdDependencies } from './waxd-cli.js';
import { runWaxdCli } from './waxd-cli.js';
import { CliUsageError } from './cli-shared.js';

export { CliUsageError };

/**
 * The B-core command surface shares one dependency bag: the control commands
 * need env/stdout/stderr/fetch, and waxd additionally needs the adapter factory
 * and an abort signal. A-only seams were removed with their commands.
 */
export type CliDependencies = WaxdDependencies & ControlCliDependencies;

const USAGE =
  'usage: wax <waxd|session|live|wake|answer|template|dispatch|guard> ... ' +
  '(wax run, wax daemon, wax status/log/honey, wax composition, wax mcp and ' +
  'wax queue were removed)';

/**
 * Dispatches the supported B-core commands.
 *
 * A removed command is a usage error: it never reaches an adapter, the runtime
 * or a daemon, and it exits 2 like every other malformed invocation.
 */
export async function runCli(
  argv: readonly string[],
  deps: CliDependencies = {},
): Promise<number> {
  if (argv[0] === 'waxd') {
    return runWaxdCli(argv, deps);
  }
  if (argv[0] === 'session') {
    return runSessionCli(argv, deps);
  }
  if (argv[0] === 'live') {
    return runLiveCli(argv, deps);
  }
  if (argv[0] === 'wake') {
    return runWakeCli(argv, deps);
  }
  if (argv[0] === 'answer') {
    return runAnswerCli(argv, deps);
  }
  if (argv[0] === 'template') {
    return runTemplateCli(argv, deps);
  }
  if (argv[0] === 'dispatch') {
    return runDispatchCli(argv, deps);
  }
  if (argv[0] === 'guard') {
    return runGuardCli(argv, deps);
  }

  const err = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  err(USAGE);
  return 2;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  void runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
