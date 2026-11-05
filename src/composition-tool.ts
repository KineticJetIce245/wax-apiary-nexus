import {
  CliUsageError,
  messageOf,
  readCompositionFile,
  CompositionParseError,
  CompositionReadError,
} from './cli-shared.js';
import {
  CompositionAuditIoError,
  CompositionAuditParseError,
  inspectCompositionRecovery,
  readCompositionRevisions,
  type CompositionRecoveryCandidate,
  type CompositionRevisionEntry,
  type ReadCompositionRevisionsOptions,
} from './composition-audit.js';
import {
  CompositionEditRefusedError,
  CompositionIoError,
  DEFAULT_COMPOSITION_STATE_DIR,
  replaceComposition,
  type ActiveReferenceCheck,
  type CompositionEditDependencies,
} from './composition-edit.js';

/**
 * Transport-neutral result contract for the composition tool commands.
 *
 * This layer only calls the editing/audit services and maps their errors to
 * stable codes. Active-reference, daemon-lock, atomic-write, audit and
 * recovery-inspection policy stays in the service modules; a future MCP wrapper
 * can use this module without changing that policy.
 */
export type CompositionToolCommand = 'validate' | 'replace' | 'revisions' | 'recover';

export type CompositionToolFailureCode =
  | 'usage'
  | 'parse'
  | 'refused'
  | 'io'
  | 'internal';

export interface CompositionToolSuccessValidate {
  readonly ok: true;
  readonly command: 'validate';
  readonly compositionId: string;
  readonly graphRevision: string;
}

export interface CompositionToolSuccessReplace {
  readonly ok: true;
  readonly command: 'replace';
  readonly compositionId: string;
  readonly oldRevision: string;
  readonly newRevision: string;
  readonly file: string;
  readonly auditPath: string;
  readonly activeReferences: ActiveReferenceCheck;
  readonly staleLockPath?: string;
}

export interface CompositionToolSuccessRevisions {
  readonly ok: true;
  readonly command: 'revisions';
  readonly entries: readonly CompositionRevisionEntry[];
  /** A successful read never skips a line; kept for the frozen JSON shape. */
  readonly malformed: 0;
}

export interface CompositionToolSuccessRecover {
  readonly ok: true;
  readonly command: 'recover';
  readonly file: string;
  readonly candidates: readonly CompositionRecoveryCandidate[];
}

export type CompositionToolSuccess =
  | CompositionToolSuccessValidate
  | CompositionToolSuccessReplace
  | CompositionToolSuccessRevisions
  | CompositionToolSuccessRecover;

export interface CompositionToolFailure {
  readonly ok: false;
  readonly command: CompositionToolCommand;
  readonly code: CompositionToolFailureCode;
  readonly error: string;
}

export type CompositionToolResult = CompositionToolSuccess | CompositionToolFailure;

export interface ReplaceCompositionToolOptions {
  readonly file: string;
  readonly withFile: string;
  /** Defaults to the same state root as `wax run` and `wax daemon`. */
  readonly stateDir?: string;
  readonly apiary?: string;
}

/** Parses and validates one composition; never writes. */
export function validateCompositionTool(file: string): CompositionToolResult {
  try {
    const { definition } = readCompositionFile(file);
    return {
      ok: true,
      command: 'validate',
      compositionId: definition.id,
      graphRevision: definition.graphRevision,
    };
  } catch (error) {
    return compositionToolFailure('validate', error);
  }
}

/** Replaces one composition through the existing guarded editing service. */
export function replaceCompositionTool(
  options: ReplaceCompositionToolOptions,
  deps: CompositionEditDependencies = {},
): CompositionToolResult {
  try {
    const result = replaceComposition(
      {
        file: options.file,
        withFile: options.withFile,
        stateDir: options.stateDir ?? DEFAULT_COMPOSITION_STATE_DIR,
        ...(options.apiary === undefined ? {} : { apiary: options.apiary }),
      },
      deps,
    );
    return {
      ok: true,
      command: 'replace',
      ...result,
    };
  } catch (error) {
    return compositionToolFailure('replace', error);
  }
}

/** Reads the revision audit; never writes. */
export function revisionsCompositionTool(
  options: ReadCompositionRevisionsOptions = {},
): CompositionToolResult {
  try {
    const entries = readCompositionRevisions(options);
    return {
      ok: true,
      command: 'revisions',
      entries,
      malformed: 0,
    };
  } catch (error) {
    return compositionToolFailure('revisions', error);
  }
}

/** Inspects orphan temp candidates; never renames, deletes or overwrites. */
export function recoverCompositionTool(file: string): CompositionToolResult {
  try {
    const result = inspectCompositionRecovery(file);
    return {
      ok: true,
      command: 'recover',
      ...result,
    };
  } catch (error) {
    return compositionToolFailure('recover', error);
  }
}

/** Maps one thrown editing error to a stable failure code and message. */
export function compositionToolFailure(
  command: CompositionToolCommand,
  error: unknown,
): CompositionToolFailure {
  return {
    ok: false,
    command,
    code: compositionToolFailureCode(error),
    error: messageOf(error),
  };
}

function compositionToolFailureCode(error: unknown): CompositionToolFailureCode {
  if (error instanceof CompositionEditRefusedError) {
    return 'refused';
  }
  if (error instanceof CompositionParseError) {
    return 'parse';
  }
  if (error instanceof CompositionAuditParseError) {
    return 'parse';
  }
  if (error instanceof CompositionReadError) {
    return 'io';
  }
  if (error instanceof CompositionIoError) {
    return 'io';
  }
  if (error instanceof CompositionAuditIoError) {
    return 'io';
  }
  if (error instanceof CliUsageError) {
    return 'usage';
  }
  return 'internal';
}

/**
 * `0` success, `2` usage/parse/refusal, `1` IO or unexpected failure.
 *
 * The read-only audit commands use `1` for a malformed audit line, matching
 * their human-mode exit code; `validate`/`replace` keep their earlier mapping.
 */
export function compositionToolExitCode(result: CompositionToolResult): number {
  if (result.ok) {
    return 0;
  }
  if (result.code === 'usage') {
    return 2;
  }
  if (result.command === 'validate' || result.command === 'replace') {
    return result.code === 'parse' || result.code === 'refused' ? 2 : 1;
  }
  return 1;
}
