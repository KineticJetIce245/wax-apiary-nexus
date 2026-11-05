import { CliUsageError, loadCompositionFile, messageOf } from './cli-shared.js';
import {
  CompositionAuditIoError,
  CompositionAuditParseError,
  inspectCompositionRecovery,
  parseRevisionLimit,
  readCompositionRevisions,
} from './composition-audit.js';
import {
  CompositionEditRefusedError,
  CompositionIoError,
  DEFAULT_COMPOSITION_STATE_DIR,
  compositionAuditPath,
  replaceComposition,
  type CompositionEditDependencies,
} from './composition-edit.js';
import {
  compositionToolExitCode,
  compositionToolFailure,
  recoverCompositionTool,
  replaceCompositionTool,
  revisionsCompositionTool,
  validateCompositionTool,
  type CompositionToolCommand,
  type CompositionToolResult,
} from './composition-tool.js';

export type CompositionCommand =
  | { readonly kind: 'validate'; readonly file: string }
  | {
      readonly kind: 'replace';
      readonly file: string;
      readonly withFile: string;
      readonly stateDir?: string;
      readonly apiary?: string;
    }
  | {
      readonly kind: 'revisions';
      readonly compositionId?: string;
      readonly limit?: number;
      readonly stateDir?: string;
    }
  | { readonly kind: 'recover'; readonly file: string };

export interface ParsedCompositionCommand {
  readonly command: CompositionCommand;
  /** `--json` is a presentation switch, not part of the editing command. */
  readonly json: boolean;
}

export interface CompositionCliDependencies {
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
  /** Test seam: state root used when --state-dir is omitted. */
  readonly defaultStateDir?: string;
  /** Test seam: make the atomic write or audit append fail. */
  readonly edit?: CompositionEditDependencies;
}

const COMPOSITION_USAGE =
  'usage: wax composition validate [--json] <file>\n' +
  '       wax composition replace [--json] <file> --with <new-file> ' +
  '[--state-dir <dir>] [--apiary <id>]\n' +
  '       wax composition revisions [--json] [--composition <id>] ' +
  '[--limit <n>] [--state-dir <dir>]\n' +
  '       wax composition recover [--json] <file>';

const REPLACE_VALUE_FLAGS = new Set(['--with', '--state-dir', '--apiary']);
const REVISIONS_VALUE_FLAGS = new Set(['--composition', '--limit', '--state-dir']);

