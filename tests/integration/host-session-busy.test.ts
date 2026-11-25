import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { DshAcpAdapter } from '../../src/adapters/dsh-acp/adapter.js';
import type { HarnessEvent } from '../../src/adapters/harness.js';
import { ControlServer } from '../../src/control/server.js';
import type { Project } from '../../src/project/kernel.js';
import { SessionRegistry } from '../../src/session/session-registry.js';
import { Workspace } from '../../src/session/workspace.js';
import { fromCompositionDefinition } from '../../src/b/live-hive-codec.js';
import type { GraphBindings } from '../../src/graph/binding.js';
import { parseComposition } from '../../src/runtime/index.js';
import {
  admissionRunId,
  waitForRunTerminalWith,
  type RunApiCall,
} from '../support/control-server-http.js';

const dshRoot = process.env.DSH_ROOT;
const builtCli =
  dshRoot === undefined ? undefined : join(dshRoot, 'apps', 'cli', 'lib', 'bin.js');
const hasKey =
  process.env.DEEPSEEK_API_KEY !== undefined &&
  process.env.DEEPSEEK_API_KEY.trim() !== '';
const integrationOptions = {
  skip:
    dshRoot === undefined || builtCli === undefined || !existsSync(builtCli) || !hasKey
      ? 'Real shared-session admission test needs DSH_ROOT (built CLI) and DEEPSEEK_API_KEY'
      : false,
  timeout: 300_000,
};

// An unknown-answer constraint: the test never knows which integer the model
// will pick, it only proves that the three runs produced valid, distinct runs.
const RANDOM_INTEGER_PROMPT =
  'Pick a random integer from 100 through 999. ' +
  'Do not use any tools. Reply with only the integer.';

function definition(id: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id,
    nodes: {
      only: {
        kind: 'forager',
        config: { connection: 'dsh', prompt: RANDOM_INTEGER_PROMPT },
      },
    },
    edges: [],
  };
}

interface HttpResult {
  readonly status: number;
  readonly body: Record<string, any>;
}
async function waitForThreeRuns(
  request: RunApiCall,
  runIds: readonly string[],
): Promise<void> {
  await Promise.all(
    runIds.map((runId, index) =>
      waitForRunTerminalWith(request, ['first', 'second', 'third'][index]!, runId, 240_000),
    ),
  );
}

