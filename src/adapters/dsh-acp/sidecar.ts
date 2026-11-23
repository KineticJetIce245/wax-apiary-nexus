import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Canonical cwd spelling shared with the `wax-bridge` DSH plugin: resolved
 * real path, Windows `\\?\` prefix stripped, and lowercased on Windows.
 * @param path - project directory.
 * @returns canonical path used as the title-sidecar key.
 */
export function canonicalCwd(path: string): string {
  let resolved: string;
  try {
    resolved = realpathSync.native(path);
  } catch {
    resolved = resolve(path);
  }
  const noPrefix = resolved.replace(/^\\\\\?\\/, '');
  return process.platform === 'win32' ? noPrefix.toLowerCase() : noPrefix;
}

/**
 * Deterministic title-sidecar filename for one project directory.
 * @param directory - project directory.
 * @returns `<sha256(canonicalCwd)>.json`.
 */
export function sessionTitleSidecarName(directory: string): string {
  return `${createHash('sha256').update(canonicalCwd(directory)).digest('hex')}.json`;
}