export function parseCompositionArgs(
  argv: readonly string[],
): ParsedCompositionCommand {
  const [command, subcommand, ...rest] = argv;
  if (command !== 'composition') {
    throw new CliUsageError(COMPOSITION_USAGE);
  }

  if (subcommand === 'validate') {
    const positionals: string[] = [];
    let json = false;
    for (const token of rest) {
      if (token === '--json') {
        if (json) {
          throw new CliUsageError("option '--json' was given more than once");
        }
        json = true;
        continue;
      }
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
    return {
      command: { kind: 'validate', file: positionals[0] as string },
      json,
    };
  }

  if (subcommand === 'replace') {
    const positionals: string[] = [];
    const flags = new Map<string, string>();
    let json = false;

    for (let index = 0; index < rest.length; index += 1) {
      const token = rest[index];
      if (token === undefined) {
        continue;
      }
      if (token === '--json') {
        if (json) {
          throw new CliUsageError("option '--json' was given more than once");
        }
        json = true;
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
      command: {
        kind: 'replace',
        file: positionals[0] as string,
        withFile,
        ...(stateDir === undefined ? {} : { stateDir }),
        ...(apiary === undefined ? {} : { apiary }),
      },
      json,
    };
  }

  if (subcommand === 'revisions') {
    const positionals: string[] = [];
    const flags = new Map<string, string>();
    let json = false;

    for (let index = 0; index < rest.length; index += 1) {
      const token = rest[index];
      if (token === undefined) {
        continue;
      }
      if (token === '--json') {
        if (json) {
          throw new CliUsageError("option '--json' was given more than once");
        }
        json = true;
        continue;
      }
      if (token.startsWith('--')) {
        if (!REVISIONS_VALUE_FLAGS.has(token)) {
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

    if (positionals.length !== 0) {
      throw new CliUsageError(
        '"wax composition revisions" takes no file; filter with --composition <id>',
      );
    }

    const compositionId = flags.get('--composition');
    const limitRaw = flags.get('--limit');
    const stateDir = flags.get('--state-dir');
    return {
      command: {
        kind: 'revisions',
        ...(compositionId === undefined ? {} : { compositionId }),
        ...(limitRaw === undefined ? {} : { limit: parseRevisionLimit(limitRaw) }),
        ...(stateDir === undefined ? {} : { stateDir }),
      },
      json,
    };
  }

  if (subcommand === 'recover') {
    const positionals: string[] = [];
    let json = false;
    for (const token of rest) {
      if (token === '--json') {
        if (json) {
          throw new CliUsageError("option '--json' was given more than once");
        }
        json = true;
        continue;
      }
      if (token.startsWith('--')) {
        throw new CliUsageError(
          `unknown option '${token}' for "wax composition recover"`,
        );
      }
      positionals.push(token);
    }
    if (positionals.length !== 1) {
      throw new CliUsageError(
        'expected exactly one composition file after "wax composition recover"',
      );
    }
    return {
      command: { kind: 'recover', file: positionals[0] as string },
      json,
    };
  }

  throw new CliUsageError(COMPOSITION_USAGE);
}

/** The subcommand named by argv, if it is one of the tool commands. */
function attemptedCommand(argv: readonly string[]): CompositionToolCommand | undefined {
  const subcommand = argv[0] === 'composition' ? argv[1] : undefined;
  if (
    subcommand === 'validate' ||
    subcommand === 'replace' ||
    subcommand === 'revisions' ||
    subcommand === 'recover'
  ) {
    return subcommand;
  }
  return undefined;
}

function revisionStateDir(
  command: Extract<CompositionCommand, { kind: 'revisions' }>,
  deps: CompositionCliDependencies,
): string {
  return command.stateDir ?? deps.defaultStateDir ?? DEFAULT_COMPOSITION_STATE_DIR;
}

function runRevisionsTool(
  command: Extract<CompositionCommand, { kind: 'revisions' }>,
  deps: CompositionCliDependencies,
): CompositionToolResult {
  return revisionsCompositionTool({
    stateDir: revisionStateDir(command, deps),
    ...(command.compositionId === undefined
      ? {}
      : { compositionId: command.compositionId }),
    ...(command.limit === undefined ? {} : { limit: command.limit }),
  });
}

function runReplaceTool(
  command: Extract<CompositionCommand, { kind: 'replace' }>,
  deps: CompositionCliDependencies,
): CompositionToolResult {
  const stateDir = command.stateDir ?? deps.defaultStateDir;
  return replaceCompositionTool(
    {
      file: command.file,
      withFile: command.withFile,
      ...(stateDir === undefined ? {} : { stateDir }),
      ...(command.apiary === undefined ? {} : { apiary: command.apiary }),
    },
    deps.edit ?? {},
  );
}

/**
 * `wax composition validate|replace|revisions|recover`.
 *
 * Exit codes: 0 success; usage is 2; validate/replace parse and refusal are 2;
 * a malformed revision audit line is a parse failure with exit 1; IO failure is
 * 1. Validation never writes; a replace is refused before any write when an
 * active reference or a live daemon lock is found. Revisions and recover are
 * read-only.
 *
 * With `--json`, stdout carries exactly one JSON object and stderr stays empty.
 * The JSON branch delegates to `composition-tool.ts`, which calls the same
 * service as the human branch.
 */
export function runCompositionCli(
  argv: readonly string[],
  deps: CompositionCliDependencies = {},
): number {
  const out = deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));

  let parsed: ParsedCompositionCommand;
  try {
    parsed = parseCompositionArgs(argv);
  } catch (error) {
    if (error instanceof CliUsageError) {
      const command = attemptedCommand(argv);
      if (command !== undefined && argv.includes('--json')) {
        out(JSON.stringify(compositionToolFailure(command, error)));
      } else {
        err(error.message);
      }
      return 2;
    }
    throw error;
  }

  if (parsed.json) {
    let result: CompositionToolResult;
    switch (parsed.command.kind) {
      case 'validate':
        result = validateCompositionTool(parsed.command.file);
        break;
      case 'replace':
        result = runReplaceTool(parsed.command, deps);
        break;
      case 'revisions':
        result = runRevisionsTool(parsed.command, deps);
        break;
      case 'recover':
        result = recoverCompositionTool(parsed.command.file);
        break;
    }
    out(JSON.stringify(result));
    return compositionToolExitCode(result);
  }

  if (parsed.command.kind === 'validate') {
    try {
      const definition = loadCompositionFile(parsed.command.file);
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

  if (parsed.command.kind === 'revisions') {
    const stateDir = revisionStateDir(parsed.command, deps);
    try {
      const entries = readCompositionRevisions({
        stateDir,
        ...(parsed.command.compositionId === undefined
          ? {}
          : { compositionId: parsed.command.compositionId }),
        ...(parsed.command.limit === undefined ? {} : { limit: parsed.command.limit }),
      });
      out(`audit        ${compositionAuditPath(stateDir)}`);
      out(`revisions    ${String(entries.length)}`);
      for (const entry of entries) {
        out(
          `${entry.at}  ${entry.compositionId}  ` +
            `${entry.oldRevision} -> ${entry.newRevision}  ${entry.mode}  ${entry.file}`,
        );
      }
      return 0;
    } catch (error) {
      if (error instanceof CompositionAuditParseError) {
        err(error.message);
        return 1;
      }
      if (error instanceof CompositionAuditIoError) {
        err(`error: ${error.message}`);
        return 1;
      }
      if (error instanceof CliUsageError) {
        err(error.message);
        return 2;
      }
      err(`error: ${messageOf(error)}`);
      return 1;
    }
  }

  if (parsed.command.kind === 'recover') {
    try {
      const inspection = inspectCompositionRecovery(parsed.command.file);
      out(`file         ${inspection.file}`);
      out(`candidates   ${String(inspection.candidates.length)}`);
      for (const candidate of inspection.candidates) {
        if (candidate.valid) {
          out(
            `candidate    valid    ${candidate.path}  ` +
              `composition=${candidate.compositionId} revision=${candidate.graphRevision}`,
          );
        } else {
          out(`candidate    invalid  ${candidate.path}  ${candidate.error}`);
        }
      }
      out('mutations    none (read-only inspection)');
      return 0;
    } catch (error) {
      if (error instanceof CompositionAuditIoError) {
        err(`error: ${error.message}`);
        return 1;
      }
      if (error instanceof CliUsageError) {
        err(error.message);
        return 2;
      }
      err(`error: ${messageOf(error)}`);
      return 1;
    }
  }

  try {
    const result = replaceComposition(
      {
        file: parsed.command.file,
        withFile: parsed.command.withFile,
        stateDir:
          parsed.command.stateDir ?? deps.defaultStateDir ?? DEFAULT_COMPOSITION_STATE_DIR,
        ...(parsed.command.apiary === undefined
          ? {}
          : { apiary: parsed.command.apiary }),
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
