import { spawn, type ChildProcess } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import type { WorkerConfig } from './types.js';

/** Contract defaults: one minute, 64 KiB per stream. */
export const DEFAULT_WORKER_TIMEOUT_MS = 60_000;
export const MAX_WORKER_OUTPUT_BYTES = 64 * 1024;

/** How long a killed process may take to emit `close` before we give up. */
const KILL_GRACE_MS = 5_000;
const TASKKILL_TIMEOUT_MS = 2_000;

export type WorkerFailureCode = 'cwd' | 'spawn' | 'timeout' | 'output-cap' | 'exit';

export type WorkerCwdErrorCode =
  | 'project-unavailable'
  | 'invalid'
  | 'parent'
  | 'outside'
  | 'missing'
  | 'symlink'
  | 'not-directory';

/** A cwd that cannot be proven to stay inside the registered project. */
export class WorkerCwdError extends Error {
  constructor(
    message: string,
    readonly code: WorkerCwdErrorCode,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'WorkerCwdError';
  }
}

interface WorkerExecutionErrorInit {
  readonly code: WorkerFailureCode;
  readonly program: string;
  readonly message: string;
  readonly durationMs: number;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly pid?: number;
  readonly exitCode?: number;
  readonly stderr?: string;
  readonly cause?: unknown;
}

/**
 * A failed worker activation. The bounded (at most 64 KiB) stderr is available
 * to the caller as metadata; it is never the Value and is never written to the
 * composition log, which carries byte counts instead.
 */
export class WorkerExecutionError extends Error {
  readonly code: WorkerFailureCode;
  readonly program: string;
  readonly pid: number | undefined;
  readonly durationMs: number;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly exitCode: number | undefined;
  readonly stderr: string;

  constructor(init: WorkerExecutionErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'WorkerExecutionError';
    this.code = init.code;
    this.program = init.program;
    this.pid = init.pid;
    this.durationMs = init.durationMs;
    this.stdoutBytes = init.stdoutBytes;
    this.stderrBytes = init.stderrBytes;
    this.exitCode = init.exitCode;
    this.stderr = init.stderr ?? '';
  }
}

export interface WorkerResult {
  readonly program: string;
  readonly pid: number | undefined;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly durationMs: number;
}

/** A non-zero exit is a worker failure, not a runtime protocol error. */
export function workerExitError(result: WorkerResult): WorkerExecutionError {
  return new WorkerExecutionError({
    code: 'exit',
    program: result.program,
    message: `worker '${result.program}' exited with code ${String(result.exitCode)}`,
    durationMs: result.durationMs,
    stdoutBytes: result.stdoutBytes,
    stderrBytes: result.stderrBytes,
    ...(result.pid === undefined ? {} : { pid: result.pid }),
    exitCode: result.exitCode,
    stderr: result.stderr,
  });
}

/**
 * Resolves the worker cwd inside the real project directory.
 *
 * Containment is checked twice: lexically after `resolve`, then again after
 * `realpath`, so a symlinked path cannot escape the project. `..` segments are
 * rejected outright even when they would resolve back inside.
 */
