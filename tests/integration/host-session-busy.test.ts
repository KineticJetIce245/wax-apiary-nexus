import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { DshAcpAdapter } from '../../src/adapters/dsh-acp/adapter.js';
import { ControlServer } from '../../src/control/server.js';
import type { Project } from '../../src/project/kernel.js';
import { SessionRegistry } from '../../src/session/session-registry.js';
import { Workspace } from '../../src/session/workspace.js';
import { fromCompositionDefinition } from '../../src/b/live-hive-codec.js';
import type { GraphBindings } from '../../src/graph/binding.js';
import { parseComposition } from '../../src/runtime/index.js';

const dshRoot = process.env.DSH_ROOT;
const builtCli =
  dshRoot === undefined ? undefined : join(dshRoot, 'apps', 'cli', 'lib', 'bin.js');
const hasKey =
  process.env.DEEPSEEK_API_KEY !== undefined &&
  process.env.DEEPSEEK_API_KEY.trim() !== '';
const integrationOptions = {
  skip:
    dshRoot === undefined || builtCli === undefined || !existsSync(builtCli) || !hasKey
      ? 'Real shared-session queue test needs DSH_ROOT (built CLI) and DEEPSEEK_API_KEY'
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

test(
  'real DSH: three loaded LiveHives share one session and queue the second and third wake',
  integrationOptions,
  async (t) => {
    if (dshRoot === undefined) {
      throw new Error('DSH_ROOT is missing');
    }
    const adapter = new DshAcpAdapter({ dshRoot });
    await adapter.start();
    const workspace = new Workspace(adapter);
    const registry = new SessionRegistry({
      workspaces: new Map([['dsh', workspace]]),
    });
    const project: Project = {
      id: 'project-real-session-queue',
      directory: mkdtempSync(join(tmpdir(), 'wax-m16b-real-project-')),
    };
    const session = await registry.create(project);
    const stateRoot = mkdtempSync(join(tmpdir(), 'wax-m16b-real-state-'));
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

      const secondQueued = await request('POST', '/lives/wake', {
        liveId: 'second',
        beeId: 'only',
        input: 'second run',
      });
      assert.equal(secondQueued.status, 200, JSON.stringify(secondQueued.body));
      assert.equal(secondQueued.body['ok'], true);
      assert.equal(secondQueued.body['status'], 'queued');
      assert.equal(secondQueued.body['position'], 1);
      const secondQueueId = String(secondQueued.body['queueId']);

      const thirdQueued = await request('POST', '/lives/wake', {
        liveId: 'third',
        beeId: 'only',
        input: 'third run',
      });
      assert.equal(thirdQueued.status, 200, JSON.stringify(thirdQueued.body));
      assert.equal(thirdQueued.body['status'], 'queued');
      assert.equal(thirdQueued.body['position'], 2);
      const thirdQueueId = String(thirdQueued.body['queueId']);

      const firstDone = await firstWake;
      assert.equal(firstDone.status, 200, JSON.stringify(firstDone.body));
      const firstRunId = String(firstDone.body['result']?.['runId']);
      assert.ok(firstRunId.length > 0);

      // Advancing the first run promotes the second and moves the third up to
      // position 1; that position is stable until the second run finishes.
      await waitForQueuePosition(request, thirdQueueId, 1);
      const secondRunning = await queueView(request, secondQueueId);
      assert.equal(secondRunning['status'], 'running');
      assert.equal(secondRunning['liveId'], 'second');
      const thirdWaiting = await queueView(request, thirdQueueId);
      assert.equal(thirdWaiting['status'], 'queued');
      assert.equal(thirdWaiting['position'], 1);

      const secondCompleted = await waitForQueueStatus(request, secondQueueId, 'completed');
      const secondRunId = String(secondCompleted['runId']);
      assert.equal(secondCompleted['liveId'], 'second');
      assert.equal(secondCompleted['sessionId'], session.sessionId);
      assert.notEqual(secondRunId, firstRunId);

      const thirdCompleted = await waitForQueueStatus(request, thirdQueueId, 'completed');
      const thirdRunId = String(thirdCompleted['runId']);
      assert.equal(thirdCompleted['liveId'], 'third');
      assert.equal(thirdCompleted['sessionId'], session.sessionId);
      assert.notEqual(thirdRunId, firstRunId);
      assert.notEqual(thirdRunId, secondRunId);

      const firstOutput = await request(
        'GET',
        `/lives/first/output?runId=${encodeURIComponent(firstRunId)}`,
      );
      assert.equal(firstOutput.status, 200, JSON.stringify(firstOutput.body));
      const firstText = outputText(firstOutput.body);
      assert.match(firstText, /^\d{3}$/, `first output: ${firstText}`);
      const firstNumber = Number(firstText);
      assert.ok(firstNumber >= 100 && firstNumber <= 999);

      const secondOutput = await request(
        'GET',
        `/lives/second/output?runId=${encodeURIComponent(secondRunId)}`,
      );
      assert.equal(secondOutput.status, 200, JSON.stringify(secondOutput.body));
      assert.equal(secondOutput.body['liveId'], 'second');
      const secondText = outputText(secondOutput.body);
      assert.match(secondText, /^\d{3}$/, `second output: ${secondText}`);
      const secondNumber = Number(secondText);
      assert.ok(secondNumber >= 100 && secondNumber <= 999);

      const thirdOutput = await request(
        'GET',
        `/lives/third/output?runId=${encodeURIComponent(thirdRunId)}`,
      );
      assert.equal(thirdOutput.status, 200, JSON.stringify(thirdOutput.body));
      assert.equal(thirdOutput.body['liveId'], 'third');
      const thirdText = outputText(thirdOutput.body);
      assert.match(thirdText, /^\d{3}$/, `third output: ${thirdText}`);
      const thirdNumber = Number(thirdText);
      assert.ok(thirdNumber >= 100 && thirdNumber <= 999);

      // Serialization evidence: each queued run could not start before the run
      // in front of it closed its durable record.
      assert.ok(
        Date.parse(String(secondOutput.body['startedAt'])) >=
          Date.parse(String(firstOutput.body['finishedAt'])),
        'the second run must not start before the first run finished',
      );
      assert.ok(
        Date.parse(String(thirdOutput.body['startedAt'])) >=
          Date.parse(String(secondOutput.body['finishedAt'])),
        'the third run must not start before the second run finished',
      );

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
        `observed: shared session queued two wakes; ` +
          `first=${firstText} (run ${firstRunId.slice(0, 8)}), ` +
          `second=${secondText} (run ${secondRunId.slice(0, 8)}), ` +
          `third=${thirdText} (run ${thirdRunId.slice(0, 8)}), ` +
          `queues=${secondQueueId.slice(0, 8)}/${thirdQueueId.slice(0, 8)}`,
      );
    } finally {
      await server.stop().catch(() => undefined);
      await workspace.stop().catch(() => undefined);
    }
  },
);

