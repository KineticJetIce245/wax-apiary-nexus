import {
  CliUsageError,
  messageOf,
  readCompositionFile,
  CompositionParseError,
  CompositionReadError,
} from './cli-shared.js';
import {
  CompositionEditRefusedError,
  CompositionIoError,
  DEFAULT_COMPOSITION_STATE_DIR,
  replaceComposition,
  type ActiveReferenceCheck,
  type CompositionEditDependencies,
} from './composition-edit.js';

/**
 * Transport-neutral result contract for the Stage 4B-A composition tool.
 *
 * This layer only calls the existing editing functions and maps their errors to
 * stable codes. Active-reference, daemon-lock, atomic-write and audit policy
 * stays in `composition-edit.ts`; a future MCP wrapper can use this module
 * without changing that policy.
 */
export type CompositionToolCommand = 'validate' | 'replace';

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

export type CompositionToolSuccess =
  | CompositionToolSuccessValidate
  | CompositionToolSuccessReplace;

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
  if (error instanceof CompositionReadError) {
    return 'io';
  }
  if (error instanceof CompositionIoError) {
    return 'io';
  }
  if (error instanceof CliUsageError) {
    return 'usage';
  }
  return 'internal';
}

/** `0` success, `2` usage/parse/refusal, `1` IO or unexpected failure. */
export function compositionToolExitCode(result: CompositionToolResult): number {
  if (result.ok) {
    return 0;
  }
  return result.code === 'usage' || result.code === 'parse' || result.code === 'refused'
    ? 2
    : 1;
}
