import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DshAcpAdapter } from '../../src/adapters/dsh-acp/adapter.js';
import { ControlServer } from '../../src/control/server.js';
import type { Project } from '../../src/project/kernel.js';
import { SessionRegistry } from '../../src/session/session-registry.js';
import {
  Workspace,
  type WorkspaceEvent,
} from '../../src/session/workspace.js';
import { bLoad, bWake, admissionRunId, waitForRunTerminal } from '../support/control-server-http.js';

const dshRoot = process.env.DSH_ROOT;
const builtCli =
  dshRoot === undefined ? undefined : join(dshRoot, 'apps', 'cli', 'lib', 'bin.js');
const hasKey =
  process.env.DEEPSEEK_API_KEY !== undefined &&
  process.env.DEEPSEEK_API_KEY.trim() !== '';
const integrationOptions = {
  skip:
    dshRoot === undefined || builtCli === undefined || !existsSync(builtCli) || !hasKey
      ? 'Real DSH approval-timeout test needs DSH_ROOT (built CLI) and DEEPSEEK_API_KEY'
      : false,
  timeout: 240_000,
};

/** Short enough for a test; the runtime guard must expire later than this. */
const APPROVAL_TIMEOUT_MS = 4_000;
const GUARD_TIMEOUT_MS = 90_000;

interface ObservedEvent {
  readonly atMs: number;
  readonly type: string;
  readonly detail: string;
}

/**
 * Sanitized event description. No prompt, output, summary body or token is
 * ever recorded: only shapes, states and option kinds.
 */
function describe(event: WorkspaceEvent): string {
  switch (event.type) {
    case 'execution/approval-requested':
      return (
        `options=${event.request.options.map((option) => option.kind).join('|')} ` +
        `summaryLength=${String(event.request.summary.length)}`
      );
    case 'execution/approval-decided':
      return `kind=${event.kind}`;
    case 'execution/state':
      return (
        `state=${event.state} ` +
        `stopReason=${event.stopReason ?? 'none'} ` +
        `error=${event.error === undefined ? 'none' : 'present'}`
      );
    case 'execution/output':
      return `channel=${event.channel} textLength=${String(event.text.length)}`;
    case 'execution/tool':
      return `status=${event.status} titleLength=${String(event.title.length)}`;
    case 'adapter/error':
      return 'message=omitted';
    default:
      return 'detail=none';
  }
}

function liveDefinition(liveId: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: liveId,
    nodes: {
      only: { kind: 'forager', config: { connection: 'dsh', prompt: 'run {{input}}' } },
    },
    edges: [],
  };
}

function assertApprovalTimeoutSequence(
  observed: readonly ObservedEvent[],
  sequence: string,
): void {
  const requestedIndex = observed.findIndex(
    (event) => event.type === 'execution/approval-requested',
  );
  const decidedIndex = observed.findIndex(
    (event, index) =>
      index > requestedIndex &&
      event.type === 'execution/approval-decided' &&
      event.detail === 'kind=cancelled',
  );
  const cancelledIndex = observed.findIndex(
    (event, index) =>
      index > decidedIndex &&
      event.type === 'execution/state' &&
      event.detail.startsWith('state=cancelled'),
  );
  assert.ok(requestedIndex >= 0, `no approval request observed: ${sequence}`);
  assert.ok(decidedIndex > requestedIndex, `no cancelled decision observed: ${sequence}`);
  assert.ok(cancelledIndex > decidedIndex, `no cancelled execution observed: ${sequence}`);
  const requestedAt = observed[requestedIndex]?.atMs ?? 0;
  const decidedAt = observed[decidedIndex]?.atMs ?? 0;
  assert.ok(
    decidedAt - requestedAt >= APPROVAL_TIMEOUT_MS - 50,
    `approval was not decided by the workspace timeout: ${sequence}`,
  );
}

