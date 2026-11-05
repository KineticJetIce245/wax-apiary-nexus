import { CliUsageError, loadCompositionFile, messageOf } from './cli-shared.js';
import {
  CompositionEditRefusedError,
  CompositionIoError,
  DEFAULT_COMPOSITION_STATE_DIR,
  replaceComposition,
  type CompositionEditDependencies,
} from './composition-edit.js';

export type CompositionCommand =
  | { readonly kind: 'validate'; readonly file: string }
  | {
      readonly kind: 'replace';
      readonly file: string;
      readonly withFile: string;
      readonly stateDir?: string;
      readonly apiary?: string;
    };

export interface CompositionCliDependencies {
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
  /** Test seam: state root used when --state-dir is omitted. */
  readonly defaultStateDir?: string;
  /** Test seam: make the atomic write or audit append fail. */
  readonly edit?: CompositionEditDependencies;
}

const COMPOSITION_USAGE =
  'usage: wax composition validate <file>\n' +
  '       wax composition replace <file> --with <new-file> ' +
  '[--state-dir <dir>] [--apiary <id>]';

const REPLACE_VALUE_FLAGS = new Set(['--with', '--state-dir', '--apiary']);

export function parseCompositionArgs(argv: readonly string[]): CompositionCommand {
  const [command, subcommand, ...rest] = argv;
  if (command !== 'composition') {
    throw new CliUsageError(COMPOSITION_USAGE);
  }

  if (subcommand === 'validate') {
    const positionals: string[] = [];
    for (const token of rest) {
      if (token.startsWith('--')) {
        throw new CliUsageError(
          `unknown option '${token}' for "wax composition validate"`,
        );
      }
      positionals.push(token);
    }
    if (positionals.length !== 1) {
      throw new CliUsageError(
        'expected exactly one composition file after "wax composition validate"',
      );
    }
    return { kind: 'validate', file: positionals[0] as string };
  }

  if (subcommand === 'replace') {
    const positionals: string[] = [];
    const flags = new Map<string, string>();

    for (let index = 0; index < rest.length; index += 1) {
      const token = rest[index];
      if (token === undefined) {
        continue;
      }
      if (token.startsWith('--')) {
        if (!REPLACE_VALUE_FLAGS.has(token)) {
          throw new CliUsageError(`unknown option '${token}'`);
        }
        const value = rest[index + 1];
        if (value === undefined || value.startsWith('--') || value.trim() === '') {
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

    if (positionals.length !== 1) {
      throw new CliUsageError(
        'expected exactly one composition file after "wax composition replace"',
      );
    }
    const withFile = flags.get('--with');
    if (withFile === undefined) {
      throw new CliUsageError('missing required option --with <new-file>');
    }

    const stateDir = flags.get('--state-dir');
    const apiary = flags.get('--apiary');
    return {
      kind: 'replace',
      file: positionals[0] as string,
      withFile,
      ...(stateDir === undefined ? {} : { stateDir }),
      ...(apiary === undefined ? {} : { apiary }),
    };
  }

  throw new CliUsageError(COMPOSITION_USAGE);
}

/**
 * `wax composition validate` and `wax composition replace`.
 *
 * Exit codes: 0 success, 2 usage/parse/refusal, 1 write or audit IO failure.
 * Validation never writes; a replace is refused before any write when an
 * active reference or a live daemon lock is found.
 */
export function runCompositionCli(
  argv: readonly string[],
  deps: CompositionCliDependencies = {},
): number {
  const out = deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));

  let command: CompositionCommand;
  try {
    command = parseCompositionArgs(argv);
  } catch (error) {
    if (error instanceof CliUsageError) {
      err(error.message);
      return 2;
    }
    throw error;
  }

  if (command.kind === 'validate') {
    try {
      const definition = loadCompositionFile(command.file);
      out(`composition  ${definition.id}`);
      out(`revision     ${definition.graphRevision}`);
      out('valid        true');
      return 0;
    } catch (error) {
      if (error instanceof CliUsageError) {
        err(error.message);
        return 2;
      }
      err(`error: ${messageOf(error)}`);
      return 2;
    }
  }

  try {
    const result = replaceComposition(
      {
        file: command.file,
        withFile: command.withFile,
        stateDir:
          command.stateDir ?? deps.defaultStateDir ?? DEFAULT_COMPOSITION_STATE_DIR,
        ...(command.apiary === undefined ? {} : { apiary: command.apiary }),
      },
      deps.edit ?? {},
    );

    out(`replaced     ${result.file}`);
    out(`composition  ${result.compositionId}`);
    out(`revision     ${result.oldRevision} -> ${result.newRevision}`);
    out(`audit        ${result.auditPath}`);
    if (result.activeReferences.status === 'checked') {
      out('active references checked (none)');
    } else {
      out(`active references not checked (${result.activeReferences.reason})`);
    }
    if (result.staleLockPath !== undefined) {
      out(`daemon lock  stale, left in place: ${result.staleLockPath}`);
    }
    return 0;
  } catch (error) {
    if (error instanceof CliUsageError || error instanceof CompositionEditRefusedError) {
      err(error.message);
      return 2;
    }
    if (error instanceof CompositionIoError) {
      err(`error: ${error.message}`);
      return 1;
    }
    err(`error: ${messageOf(error)}`);
    return 1;
  }
}
