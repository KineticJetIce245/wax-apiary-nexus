import type { RuntimeLogEntry } from './log.js';
import { WorkerExecutionError, type WorkerResult } from './worker.js';

/**
 * Worker metadata safe for the runtime log: program name, pid and byte counts
 * only. Output bodies stay in the Value (stdout) or the error (stderr).
 */
export function workerLogFields(
  worker: WorkerResult | WorkerExecutionError,
): Partial<RuntimeLogEntry> {
  return {
    program: worker.program,
    ...(worker.pid === undefined ? {} : { pid: worker.pid }),
    stdoutBytes: worker.stdoutBytes,
    stderrBytes: worker.stderrBytes,
    ...(worker.exitCode === undefined ? {} : { exitCode: worker.exitCode }),
  };
}