test(
  'real DSH undecided approval cancels its run',
  integrationOptions,
  async (t) => {
    assert.ok(dshRoot !== undefined, 'DSH_ROOT is missing');
    const liveId = `m13b-approval-timeout-${String(Date.now())}`;
    const startedAt = Date.now();
    const observed: ObservedEvent[] = [];
    const controlLogs: string[] = [];
    let executionId: string | undefined;

    const adapter = new DshAcpAdapter({
      dshRoot,
      env: { DSH_PERMISSION_MODE: 'read-only' },
    });
    await adapter.start();
    const workspace = new Workspace(adapter, { approvalTimeoutMs: APPROVAL_TIMEOUT_MS });
    const project: Project = {
      id: `m13b-approval-timeout-${String(Date.now())}`,
      directory: mkdtempSync(join(tmpdir(), 'wax-m13b-approval-timeout-')),
    };
    const registry = new SessionRegistry({
      workspaces: new Map([['dsh', workspace]]),
    });
    const stateRoot = mkdtempSync(join(tmpdir(), 'wax-m13b-approval-timeout-state-'));
    const server = new ControlServer({
      registry,
      stateRoot,
      apiary: 'apiary',
      daemonDir: join(stateRoot, 'waxd'),
      liveProject: project,
      guardTimeoutMs: GUARD_TIMEOUT_MS,
      logger: (line) => controlLogs.push(line),
    });
    const unsubscribe = workspace.onEvent((event) => {
      if (event.type === 'execution/approval-requested') {
        executionId = event.executionId;
      }
      observed.push({
        atMs: Date.now() - startedAt,
        type: event.type,
        detail: describe(event),
      });
    });
    t.after(async () => {
      unsubscribe();
      await server.stop().catch(() => undefined);
      await workspace.stop().catch(() => undefined);
    });

    const info = await server.start();
    const token = readFileSync(info.tokenPath, 'utf8').trim();

    const loaded = await bLoad(info.url, token, {
      definition: liveDefinition(liveId),
      bindings: { only: { kind: 'fresh', harness: 'dsh' } },
      project,
    });
    assert.equal(loaded.status, 200);

    const marker = `M13B-TIMEOUT-${String(Date.now())}`;
    const fileName = 'm13b-approval-timeout.txt';
    const wakeStartedAt = Date.now();
    const wake = await bWake(
      info.url,
      token,
      liveId,
      'only',
      `Use the shell tool to create a file named ${fileName} in the current directory ` +
        `with the exact content ${marker}. Report done. Do not use any other directory.`,
    );
    const wakeElapsedMs = Date.now() - wakeStartedAt;
    const sequence = observed
      .map((event) => `${String(event.atMs)}ms ${event.type} (${event.detail})`)
      .join(' -> ');

    assert.equal(wake.status, 202, `${wake.text}\nruntime: ${sequence}`);
    assert.equal(wake.body?.['ok'], true);
    assert.equal(wake.body?.['status'], 'accepted');
    assert.equal(wake.text.includes(marker), false, 'wake response leaked the prompt marker');
    assert.equal(wake.text.includes(token), false, 'wake response leaked the token');
    assert.ok(wakeElapsedMs < 30_000, `wake admission hung for ${String(wakeElapsedMs)}ms`);
    // The approval timeout is an asynchronous run outcome now.
    const finished = await waitForRunTerminal(
      info.url,
      token,
      liveId,
      admissionRunId(wake.body),
      180_000,
    );
    assert.equal(finished.status, 200, finished.text);
    assert.equal(finished.body?.['run']?.['state'], 'cancelled');
    assert.equal(finished.text.includes(marker), false, 'run response leaked the prompt marker');
    assert.equal(finished.text.includes(token), false, 'run response leaked the token');
    assert.equal(existsSync(join(project.directory, fileName)), false);

    // The Workspace's own approval timer is the initiator, so the execution
    // record carries that provenance instead of looking like a bare cancel.
    assert.ok(executionId !== undefined, 'expected a native approval request');
    const execution = workspace.getExecution(executionId);
    assert.ok(execution !== undefined);
    assert.equal(execution.state, 'cancelled');
    assert.equal(execution.cancelReason, 'approval-timeout');
    assert.equal(execution.error, undefined);

    assertApprovalTimeoutSequence(observed, sequence);

    const wakeLine = controlLogs.find(
      (line) => line.includes('path=/lives/wake') && line.includes('status=202'),
    );
    assert.ok(wakeLine !== undefined, `no 202 wake log line: ${controlLogs.join(' | ')}`);
    assert.match(wakeLine, / code=ok$/);
    assert.equal(controlLogs.some((line) => line.includes('status=500')), false);
    for (const line of controlLogs) {
      assert.equal(line.includes(marker), false);
      assert.equal(line.includes(token), false);
    }

    t.diagnostic(
      `observed: approvalTimeoutMs=${String(APPROVAL_TIMEOUT_MS)} ` +
        `wakeStatus=${String(wake.status)} runState=${String(finished.body?.['run']?.['state'])} ` +
        `wakeElapsedMs=${String(wakeElapsedMs)} executionState=${execution.state} ` +
        `cancelReason=${String(execution.cancelReason)} executionError=none; ` +
        `sequence=${sequence}`,
    );
  },
);
