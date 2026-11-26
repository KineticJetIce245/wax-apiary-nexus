import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { Project } from '../../src/project/kernel.js';
import {
  catalogOnDisk,
  dshIntegrationOptions,
  liveFor,
  numberPrompt,
  readJson,
  readToken,
  request,
  requestOutcome,
  shellWritePrompt,
  startInProcessDaemon,
  status500,
  stopInProcessDaemon,
  textOf,
  waitFor,
  waitForRest,
  withTimeout,
  type HttpResult,
  type InProcessDaemon,
  type RequestOutcome,
} from '../support/dsh-daemon-harness.js';

// A shell write must ask the native harness, so the daemon has a real pending
// approval to stop on. Node runs every test file in its own process.
process.env.DSH_PERMISSION_MODE = 'read-only';

async function triggerAndWait(
  url: string,
  token: string,
  liveId: string,
  input: string,
): Promise<HttpResult> {
  const trigger = await request(url, token, 'POST', '/lives/trigger', {
    liveId,
    beeId: 'only',
    input,
  });
  assert.equal(trigger.status, 202, JSON.stringify(trigger.body));
  assert.equal(trigger.body['ok'], true);
  assert.equal(trigger.body['runId'], undefined);
  assert.equal(trigger.body['traceId'], undefined);
  await waitForRest(url, token, liveId);
  return trigger;
}

function fieldSnapshot(stateRoot: string, liveId: string): Record<string, any> {
  // Honey layout (apiaries/<apiary>/compositions/<id>) is the known A23/C05
  // gap; this test reads it to prove field recovery, not the target path.
  return readJson(
    join(stateRoot, 'apiaries', 'apiary', 'compositions', liveId, 'honey', 'field.json'),
  );
}

function outputText(body: Record<string, any>): string {
  const entries = body['outputs'] as Record<string, unknown>[];
  return textOf(entries[0]?.['value']).trim();
}

