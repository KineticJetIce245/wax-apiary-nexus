import { pathToFileURL } from 'node:url';

import type { ControlCliDependencies } from './control-cli.js';
import { runGraphCli, runSessionCli, runTriggerCli } from './control-cli.js';
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
  'usage: wax <waxd|graph|trigger|session> ... ' +
  '(wax run, wax daemon, wax answer, wax status/log/honey, wax composition and wax mcp were removed)';

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
  if (argv[0] === 'graph') {
    return runGraphCli(argv, deps);
  }
  if (argv[0] === 'trigger') {
    return runTriggerCli(argv, deps);
  }
  if (argv[0] === 'session') {
    return runSessionCli(argv, deps);
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
