/** The persisted field cannot be applied to this composition. */
export class FieldRestoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FieldRestoreError';
  }
}