export function resolveWorkerCwd(projectDirectory: string, cwd: string): string {
  let projectReal: string;
  try {
    projectReal = realpathSync.native(projectDirectory);
  } catch (error) {
    throw new WorkerCwdError(
      `project directory '${projectDirectory}' is unavailable`,
      'project-unavailable',
      { cause: error },
    );
  }

  let projectStats;
  try {
    projectStats = statSync(projectReal);
  } catch (error) {
    throw new WorkerCwdError(
      `project directory '${projectDirectory}' is unavailable`,
      'project-unavailable',
      { cause: error },
    );
  }
  if (!projectStats.isDirectory()) {
    throw new WorkerCwdError(
      `project path '${projectDirectory}' is not a directory`,
      'project-unavailable',
    );
  }

  if (cwd === '' || cwd.includes('\0')) {
    throw new WorkerCwdError(`worker cwd '${cwd}' is not a valid path`, 'invalid');
  }
  if (hasParentSegment(cwd)) {
    throw new WorkerCwdError(`worker cwd '${cwd}' must not contain '..'`, 'parent');
  }

  const candidate = isAbsolute(cwd) ? resolve(cwd) : resolve(projectReal, cwd);
  if (!isInside(projectReal, candidate)) {
    throw new WorkerCwdError(
      `worker cwd '${cwd}' resolves outside the project directory`,
      'outside',
    );
  }

  let candidateReal: string;
  try {
    candidateReal = realpathSync.native(candidate);
  } catch (error) {
    throw new WorkerCwdError(`worker cwd '${cwd}' does not exist`, 'missing', { cause: error });
  }
  if (!isInside(projectReal, candidateReal)) {
    throw new WorkerCwdError(
      `worker cwd '${cwd}' escapes the project directory through a symlink`,
      'symlink',
    );
  }

  let candidateStats;
  try {
    candidateStats = statSync(candidateReal);
  } catch (error) {
    throw new WorkerCwdError(`worker cwd '${cwd}' does not exist`, 'missing', { cause: error });
  }
  if (!candidateStats.isDirectory()) {
    throw new WorkerCwdError(`worker cwd '${cwd}' is not a directory`, 'not-directory');
  }

  return candidateReal;
}

/**
 * Runs one argv worker to completion.
 *
 * The runtime awaits this promise; there is no `HoverSpec.kind = 'worker'`.
 * Both streams are bounded at 64 KiB, the timeout and output caps kill the
 * process tree, and a non-zero exit is returned (the caller decides whether it
 * is a failure or a false Condition branch).
 */
