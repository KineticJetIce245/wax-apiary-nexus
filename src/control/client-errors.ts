export interface ControlClientErrorOptions {
  /** Server error code, or `network` | `timeout` | `discovery` | `protocol`. */
  readonly code: string;
  readonly status?: number;
}

/**
 * Typed control-channel failure. Its message is always built from static text
 * and the HTTP status/code alone: never from a response body, a token, a
 * prompt or an output. Callers can therefore log `message` safely.
 */
export class ControlClientError extends Error {
  readonly code: string;
  readonly status?: number;

  constructor(message: string, options: ControlClientErrorOptions) {
    super(message);
    this.name = 'ControlClientError';
    this.code = options.code;
    if (options.status !== undefined) {
      this.status = options.status;
    }
  }
}