test(
  'real DSH: three loaded LiveHives share one session; wakes wait in the adapter FIFO',
  integrationOptions,
  async (t) => {
    if (dshRoot === undefined) {
      throw new Error('DSH_ROOT is missing');
    }
    const adapter = new DshAcpAdapter({ dshRoot });
    const adapterEvents: HarnessEvent[] = [];
    adapter.onEvent((event) => {
      adapterEvents.push(event);
    });
    await adapter.start();
    const workspace = new Workspace(adapter);
    const registry = new SessionRegistry({
      workspaces: new Map([['dsh', workspace]]),
    });
    const project: Project = {
      id: 'project-real-session-admission',
      directory: mkdtempSync(join(tmpdir(), 'wax-m17j-real-project-')),
    };
    const session = await registry.create(project);
    const stateRoot = mkdtempSync(join(tmpdir(), 'wax-m17j-real-state-'));
    const server = new ControlServer({
      registry,
      stateRoot,
      apiary: 'apiary',
      daemonDir: join(stateRoot, 'waxd'),
      liveProject: project,
      sessionIdleTtlMs: 0,
    });

    try {
      const info = await server.start();
      const token = readFileSync(info.tokenPath, 'utf8').trim();
      const request = async (
        method: 'GET' | 'POST',
        path: string,
        body?: unknown,
      ): Promise<HttpResult> => {
        const response = await fetch(`${info.url}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(240_000),
        });
        return {
          status: response.status,
          body: (await response.json()) as Record<string, any>,
        };
      };
      const load = (id: string): Promise<HttpResult> => {
        const live = fromCompositionDefinition(
          parseComposition(definition(id)),
          { only: { kind: 'session', sessionId: session.sessionId } } as GraphBindings,
        );
        return request('POST', '/lives', { live, project });
      };

      // All three loaded LiveHives hold the same explicit session; none is busy
      // yet, so every load is accepted.
      assert.equal((await load('first')).status, 200);
      assert.equal((await load('second')).status, 200);
      assert.equal((await load('third')).status, 200);

      const firstWake = request('POST', '/lives/wake', {
        liveId: 'first',
        beeId: 'only',
        input: 'first run',
      });
      // A later assertion failure must not leave this request rejection
      // unhandled while the test tears the server down.
      void firstWake.catch(() => undefined);
      await waitForSessionBusy(request, session.sessionId);

      // With the legacy WAX session queue gone, these requests are admitted by
      // the DSH adapter and stay open until their prompt is sent. There is no
      // queued handle and no second concurrent session/prompt.
      const secondWake = request('POST', '/lives/wake', {
        liveId: 'second',
        beeId: 'only',
        input: 'second run',
      });
      void secondWake.catch(() => undefined);
      const thirdWake = request('POST', '/lives/wake', {
        liveId: 'third',
        beeId: 'only',
        input: 'third run',
      });
      void thirdWake.catch(() => undefined);

      // The removed admission surface must be gone, not a dead route.
      assert.equal((await request('GET', '/queues/anything')).status, 404);

      const secondDone = await secondWake;
      assert.equal(secondDone.status, 202, JSON.stringify(secondDone.body));
      const secondRunId = admissionRunId(secondDone.body);
      const thirdDone = await thirdWake;
      assert.equal(thirdDone.status, 202, JSON.stringify(thirdDone.body));
      const thirdRunId = admissionRunId(thirdDone.body);
      const firstDone = await firstWake;
      assert.equal(firstDone.status, 202, JSON.stringify(firstDone.body));
      const firstRunId = admissionRunId(firstDone.body);

      // Admission returns immediately; wait for each run's own terminal before
      // reading outputs. The DSH adapter still serializes the three prompts.
      await waitForThreeRuns(request, [firstRunId, secondRunId, thirdRunId]);
      const runIds = new Set([firstRunId, secondRunId, thirdRunId]);
      assert.equal(runIds.size, 3, 'each wake must produce its own run record');
      const texts = await readRunOutputs(request, {
        first: firstRunId,
        second: secondRunId,
        third: thirdRunId,
      });

      // Serialization evidence: the adapter's own event stream proves that the
      // next execution started only after the previous one reached terminal.
      // Run-record timestamps are WAX bookkeeping and may overlap the next
      // native prompt by a short graph-flush window, so they are not used here.
      assertAdapterSerialized(adapterEvents);

      // A run id belongs to exactly one LiveHive.
      const crossed = await request(
        'GET',
        `/lives/first/output?runId=${encodeURIComponent(thirdRunId)}`,
      );
      assert.equal(crossed.status, 404);

      for (const liveId of ['first', 'second', 'third']) {
        assert.equal(
          (await request('POST', '/lives/unload', { liveId })).status,
          200,
        );
      }

      t.diagnostic(
        `observed: shared session admitted three wakes FIFO; ` +
          `first=${texts.first} (run ${firstRunId.slice(0, 8)}), ` +
          `second=${texts.second} (run ${secondRunId.slice(0, 8)}), ` +
          `third=${texts.third} (run ${thirdRunId.slice(0, 8)})`,
      );
    } finally {
      await server.stop().catch(() => undefined);
      await workspace.stop().catch(() => undefined);
    }
  },
);

async function readRunOutputs(
  request: (method: 'GET' | 'POST', path: string) => Promise<HttpResult>,
  runIds: { readonly first: string; readonly second: string; readonly third: string },
): Promise<{ readonly first: string; readonly second: string; readonly third: string }> {
  const first = await request('GET', `/lives/first/output?runId=${encodeURIComponent(runIds.first)}`);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const firstText = outputText(first.body);
  assert.match(firstText, /^\d{3}$/, `first output: ${firstText}`);
  const firstNumber = Number(firstText);
  assert.ok(firstNumber >= 100 && firstNumber <= 999);

  const second = await request('GET', `/lives/second/output?runId=${encodeURIComponent(runIds.second)}`);
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body['liveId'], 'second');
  const secondText = outputText(second.body);
  assert.match(secondText, /^\d{3}$/, `second output: ${secondText}`);
  const secondNumber = Number(secondText);
  assert.ok(secondNumber >= 100 && secondNumber <= 999);

  const third = await request('GET', `/lives/third/output?runId=${encodeURIComponent(runIds.third)}`);
  assert.equal(third.status, 200, JSON.stringify(third.body));
  assert.equal(third.body['liveId'], 'third');
  const thirdText = outputText(third.body);
  assert.match(thirdText, /^\d{3}$/, `third output: ${thirdText}`);
  const thirdNumber = Number(thirdText);
  assert.ok(thirdNumber >= 100 && thirdNumber <= 999);

  return { first: firstText, second: secondText, third: thirdText };
}

function assertAdapterSerialized(events: readonly HarnessEvent[]): void {
  const started = events
    .filter((event): event is Extract<HarnessEvent, { type: 'execution/started' }> =>
      event.type === 'execution/started')
    .map((event) => event.executionId);
  const terminal = events
    .filter((event) =>
      event.type === 'execution/completed' ||
      event.type === 'execution/failed' ||
      event.type === 'execution/cancelled' ||
      event.type === 'execution/unknown')
    .map((event) => event.executionId);
  assert.equal(started.length, 3, 'adapter did not start exactly three executions');
  assert.equal(terminal.length, 3, 'adapter did not settle exactly three executions');
  const eventIndex = (type: 'execution/started', executionId: string): number =>
    events.findIndex((event) => event.type === type && event.executionId === executionId);
  const terminalIndex = (executionId: string): number =>
    events.findIndex((event) =>
      (event.type === 'execution/completed' ||
        event.type === 'execution/failed' ||
        event.type === 'execution/cancelled' ||
        event.type === 'execution/unknown') &&
      event.executionId === executionId);
  for (let index = 1; index < started.length; index += 1) {
    const previous = started[index - 1];
    const current = started[index];
    assert.ok(previous !== undefined && current !== undefined);
    assert.ok(
      terminalIndex(previous) < eventIndex('execution/started', current),
      `execution ${current} started before ${previous} reached terminal`,
    );
  }
}

function outputText(body: Record<string, any>): string {  const entries = body['outputs'] as Record<string, unknown>[] | undefined;
  const value = entries?.[0]?.['value'] as Record<string, unknown> | undefined;
  const text = typeof value?.['text'] === 'string' ? value['text'].trim() : '';
  assert.ok(text.length > 0, 'run record has no forager output text');
  return text;
}

async function waitForSessionBusy(
  request: (method: 'GET' | 'POST', path: string, body?: unknown) => Promise<HttpResult>,
  sessionId: string,
): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const listed = await request('GET', '/sessions');
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    const entry = (listed.body['sessions'] as Record<string, any>[] | undefined)?.find(
      (candidate) => candidate['sessionId'] === sessionId,
    );
    if (entry?.['busy'] === true) {
      return;
    }
    await delay(25);
  }
  assert.fail('the first real DSH execution never reported the session busy');
}