export async function runWorker(
  config: WorkerConfig,
  projectDirectory: string,
): Promise<WorkerResult> {
  const startedAt = Date.now();

  let cwd: string;
  try {
    cwd = resolveWorkerCwd(projectDirectory, config.cwd);
  } catch (error) {
    throw new WorkerExecutionError({
      code: 'cwd',
      program: config.command,
      message: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startedAt,
      stdoutBytes: 0,
      stderrBytes: 0,
      cause: error,
    });
  }

  return await new Promise<WorkerResult>((resolveResult, rejectResult) => {
    let child: ChildProcess;
    try {
      child = spawn(config.command, [...config.args], {
        cwd,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      rejectResult(
        new WorkerExecutionError({
          code: 'spawn',
          program: config.command,
          message: `worker '${config.command}' could not be started: ${messageOf(error)}`,
          durationMs: Date.now() - startedAt,
          stdoutBytes: 0,
          stderrBytes: 0,
          cause: error,
        }),
      );
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure: WorkerExecutionError | undefined;
    let settled = false;
    let closeFallback: NodeJS.Timeout | undefined;

    const finish = (result: WorkerResult | undefined, error: WorkerExecutionError | undefined): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (closeFallback !== undefined) {
        clearTimeout(closeFallback);
      }
      if (error !== undefined) {
        rejectResult(error);
      } else if (result !== undefined) {
        resolveResult(result);
      }
    };

    const fail = (error: WorkerExecutionError): void => {
      if (failure !== undefined || settled) {
        return;
      }
      failure = error;
      void killProcessTree(child);
      // `close` should follow the kill; do not leave the run hanging if the
      // platform never reports it.
      closeFallback = setTimeout(() => {
        if (failure !== undefined) {
          finish(undefined, failure);
        }
      }, KILL_GRACE_MS);
      closeFallback.unref();
    };

    const onChunk = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
      if (failure !== undefined || settled) {
        return;
      }
      const nextBytes = stream === 'stdout' ? stdoutBytes + chunk.length : stderrBytes + chunk.length;
      if (stream === 'stdout') {
        stdoutBytes = nextBytes;
      } else {
        stderrBytes = nextBytes;
      }
      if (nextBytes > MAX_WORKER_OUTPUT_BYTES) {
        fail(
          new WorkerExecutionError({
            code: 'output-cap',
            program: config.command,
            message: `worker '${config.command}' exceeded the ${String(MAX_WORKER_OUTPUT_BYTES)} byte ${stream} cap`,
            durationMs: Date.now() - startedAt,
            stdoutBytes,
            stderrBytes,
            ...(child.pid === undefined ? {} : { pid: child.pid }),
          }),
        );
        return;
      }
      if (stream === 'stdout') {
        stdoutChunks.push(chunk);
      } else {
        stderrChunks.push(chunk);
      }
    };

    const timer = setTimeout(() => {
      fail(
        new WorkerExecutionError({
          code: 'timeout',
          program: config.command,
          message: `worker '${config.command}' timed out after ${String(config.timeoutMs)} ms`,
          durationMs: Date.now() - startedAt,
          stdoutBytes,
          stderrBytes,
          ...(child.pid === undefined ? {} : { pid: child.pid }),
        }),
      );
    }, config.timeoutMs);
    timer.unref();

    child.stdout?.on('data', (chunk: Buffer) => {
      onChunk('stdout', chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      onChunk('stderr', chunk);
    });

    child.once('error', (error) => {
      if (failure !== undefined || settled) {
        return;
      }
      failure = new WorkerExecutionError({
        code: 'spawn',
        program: config.command,
        message: `worker '${config.command}' could not be started: ${messageOf(error)}`,
        durationMs: Date.now() - startedAt,
        stdoutBytes,
        stderrBytes,
        ...(child.pid === undefined ? {} : { pid: child.pid }),
        cause: error,
      });
      void killProcessTree(child);
      if (child.pid === undefined) {
        // A spawn failure never reaches `close` with a live process.
        finish(undefined, failure);
      } else {
        closeFallback = setTimeout(() => {
          if (failure !== undefined) {
            finish(undefined, failure);
          }
        }, KILL_GRACE_MS);
        closeFallback.unref();
      }
    });

    child.once('close', (code, signal) => {
      if (settled) {
        return;
      }
      if (failure !== undefined) {
        finish(undefined, failure);
        return;
      }
      if (code === null) {
        finish(
          undefined,
          new WorkerExecutionError({
            code: 'spawn',
            program: config.command,
            message: `worker '${config.command}' ended without an exit code (signal ${signal ?? 'unknown'})`,
            durationMs: Date.now() - startedAt,
            stdoutBytes,
            stderrBytes,
            ...(child.pid === undefined ? {} : { pid: child.pid }),
          }),
        );
        return;
      }
      finish(
        {
          program: config.command,
          pid: child.pid,
          exitCode: code,
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
          stdoutBytes,
          stderrBytes,
          durationMs: Date.now() - startedAt,
        },
        undefined,
      );
    });
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasParentSegment(cwd: string): boolean {
  const segments = process.platform === 'win32' ? cwd.split(/[\\/]+/) : cwd.split('/');
  return segments.includes('..');
}

function isInside(root: string, candidate: string): boolean {
  const normalizedRoot = process.platform === 'win32' ? root.toLowerCase() : root;
  const normalizedCandidate = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
  const rel = relative(normalizedRoot, normalizedCandidate);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

/** Kill the whole process tree; waiting for taskkill avoids orphaned children. */
function killProcessTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) {
    safeKill(child);
    return Promise.resolve();
  }

  if (process.platform === 'win32') {
    return new Promise<void>((resolveKill) => {
      let done = false;
      const complete = (): void => {
        if (done) {
          return;
        }
        done = true;
        // Fallback when taskkill could not reach the tree.
        if (child.exitCode === null && child.signalCode === null) {
          safeKill(child);
        }
        resolveKill();
      };

      let killer: ChildProcess;
      try {
        killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
          stdio: 'ignore',
          shell: false,
          windowsHide: true,
        });
      } catch {
        safeKill(child);
        resolveKill();
        return;
      }

      const fallback = setTimeout(complete, TASKKILL_TIMEOUT_MS);
      fallback.unref();
      killer.once('error', complete);
      killer.once('close', complete);
    });
  }

  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    safeKill(child);
  }
  return Promise.resolve();
}

function safeKill(child: ChildProcess): void {
  try {
    child.kill('SIGKILL');
  } catch {
    // Already gone.
  }
}
