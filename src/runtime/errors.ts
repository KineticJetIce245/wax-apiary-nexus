/** The persisted field cannot be applied to this composition. */
export class FieldRestoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FieldRestoreError';
  }
}

/**
 * A persisted Honey file written by an incompatible schema or data shape.
 * Loading fails closed: there is no migration and the old state is kept.
 * The HTTP mapping is deliberately not decided in this slice (M19e).
 */
export class HoneyIncompatibleError extends FieldRestoreError {
  readonly code = 'honey-incompatible';

  constructor(message: string) {
    super(message);
    this.name = 'HoneyIncompatibleError';
  }
}

/** A target path that this slice has not implemented yet (spread/gather). */
export class NotImplementedError extends Error {
  readonly code = 'not-implemented';

  constructor(
    readonly feature: string,
    message: string,
  ) {
    super(`${feature}: ${message}`);
    this.name = 'NotImplementedError';
  }
}

/** A dot path is malformed or targets a forbidden key. */
export class ValuePathError extends Error {
  readonly code = 'invalid-value-path';

  constructor(message: string) {
    super(message);
    this.name = 'ValuePathError';
  }
}

/** A result carries a value and a drop for the same path. */
export class ValueDropOverlapError extends Error {
  readonly code = 'drop-overlap';

  constructor(readonly path: string) {
    super(`result carries a value and a drop for the same path '${path}'`);
    this.name = 'ValueDropOverlapError';
  }
}

export type BeeIoErrorCode = 'missing-read' | 'missing-write' | 'invalid-reply';

/** A Bee's declared input/output contract was not satisfied. */
export class BeeIoError extends Error {
  readonly code: BeeIoErrorCode;

  constructor(
    code: BeeIoErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'BeeIoError';
    this.code = code;
  }
}

/** A code-block rule threw, timed out, or returned the wrong result type. */
export class RuleExecutionError extends Error {
  readonly code = 'rule-execution';

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RuleExecutionError';
  }
}
