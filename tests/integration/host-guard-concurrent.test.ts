import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import { DshAcpAdapter } from '../../src/adapters/dsh-acp/adapter.js';
import { ControlServer } from '../../src/control/server.js';
import type { Project } from '../../src/project/kernel.js';
import { SessionRegistry } from '../../src/session/session-registry.js';
import { Workspace } from '../../src/session/workspace.js';
import {
  autoDecideGuards,
  bLoadLive,
  bTrigger,
  getJson,
  type GuardAutoDecider,
  liveFrom,
  postJson,
  waitForRest,
} from '../support/control-server-http.js';

const dshRoot = process.env.DSH_ROOT;
const builtCli =
  dshRoot === undefined ? undefined : join(dshRoot, 'apps', 'cli', 'lib', 'bin.js');
const hasKey =
  process.env.OPENCODE_API_KEY !== undefined &&
  process.env.OPENCODE_API_KEY.trim() !== '';
const integrationOptions = {
  skip:
    dshRoot === undefined || builtCli === undefined || !existsSync(builtCli) || !hasKey
      ? 'Real concurrent guard test needs DSH_ROOT (built CLI) and OPENCODE_API_KEY'
      : false,
  timeout: 300_000,
};

function definition(id: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id,
    nodes: {
      only: {
        kind: 'forager',
        config: { connection: 'dsh', prompt: 'run {{message}}' },
      },
    },
    edges: [],
  };
}

function writePrompt(fileName: string, marker: string): string {
  return (
    `Use the shell tool to create a file named ${fileName} in the current directory ` +
    `with the exact content ${marker}. Report done. Do not use any other directory.`
  );
}

async function waitForGuards(
  url: string,
  token: string,
  count: number,
  timeoutMs: number,
): Promise<Record<string, unknown>[]> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    const listed = await getJson(url, token, '/guards');
    last = listed.body?.['guards'];
    if (listed.status === 200 && Array.isArray(last) && last.length >= count) {
      return last as Record<string, unknown>[];
    }
    await delay(100);
  }
  throw new Error(`timed out waiting for ${String(count)} guards; last=${JSON.stringify(last)}`);
}

function selectGuards(
  guards: readonly Record<string, unknown>[],
  requestDirectory: ReadonlyMap<string, string>,
  projectA: Project,
  projectB: Project,
): { readonly guardA: Record<string, unknown>; readonly guardB: Record<string, unknown> } {
  const guardA = guards.find(
    (guard) => requestDirectory.get(String(guard['requestId'])) === projectA.directory,
  );
  const guardB = guards.find(
    (guard) => requestDirectory.get(String(guard['requestId'])) === projectB.directory,
  );
  assert.ok(guardA !== undefined, 'guard for session A must be pending');
  assert.ok(guardB !== undefined, 'guard for session B must be pending');
  return { guardA, guardB };
}

async function decideBothGuards(
  url: string,
  token: string,
  guardA: Record<string, unknown>,
  guardB: Record<string, unknown>,
): Promise<void> {
  const allowed = await postJson(url, token, '/guard/decide', {
    requestId: guardA['requestId'],
    decision: 'allow_once',
  });
  assert.equal(allowed.status, 200);
  const rejected = await postJson(url, token, '/guard/decide', {
    requestId: guardB['requestId'],
    decision: 'reject_once',
  });
  assert.equal(rejected.status, 200);
}

