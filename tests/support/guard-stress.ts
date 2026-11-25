import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ControlServer } from '../../src/control/server.js';
import type { Project } from '../../src/project/kernel.js';
import { SessionRegistry } from '../../src/session/session-registry.js';
import { Workspace } from '../../src/session/workspace.js';
import { FakeAdapter } from './fake-adapter.js';
import { bLoad, waitForRunTerminal } from './control-server-http.js';

/** Rounds are configurable for a longer soak; 50 is the M12a acceptance floor. */
export const STRESS_ROUNDS = readPositiveInteger(
  process.env['WAX_GUARD_STRESS_ROUNDS'],
  50,
);

export interface Env {
  readonly registry: SessionRegistry;
  readonly workspaces: readonly Workspace[];
  readonly project: Project;
  readonly stateRoot: string;
  readonly daemonDir: string;
}

export interface Running {
  readonly server: ControlServer;
  readonly url: string;
  readonly token: string;
  readonly logs: string[];
}

export interface DecisionResult {
  readonly status: number;
  readonly code: string;
}

interface RawResult {
  readonly status: number;
  readonly body: Record<string, any> | undefined;
  readonly text: string;
}

export interface Observation {
  readonly round: number;
  readonly phase: string;
  readonly status: number;
  readonly code: string;
}

function readPositiveInteger(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function makeEnv(workspaceByHarness: Map<string, Workspace>): Env {
  const project: Project = {
    id: `guard-stress-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`,
    directory: mkdtempSync(join(tmpdir(), 'wax-m12a-guard-stress-project-')),
  };
  const registry = new SessionRegistry({ workspaces: workspaceByHarness });
  const stateRoot = mkdtempSync(join(tmpdir(), 'wax-m12a-guard-stress-state-'));
  return {
    registry,
    workspaces: [...workspaceByHarness.values()],
    project,
    stateRoot,
    daemonDir: join(stateRoot, 'waxd'),
  };
}

export async function start(env: Env, guardTimeoutMs: number): Promise<Running> {
  const logs: string[] = [];
  const server = new ControlServer({
    registry: env.registry,
    stateRoot: env.stateRoot,
    apiary: 'apiary',
    daemonDir: env.daemonDir,
    liveProject: env.project,
    guardTimeoutMs,
    logger: (line) => logs.push(line),
  });
  const info = await server.start();
  return {
    server,
    url: info.url,
    token: readFileSync(info.tokenPath, 'utf8').trim(),
    logs,
  };
}

export function singleHarness(adapter: FakeAdapter): Map<string, Workspace> {
  return new Map([['codex', new Workspace(adapter)]]);
}

export function dualHarness(
  codex: FakeAdapter,
  dsh: FakeAdapter,
): Map<string, Workspace> {
  return new Map([
    ['codex', new Workspace(codex)],
    ['dsh', new Workspace(dsh)],
  ]);
}

function definition(id: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id,
    nodes: {
      only: {
        kind: 'forager',
        config: { connection: 'fake', prompt: 'run {{input}}' },
      },
    },
    edges: [],
  };
}

/**
 * Every polling/decision request gets its own connection. Node's fetch
 * dispatcher can hold a pooled GET behind the still-pending wake POST, which
 * would hide the guard and turn the race into a client artifact instead of
 * exercising the server.
 */
function rawCall(
  running: Running,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<RawResult> {
  const target = new URL(running.url);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: target.hostname,
        port: target.port,
        method,
        path,
        agent: false,
        headers: {
          authorization: `Bearer ${running.token}`,
          ...(payload === undefined
            ? {}
            : {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(payload),
              }),
        },
      },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          text += chunk;
        });
        response.on('end', () => {
          let parsed: Record<string, any> | undefined;
          try {
            const value: unknown = JSON.parse(text);
            if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
              parsed = value as Record<string, any>;
            }
          } catch {
            parsed = undefined;
          }
          resolve({ status: response.statusCode ?? 0, body: parsed, text });
        });
      },
    );
    request.on('error', reject);
    request.end(payload);
  });
}

