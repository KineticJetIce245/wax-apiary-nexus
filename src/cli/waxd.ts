import { runWaxdCli } from './waxd-cli.js';

try {
  process.exitCode = await runWaxdCli(process.argv.slice(2));
} catch {
  // Never print a stack, request body or token. runWaxdCli handles expected
  // failures itself; this is only the last-resort guard for a foreground
  // process that must still exit non-zero.
  process.stderr.write('error: waxd failed\n');
  process.exitCode = 1;
}
