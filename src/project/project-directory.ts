import { statSync } from 'node:fs';

export type ProjectDirectoryErrorCode = 'missing' | 'not-directory' | 'unavailable';

/**
 * A failed project-directory check. The code distinguishes the cases callers
 * may need to report differently; it is not a claim about disk identity.
 */
export class ProjectDirectoryError extends Error {
  constructor(
    message: string,
    readonly code: ProjectDirectoryErrorCode,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ProjectDirectoryError';
  }
}

/**
 * Check the directory at the moment of a create/submit operation. This does
 * not prove the directory will still be there for the following call.
 */
export function assertProjectDirectory(directory: string): void {
  let stats;
  try {
    stats = statSync(directory);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new ProjectDirectoryError(
        `Project directory does not exist: ${directory}`,
        'missing',
        { cause: error },
      );
    }
    throw new ProjectDirectoryError(
      `Project directory is unavailable: ${directory}`,
      'unavailable',
      { cause: error },
    );
  }

  if (!stats.isDirectory()) {
    throw new ProjectDirectoryError(
      `Project path is not a directory: ${directory}`,
      'not-directory',
    );
  }
}