function outputText(body: Record<string, any>): string {
  const entries = body['outputs'] as Record<string, unknown>[] | undefined;
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

async function queueView(
  request: (method: 'GET' | 'POST', path: string, body?: unknown) => Promise<HttpResult>,
  queueId: string,
): Promise<Record<string, any>> {
  const queued = await request('GET', `/queues/${encodeURIComponent(queueId)}`);
  assert.equal(queued.status, 200, JSON.stringify(queued.body));
  return queued.body['queue'] as Record<string, any>;
}

async function waitForQueuePosition(
  request: (method: 'GET' | 'POST', path: string, body?: unknown) => Promise<HttpResult>,
  queueId: string,
  position: number,
): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const view = await queueView(request, queueId);
    if (view['status'] === 'queued' && view['position'] === position) {
      return;
    }
    assert.equal(
      view['status'] === 'failed' || view['status'] === 'timeout' || view['status'] === 'dropped',
      false,
      `queued run settled as ${String(view['status'])}`,
    );
    await delay(100);
  }
  assert.fail(`queue item never reached position ${String(position)}`);
}

async function waitForQueueStatus(
  request: (method: 'GET' | 'POST', path: string, body?: unknown) => Promise<HttpResult>,
  queueId: string,
  status: string,
): Promise<Record<string, any>> {
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    const queued = await request('GET', `/queues/${encodeURIComponent(queueId)}`);
    assert.equal(queued.status, 200, JSON.stringify(queued.body));
    const view = queued.body['queue'] as Record<string, any>;
    if (view['status'] === status) {
      return view;
    }
    assert.equal(
      view['status'] === 'failed' || view['status'] === 'timeout' || view['status'] === 'dropped',
      false,
      `queued run settled as ${String(view['status'])}`,
    );
    await delay(250);
  }
  assert.fail(`queue item never reached '${status}'`);
}