test(
  'real DSH daemon stops with a pending guard and restarts on the same state',
  dshIntegrationOptions,
  async (t) => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'wax-m12b-graceful-state-'));
    const daemonDir = join(stateRoot, 'waxd');
    const runsDirectory = join(daemonDir, 'runs');
    const project: Project = {
      id: 'project-m12b-graceful',
      directory: mkdtempSync(join(tmpdir(), 'wax-m12b-graceful-project-')),
    };
    const liveId = 'm12b-graceful';
    const livePath = join(stateRoot, 'lives', liveId, 'live.json');
    const marker = `M12B-PENDING-${String(Date.now())}`;
    const markerFile = 'pending-wake-m12b.txt';

    let first: InProcessDaemon | undefined;
    let second: InProcessDaemon | undefined;
    let inFlight: Promise<RequestOutcome> | undefined;
    let firstToken = '';

    try {
      first = await startInProcessDaemon(stateRoot, daemonDir);
      firstToken = readToken(first.info.tokenPath);
      assert.equal(firstToken.length, 64);
      assert.equal(existsSync(first.info.tokenPath), true);
      assert.equal(existsSync(join(daemonDir, 'server.json')), true);
      assert.equal(existsSync(runsDirectory), false, 'startup created a runs/ directory');

      const loaded = await request(first.info.url, firstToken, 'POST', '/lives', {
        live: liveFor(liveId),
        project,
      });
      assert.equal(loaded.status, 200, JSON.stringify(loaded.body));
      assert.equal(loaded.body['liveId'], liveId);
      assert.equal(existsSync(livePath), true);

      // One completed real delivery, then a save: the durable Honey snapshot
      // exists before shutdown, so the restart has field state to restore.
      await triggerAndWait(first.info.url, firstToken, liveId, numberPrompt(100, 999));

      const output = await request(
        first.info.url,
        firstToken,
        'GET',
        `/lives/${liveId}/output`,
      );
      assert.equal(output.status, 200);
      assert.equal(output.body['runId'], undefined);
      assert.equal(output.body['traceId'], undefined);
      const firstOutputs = output.body['outputs'] as Record<string, unknown>[];
      assert.equal(firstOutputs.length, 1);
      assert.ok(
        /^\d{3}$/.test(outputText(output.body)),
        'first trigger output must be a three-digit integer (value not recorded)',
      );

      const saved = await request(first.info.url, firstToken, 'POST', '/lives/save', {
        liveId,
      });
      assert.equal(saved.status, 200);
      const persistedBeforeStop = readJson(livePath);
      assert.equal(persistedBeforeStop['liveId'], liveId);
      assert.equal(typeof persistedBeforeStop['bindings']?.['only'], 'string');
      const honeyBeforeStop = fieldSnapshot(stateRoot, liveId);
      assert.equal(honeyBeforeStop['rest'], true);
      assert.equal(JSON.stringify(honeyBeforeStop).includes('runId'), false);
      assert.equal(JSON.stringify(honeyBeforeStop).includes('traceId'), false);

      // Park the daemon on a real native approval. The delivery already ended;
      // the field stays active until a decision or timeout.
      inFlight = requestOutcome(
        first.info.url,
        firstToken,
        'POST',
        '/lives/trigger',
        {
          liveId,
          beeId: 'only',
          input: shellWritePrompt(markerFile, marker),
        },
      );
      const guard = await waitFor(async () => {
        const listed = await request(first!.info.url, firstToken, 'GET', '/guards');
        if (listed.status !== 200) {
          return undefined;
        }
        const guards = listed.body['guards'] as Record<string, unknown>[];
        return guards.length === 1 ? guards[0] : undefined;
      }, 120_000, 'pending native guard');
      assert.equal(typeof guard?.['requestId'], 'string');
      const guardList = await request(first.info.url, firstToken, 'GET', '/guards');
      assert.equal(JSON.stringify(guardList.body).includes(marker), false);
      assert.equal(existsSync(join(project.directory, markerFile)), false);

      assert.equal(existsSync(first.info.tokenPath), true);
      assert.equal(existsSync(join(daemonDir, 'server.json')), true);
      assert.equal(existsSync(join(daemonDir, 'daemon.lock')), true);

      const firstLogs = [...first.logs];
      const firstStderr = [...first.stderr];
      const firstStdout = [...first.stdout];
      const triggerPromise = inFlight;
      assert.ok(triggerPromise !== undefined);
      const stopped = await stopInProcessDaemon(first);
      first = undefined;
      const settled = await withTimeout(triggerPromise, 30_000, 'in-flight delivery settlement');
      inFlight = undefined;

      assert.equal(stopped.code, 0);
      assert.ok(
        stopped.elapsedMs < 30_000,
        `shutdown took ${String(stopped.elapsedMs)}ms`,
      );
      assert.equal(settled.kind === 'response' && settled.status === 500, false);
      assert.deepEqual(status500(firstLogs), []);

      assert.equal(existsSync(join(daemonDir, 'token')), false);
      assert.equal(existsSync(join(daemonDir, 'server.json')), false);
      assert.equal(existsSync(join(daemonDir, 'daemon.lock')), false);
      assert.deepEqual(firstStderr, []);
      assert.equal(
        firstStdout.filter((line) => line.startsWith('waxd listening ')).length,
        1,
      );

      assert.equal(existsSync(livePath), true);
      assert.equal(readJson(livePath)['liveId'], liveId);
      assert.equal(existsSync(runsDirectory), false, 'a runs/ record was written');
      // The graph was busy at shutdown, so dispose could not unload it. That is
      // the hard restart case: the persisted catalog still says loaded.
      assert.equal(catalogOnDisk(daemonDir)[liveId]?.['state'], 'loaded');
      const honeyAfterStop = fieldSnapshot(stateRoot, liveId);
      assert.equal(honeyAfterStop['rest'], true);
      t.diagnostic(
        `graceful stop: exit=0 elapsedMs=${String(stopped.elapsedMs)} ` +
          `wakeOutcome=${settled.kind} cleanToken=true cleanServerJson=true ` +
          `wake500=false runsDir=false honeyRest=true`,
      );

      // Restart on exactly the same stateRoot/daemonDir. Startup must reconcile
      // the previous daemon's loaded claim: no graph is in memory here.
      second = await startInProcessDaemon(stateRoot, daemonDir);
      const secondToken = readToken(second.info.tokenPath);
      assert.notEqual(secondToken, firstToken);
      assert.equal(readJson(join(daemonDir, 'server.json'))['pid'], process.pid);
      assert.equal(readJson(join(daemonDir, 'daemon.lock'))['pid'], process.pid);

      const health = await request(second.info.url, secondToken, 'GET', '/health');
      assert.equal(health.status, 200);
      const catalog = await request(second.info.url, secondToken, 'GET', '/lives');
      assert.equal(catalog.status, 200);
      const entry = (catalog.body['lives'] as Record<string, unknown>[]).find(
        (item) => item['liveId'] === liveId,
      );
      assert.ok(entry !== undefined, 'restart must list the durable live identity');
      assert.equal(entry['state'], 'unloaded');
      assert.equal(readJson(join(daemonDir, 'live-catalog.json'))['entries']?.[0]?.['state'],
        'unloaded');

      // D2: there is no run history to read after restart. The field output was
      // memory-only and was not replayed from Honey.
      const staleOutput = await request(
        second.info.url,
        secondToken,
        'GET',
        `/lives/${liveId}/output`,
      );
      assert.equal(staleOutput.status, 404);
      const guardsAfterRestart = await request(second.info.url, secondToken, 'GET', '/guards');
      assert.deepEqual(guardsAfterRestart.body['guards'], []);
      assert.equal(
        existsSync(join(project.directory, markerFile)),
        false,
        'the pending side effect was replayed after restart',
      );

      const reloaded = await request(second.info.url, secondToken, 'POST', '/lives/load', {
        liveId,
        project,
      });
      assert.equal(reloaded.status, 200, JSON.stringify(reloaded.body));
      const inspected = await request(
        second.info.url,
        secondToken,
        'GET',
        `/lives/${liveId}/inspect`,
      );
      assert.equal(inspected.status, 200);
      assert.equal(inspected.body['liveId'], liveId);
      assert.equal(inspected.body['status']?.['rest'], true);
      assert.deepEqual(inspected.body['outputs'], []);

      await triggerAndWait(
        second.info.url,
        secondToken,
        liveId,
        numberPrompt(1000, 9999),
      );
      const secondOutput = await request(
        second.info.url,
        secondToken,
        'GET',
        `/lives/${liveId}/output`,
      );
      assert.equal(secondOutput.status, 200);
      assert.equal(secondOutput.body['runId'], undefined);
      assert.ok(
        /^\d{4}$/.test(outputText(secondOutput.body)),
        'post-restart output must be a four-digit integer (value not recorded)',
      );
      assert.equal((await request(second.info.url, secondToken, 'POST', '/lives/save', {
        liveId,
      })).status, 200);

      t.diagnostic(
        `restart: catalogState=${String(entry['state'])} ` +
          `liveReloaded=${String(reloaded.status)} restAfterReload=true ` +
          `staleOutput=${String(staleOutput.status)} noReplay=true`,
      );

      const secondStopped = await stopInProcessDaemon(second);
      second = undefined;
      assert.equal(secondStopped.code, 0);
      assert.equal(existsSync(join(daemonDir, 'token')), false);
      assert.equal(existsSync(join(daemonDir, 'server.json')), false);
      assert.equal(existsSync(join(daemonDir, 'daemon.lock')), false);
      t.diagnostic(
        `second graceful stop: exit=0 elapsedMs=${String(secondStopped.elapsedMs)}`,
      );
    } finally {
      inFlight?.catch(() => undefined);
      if (first !== undefined) {
        await stopInProcessDaemon(first).catch(() => undefined);
      }
      if (second !== undefined) {
        await stopInProcessDaemon(second).catch(() => undefined);
      }
    }
  },
);