test(
  'real DSH concurrent sessions keep guard ids distinct and decisions per session',
  integrationOptions,
  async (t) => {
    if (dshRoot === undefined) {
      throw new Error('DSH_ROOT is missing');
    }
    // Two independent DSH ACP processes are the worst case for the broker's
    // global requestId keys: each process starts its native request counter at
    // 0, so both sessions ask for approval with native id 0 at the same time.
    const adapterA = new DshAcpAdapter({
      dshRoot,
      env: { DSH_PERMISSION_MODE: 'read-only' },
    });
    const adapterB = new DshAcpAdapter({
      dshRoot,
      env: { DSH_PERMISSION_MODE: 'read-only' },
    });
    await adapterA.start();
    try {
      await adapterB.start();
    } catch (error) {
      await adapterA.stop().catch(() => undefined);
      throw error;
    }
    const workspaceA = new Workspace(adapterA);
    const workspaceB = new Workspace(adapterB);
    const projectA: Project = {
      id: 'project-concurrent-a',
      directory: mkdtempSync(join(tmpdir(), 'wax-m12a2-concurrent-a-')),
    };
    const projectB: Project = {
      id: 'project-concurrent-b',
      directory: mkdtempSync(join(tmpdir(), 'wax-m12a2-concurrent-b-')),
    };
    const registry = new SessionRegistry({
      workspaces: new Map([
        ['dsh-a', workspaceA],
        ['dsh-b', workspaceB],
      ]),
    });
    const stateRoot = mkdtempSync(join(tmpdir(), 'wax-m12a2-concurrent-state-'));
    const controlLogs: string[] = [];
    const server = new ControlServer({
      registry,
      stateRoot,
      apiary: 'apiary',
      daemonDir: join(stateRoot, 'waxd'),
      liveProject: projectA,
      guardTimeoutMs: 120_000,
      logger: (line) => controlLogs.push(line),
    });
    const requestDirectory = new Map<string, string>();
    const workspaceLogs: string[] = [];
    const subscriptions = [workspaceA, workspaceB].map((workspace) =>
      workspace.onEvent((event) => {
        if (event.type === 'execution/state') {
          const execution = workspace.getExecution(event.executionId);
          const conversation =
            execution === undefined
              ? undefined
              : workspace.getConversation(execution.conversationId);
          workspaceLogs.push(
            `execution state=${event.state} id=${event.executionId}` +
              ` directory=${conversation?.project.directory ?? 'unknown'}` +
              (event.error === undefined ? '' : ` error=${event.error}`),
          );
          return;
        }
        if (event.type === 'execution/approval-decided') {
          workspaceLogs.push(
            `approval decided requestId=${event.requestId} exec=${event.executionId} ` +
              `kind=${event.kind}`,
          );
          return;
        }
        if (event.type !== 'execution/approval-requested') {
          return;
        }
        const execution = workspace.getExecution(event.executionId);
        const conversation =
          execution === undefined
            ? undefined
            : workspace.getConversation(execution.conversationId);
        workspaceLogs.push(
          `approval requested requestId=${event.request.requestId} ` +
            `exec=${event.executionId} directory=${conversation?.project.directory ?? 'unknown'}`,
        );
        if (conversation !== undefined) {
          requestDirectory.set(event.request.requestId, conversation.project.directory);
        }
      }),
    );
    let autoDecider: GuardAutoDecider | undefined;
    try {
      const info = await server.start();
      const token = readFileSync(info.tokenPath, 'utf8').trim();
      const sessionsStartedAt = Date.now();
      const sessionA = await registry.create(projectA, { harness: 'dsh-a' });
      const sessionB = await registry.create(projectB, { harness: 'dsh-b' });
      t.diagnostic(`sessions created in ${String(Date.now() - sessionsStartedAt)}ms`);
      const lives = [
        ['concurrent-a', sessionA.sessionId],
        ['concurrent-b', sessionB.sessionId],
      ] as const;
      for (const [liveId, sessionId] of lives) {
        const loadStartedAt = Date.now();
        const loaded = await bLoadLive(
          info.url,
          token,
          liveFrom(
            definition(liveId),
            { only: { kind: 'session', sessionId } },
            liveId,
          ),
        );
        t.diagnostic(
          `load ${liveId} status=${String(loaded.status)} ` +
            `ms=${String(Date.now() - loadStartedAt)}`,
        );
        assert.equal(
          loaded.status,
          200,
          `${loaded.text}\ncontrol logs:\n${controlLogs.join('\n')}`,
        );
      }
      const markerA = `CONCURRENT-A-${String(Date.now())}`;
      const markerB = `CONCURRENT-B-${String(Date.now())}`;
      const wakeA = bTrigger(
        info.url,
        token,
        'concurrent-a',
        'only',
        writePrompt('marker-a.txt', markerA),
      );
      const wakeB = bTrigger(
        info.url,
        token,
        'concurrent-b',
        'only',
        writePrompt('marker-b.txt', markerB),
      );
      // Cleanup closes the server while an undecided wake may still be in
      // flight; keep that transport rejection from masking the real assertion.
      void wakeA.catch(() => undefined);
      void wakeB.catch(() => undefined);
      const guards = await waitForGuards(info.url, token, 2, 60_000);
      assert.equal(guards.length, 2);
      const requestIds = guards.map((guard) => String(guard['requestId']));
      assert.equal(new Set(requestIds).size, 2, 'concurrent guards must have distinct requestIds');

      const { guardA, guardB } = selectGuards(
        guards,
        requestDirectory,
        projectA,
        projectB,
      );
      assert.notEqual(guardA['requestId'], guardB['requestId']);
      autoDecider = autoDecideGuards(
        info.url,
        token,
        [String(guardA['requestId']), String(guardB['requestId'])],
        (requestId) =>
          requestDirectory.get(requestId) === projectA.directory
            ? 'allow_once'
            : 'reject_once',
        (requestId, decision) => {
          workspaceLogs.push(
            `extra approval decided requestId=${requestId} decision=${decision}`,
          );
        },
      );

      const listed = await getJson(info.url, token, '/guards');
      assert.equal(JSON.stringify(listed.body).includes(markerA), false);
      assert.equal(JSON.stringify(listed.body).includes(markerB), false);

      await decideBothGuards(info.url, token, guardA, guardB);

      const [wakeAResult, wakeBResult] = await Promise.all([wakeA, wakeB]);
      t.diagnostic(
        `wake statuses A=${String(wakeAResult.status)} B=${String(wakeBResult.status)}`,
      );
      const failureDetail =
        `\ncontrol logs:\n${controlLogs.join('\n')}\nworkspace logs:\n${workspaceLogs.join('\n')}`;
      assert.equal(wakeAResult.status, 202, `${wakeAResult.text}${failureDetail}`);
      assert.equal(wakeBResult.status, 202, `${wakeBResult.text}${failureDetail}`);
      await Promise.all([
        waitForRest(
          info.url,
          token,
          'concurrent-a',
          180_000,
          false,
        ),
        waitForRest(
          info.url,
          token,
          'concurrent-b',
          180_000,
          false,
        ),
      ]);

      assert.equal(
        readFileSync(join(projectA.directory, 'marker-a.txt'), 'utf8'),
        markerA,
      );
      assert.equal(existsSync(join(projectB.directory, 'marker-b.txt')), false);
      assert.equal((await getJson(info.url, token, '/guards')).body?.['guards']?.length, 0);

      const nativeId = (requestId: string): string =>
        requestId.slice(requestId.lastIndexOf(':') + 1);
      t.diagnostic(
        `observed: requestIds=${requestIds.join(',')} ` +
          `nativeIds=${requestIds.map(nativeId).join(',')} ` +
          `allowed=${String(guardA['requestId'])} rejected=${String(guardB['requestId'])} ` +
          `markerA=present markerB=absent`,
      );
    } finally {
      for (const unsubscribe of subscriptions) {
        unsubscribe();
      }
      await autoDecider?.stop();
      await server.stop().catch(() => undefined);
      await workspaceA.stop().catch(() => undefined);
      await workspaceB.stop().catch(() => undefined);
    }
  },
);
