/** Raised when an input composition does not match the documented schema. */
export class CompositionValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`invalid composition:\n${issues.map((issue) => `- ${issue}`).join('\n')}`);
    this.name = 'CompositionValidationError';
    this.issues = issues;
  }
}