export function wakeLive(running: Running, liveId: string): Promise<RawResult> {
  return rawCall(running, 'POST', '/lives/wake', {
    liveId,
    beeId: 'only',
    input: 'go',
  });
}

/** Await one admission and then its run terminal state, so approvals settled. */
export async function settleWake(
  running: Running,
  liveId: string,
  wakePromise: Promise<RawResult>,
): Promise<RawResult> {
  const wake = await wakePromise;
  assert.equal(wake.status, 202, wake.text);
  await waitForRunTerminal(
    running.url,
    running.token,
    liveId,
    String(wake.body?.['runId']),
  );
  return wake;
}

export async function load(
  running: Running,
  env: Env,
  liveId: string,
  harness?: string,
): Promise<void> {
  const loaded = await bLoad(running.url, running.token, {
    definition: definition(liveId),
    bindings: { only: harness === undefined ? { kind: 'fresh' } : { kind: 'fresh', harness } },
    project: env.project,
  });
  assert.equal(loaded.status, 200, `live ${liveId} did not load: ${loaded.text}`);
}

export async function unloadLive(running: Running, liveId: string): Promise<void> {
  const unloaded = await rawCall(running, 'POST', '/lives/unload', { liveId });
  assert.equal(unloaded.status, 200, `live ${liveId} did not unload: ${unloaded.text}`);
}

async function listedGuards(running: Running): Promise<Record<string, unknown>[]> {
  const response = await rawCall(running, 'GET', '/guards');
  assert.equal(response.status, 200);
  return (response.body?.['guards'] as Record<string, unknown>[] | undefined) ?? [];
}

export async function waitForGuardCount(
  running: Running,
  expected: number,
  timeoutMs = 5_000,
): Promise<Record<string, unknown>[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const guards = await listedGuards(running);
    if (guards.length === expected) {
      return guards;
    }
    await sleep(5);
  }
  throw new Error(`timed out waiting for ${String(expected)} pending guard(s)`);
}

export async function decide(
  running: Running,
  requestId: unknown,
  decision: string,
): Promise<DecisionResult> {
  const response = await rawCall(running, 'POST', '/guard/decide', {
    requestId,
    decision,
  });
  return {
    status: response.status,
    code: typeof response.body?.['code'] === 'string' ? response.body['code'] : '',
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function server500Class(running: Running): string | undefined {
  const line = [...running.logs].reverse().find((entry) => entry.includes('status=500'));
  const match = line?.match(/errorClass=(\S+)/);
  return match?.[1];
}

/**
 * The only acceptable outcome is a classified HTTP status. A 500 is reported
 * with the request id, phase and elapsed time captured by the caller; the
 * request log supplies the sanitized error class.
 */
export function refuse500(
  running: Running,
  result: DecisionResult,
  phase: string,
  requestId: unknown,
  elapsedMs: number,
): void {
  if (result.status !== 500) {
    return;
  }
  assert.fail(
    `500 observed: phase=${phase} requestId=${String(requestId)} ` +
      `elapsedMs=${String(elapsedMs)} errorClass=${server500Class(running) ?? result.code}`,
  );
}

export function record(
  observations: Observation[],
  round: number,
  phase: string,
  result: DecisionResult,
): void {
  observations.push({ round, phase, status: result.status, code: result.code });
}

export function distribution(observations: readonly Observation[]): string {
  const counts = new Map<string, number>();
  for (const observation of observations) {
    const key = `${String(observation.status)}/${observation.code === '' ? '-' : observation.code}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, count]) => `${key}:${String(count)}`)
    .join(',');
}

export function fiveHundredLogs(running: Running): readonly string[] {
  return running.logs.filter((line) => line.includes('status=500'));
}

export async function dispose(running: Running | undefined, env: Env): Promise<void> {
  await running?.server.stop().catch(() => undefined);
  for (const workspace of env.workspaces) {
    await workspace.stop().catch(() => undefined);
  }
}
