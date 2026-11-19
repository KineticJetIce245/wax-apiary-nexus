import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
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
  withTimeout,
  type InProcessDaemon,
  type RequestOutcome,
} from '../support/dsh-daemon-harness.js';

// A shell write must ask the native harness, so the daemon has a real pending
// approval to stop on. Node runs every test file in its own process.
process.env.DSH_PERMISSION_MODE = 'read-only';

test(
  'real DSH daemon stops with a pending guard and restarts on the same state',
  dshIntegrationOptions,
  async (t) => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'wax-m12b-graceful-state-'));
    const daemonDir = join(stateRoot, 'waxd');
    const project: Project = {
      id: 'project-m12b-graceful',
      directory: mkdtempSync(join(tmpdir(), 'wax-m12b-graceful-project-')),
    };
    const liveId = 'm12b-graceful';
    const livePath = join(stateRoot, 'lives', liveId, 'live.json');
    const runsDirectory = join(daemonDir, 'runs');
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

      const loaded = await request(first.info.url, firstToken, 'POST', '/lives', {
        live: liveFor(liveId),
        project,
      });
      assert.equal(loaded.status, 200, JSON.stringify(loaded.body));
      assert.equal(loaded.body['status']?.['graphId'], liveId);
      assert.equal(existsSync(livePath), true);

      // One completed real run, then a save: it proves the durable state exists
      // before the shutdown, so the restart has something meaningful to recover.
      const firstWake = await request(first.info.url, firstToken, 'POST', '/lives/wake', {
        liveId,
        beeId: 'only',
        input: numberPrompt(100, 999),
      });
      assert.equal(firstWake.status, 200, JSON.stringify(firstWake.body));
      assert.equal(firstWake.body['result']?.['rest'], true);

      const output = await request(
        first.info.url,
        firstToken,
        'GET',
        `/lives/${liveId}/output`,
      );
      assert.equal(output.status, 200);
      assert.equal(output.body['status'], 'completed');
      assert.equal(output.body['operation'], 'trigger');
      assert.equal(typeof output.body['runId'], 'string');
      const firstRunId = String(output.body['runId']);
      const firstOutputs = output.body['outputs'] as Record<string, unknown>[];
      assert.equal(firstOutputs.length, 1);
      assert.ok(
        /^\d{3}$/.test(textOf(firstOutputs[0]?.['value']).trim()),
        'first wake output must be a three-digit integer (value not recorded)',
      );

      const saved = await request(first.info.url, firstToken, 'POST', '/lives/save', {
        liveId,
      });
      assert.equal(saved.status, 200);
      const persistedBeforeStop = readJson(livePath);
      assert.equal(persistedBeforeStop['liveId'], liveId);
      assert.equal(typeof persistedBeforeStop['bindings']?.['only'], 'string');

      // Park the daemon on a real native approval. The wake stays in flight
      // until a decision, exactly the state the shutdown must not hang on.
      inFlight = requestOutcome(
        first.info.url,
        firstToken,
        'POST',
        '/lives/wake',
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

      assert.equal(existsSync(first.info.tokenPath), true);
      assert.equal(existsSync(join(daemonDir, 'server.json')), true);
      assert.equal(existsSync(join(daemonDir, 'daemon.lock')), true);

      const firstLogs = [...first.logs];
      const firstStderr = [...first.stderr];
      const firstStdout = [...first.stdout];
      const wakePromise = inFlight;
      assert.ok(wakePromise !== undefined);
      const stopped = await stopInProcessDaemon(first);
      first = undefined;
      const settled = await withTimeout(wakePromise, 30_000, 'in-flight wake settlement');
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
      const runFiles = readdirSync(runsDirectory).filter((name) => name.endsWith('.json'));
      assert.ok(runFiles.length >= 1, 'completed run record must be durable');
      // The graph was busy at shutdown, so dispose could not unload it. That is
      // the hard restart case: the persisted catalog still says loaded.
      assert.equal(catalogOnDisk(daemonDir)[liveId]?.['state'], 'loaded');
      t.diagnostic(
        `graceful stop: exit=0 elapsedMs=${String(stopped.elapsedMs)} ` +
          `wakeOutcome=${settled.kind} cleanToken=true cleanServerJson=true ` +
          `wake500=false runFiles=${String(runFiles.length)}`,
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

      const recoveredRun = await request(
        second.info.url,
        secondToken,
        'GET',
        `/lives/${liveId}/output?runId=${firstRunId}`,
      );
      assert.equal(recoveredRun.status, 200);
      assert.equal(recoveredRun.body['status'], 'completed');
      assert.equal(recoveredRun.body['operation'], 'trigger');

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
      assert.equal(inspected.body['status']?.['graphId'], liveId);

      const secondWake = await request(second.info.url, secondToken, 'POST', '/lives/wake', {
        liveId,
        beeId: 'only',
        input: numberPrompt(1000, 9999),
      });
      assert.equal(secondWake.status, 200, JSON.stringify(secondWake.body));
      assert.equal(secondWake.body['result']?.['rest'], true);
      const secondOutput = await request(
        second.info.url,
        secondToken,
        'GET',
        `/lives/${liveId}/output`,
      );
      assert.equal(secondOutput.status, 200);
      const secondOutputs = secondOutput.body['outputs'] as Record<string, unknown>[];
      assert.ok(
        /^\d{4}$/.test(textOf(secondOutputs[0]?.['value']).trim()),
        'post-restart output must be a four-digit integer (value not recorded)',
      );
      assert.equal((await request(second.info.url, secondToken, 'POST', '/lives/save', {
        liveId,
      })).status, 200);

      t.diagnostic(
        `restart: catalogState=${String(entry['state'])} ` +
          `liveReloaded=${String(reloaded.status)} runReadable=${String(recoveredRun.status)} ` +
          `wakeAfterRestart=${String(secondWake.status)}`,
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
