import { execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';

/** Upper bound for the synchronous `taskkill` call; a hung helper must not stall `stop()`. */
const TASKKILL_TIMEOUT_MS = 5_000;

/**
 * Terminate a harness process together with every child it spawned. Killing
 * only the ACP process can leave DSH tool children behind, and a stale
 * descendant can stall the next harness start.
 * @param child - the spawned harness process.
 */
export function killProcessTree(child: ChildProcessWithoutNullStreams): void {
  if (process.platform !== 'win32') {
    safeKill(child, 'SIGKILL');
    return;
  }
  if (child.pid !== undefined) {
    try {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
        timeout: TASKKILL_TIMEOUT_MS,
      });
      return;
    } catch {
      // taskkill could not reach the tree; fall through to the direct kill.
    }
  }
  safeKill(child);
}

function safeKill(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals = 'SIGTERM',
): void {
  try {
    child.kill(signal);
  } catch {
    // The process may already be gone.
  }
}
