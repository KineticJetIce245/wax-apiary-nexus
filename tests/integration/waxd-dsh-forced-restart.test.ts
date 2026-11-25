import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { Project } from '../../src/project/kernel.js';
import {
  catalogOnDisk,
  directChildPids,
  dshIntegrationOptions,
  forceKillTree,
  isAlive,
  killOrphan,
  liveFor,
  numberPrompt,
  readJson,
  readToken,
  request,
  requestOutcome,
  runIdOf,
  shellWritePrompt,
  startChildDaemon,
  textOf,
  waitFor,
  waitForRun,
  withTimeout,
  WAXD_ENTRY,
  type ChildDaemon,
  type HttpResult,
} from '../support/dsh-daemon-harness.js';

// A shell write must ask the native harness, so a pending approval exists when
// the OS process is terminated. Node runs every test file in its own process.
process.env.DSH_PERMISSION_MODE = 'read-only';

async function wakeAndWait(
  url: string,
  token: string,
  liveId: string,
  input: string,
): Promise<HttpResult> {
  const wake = await request(url, token, 'POST', '/lives/wake', { liveId, beeId: 'only', input });
  assert.equal(wake.status, 202, JSON.stringify(wake.body));
  await waitForRun(url, token, liveId, runIdOf(wake.body));
  return wake;
}

test(
  'real DSH daemon recovers after forced termination on the same state',
  dshIntegrationOptions,
  async (t) => {
    assert.equal(existsSync(WAXD_ENTRY), true, `compiled daemon entry is missing: ${WAXD_ENTRY}`);
    const stateRoot = mkdtempSync(join(tmpdir(), 'wax-m12b-forced-state-'));
    const daemonDir = join(stateRoot, 'waxd');
    const project: Project = {
      id: 'project-m12b-forced',
      directory: mkdtempSync(join(tmpdir(), 'wax-m12b-forced-project-')),
    };
    const liveId = 'm12b-forced';
    const livePath = join(stateRoot, 'lives', liveId, 'live.json');
    assert.deepEqual(catalogOnDisk(daemonDir), {});

    let first: ChildDaemon | undefined;
    let second: ChildDaemon | undefined;
    let third: ChildDaemon | undefined;
    const orphans = new Set<number>();

    try {
      first = await startChildDaemon(stateRoot, daemonDir);
      const firstToken = readToken(first.tokenPath);
      const loaded = await request(first.url, firstToken, 'POST', '/lives', {
        live: liveFor(liveId),
        project,
      });
      assert.equal(loaded.status, 200, JSON.stringify(loaded.body));
      const wake = await wakeAndWait(first.url, firstToken, liveId, numberPrompt(100, 999));
      const saved = await request(first.url, firstToken, 'POST', '/lives/save', { liveId });
      assert.equal(saved.status, 200);
      const firstOutput = await request(
        first.url,
        firstToken,
        'GET',
        `/lives/${liveId}/output`,
      );
      assert.equal(firstOutput.status, 200);
      assert.equal(firstOutput.body['status'], 'completed');
      assert.equal(typeof firstOutput.body['runId'], 'string');
      const firstRunId = String(firstOutput.body['runId']);

      const marker = `M12B-FORCED-${String(Date.now())}`;
      const inFlight = requestOutcome(first.url, firstToken, 'POST', '/lives/wake', {
        liveId,
        beeId: 'only',
        input: shellWritePrompt('forced-wake-m12b.txt', marker),
      });
      const guard = await waitFor(async () => {
        const listed = await request(first!.url, firstToken, 'GET', '/guards');
        if (listed.status !== 200) {
          return undefined;
        }
        const guards = listed.body['guards'] as Record<string, unknown>[];
        return guards.length === 1 ? guards[0] : undefined;
      }, 120_000, 'pending native guard before termination');
      assert.equal(typeof guard?.['requestId'], 'string');

      const descendants = directChildPids(first.child.pid ?? -1);
      assert.ok(descendants.length >= 1, 'real DSH ACP child process must be running');
      for (const pid of descendants) {
        orphans.add(pid);
      }

      const sentAt = Date.now();
      assert.equal(first.child.kill('SIGTERM'), true);
      const firstExit = await withTimeout(first.exit, 30_000, 'SIGTERM exit');
      const inFlightOutcome = await withTimeout(inFlight, 30_000, 'SIGTERM wake settlement');
      assert.equal(inFlightOutcome.kind === 'response' && inFlightOutcome.status === 500, false);
      const staleToken = existsSync(join(daemonDir, 'token'));
      const staleInfo = existsSync(join(daemonDir, 'server.json'));
      const staleLock = existsSync(join(daemonDir, 'daemon.lock'));
      const survived = [...orphans].filter(isAlive);
      for (const pid of survived) {
        killOrphan(pid);
      }
      orphans.clear();

      if (process.platform === 'win32') {
        // Windows has no POSIX signal delivery: Node's SIGTERM terminates the
        // process unconditionally, so no shutdown code ran. These assertions
        // record the observed limitation; they are not a graceful-stop pass.
        assert.equal(firstExit.code, null);
        assert.equal(firstExit.signal, 'SIGTERM');
        assert.equal(staleToken, true);
        assert.equal(staleInfo, true);
        assert.equal(staleLock, true);
      } else {
        assert.equal(firstExit.code, 0);
        assert.equal(staleToken, false);
        assert.equal(staleInfo, false);
        assert.equal(staleLock, false);
      }
      first = undefined;

      t.diagnostic(
        `forced SIGTERM: code=${String(firstExit.code)} signal=${String(firstExit.signal)} ` +
          `elapsedMs=${String(Date.now() - sentAt)} staleToken=${String(staleToken)} ` +
          `staleServerJson=${String(staleInfo)} staleLock=${String(staleLock)} ` +
          `nativeChildrenBefore=${String(descendants.length)} ` +
          `nativeChildrenSurvived=${String(survived.length)} ` +
          `wakeOutcome=${inFlightOutcome.kind}`,
      );

      // Restart on the same daemonDir: the dead owner's lock/token/server.json
      // are stale and must not block the new daemon.
      second = await startChildDaemon(stateRoot, daemonDir);
      const secondToken = readToken(second.tokenPath);
      assert.notEqual(secondToken, firstToken);
      assert.equal(readJson(join(daemonDir, 'server.json'))['pid'], second.child.pid);
      assert.equal(readJson(join(daemonDir, 'daemon.lock'))['pid'], second.child.pid);
      assert.equal((await request(second.url, secondToken, 'GET', '/health')).status, 200);
      const catalog = await request(second.url, secondToken, 'GET', '/lives');
      assert.equal(catalog.status, 200);
      const entry = (catalog.body['lives'] as Record<string, unknown>[]).find(
        (item) => item['liveId'] === liveId,
      );
      assert.ok(entry !== undefined);
      assert.equal(entry['state'], 'unloaded');
      assert.equal(readJson(livePath)['liveId'], liveId);
      const runs = readdirSync(join(daemonDir, 'runs')).filter((name) =>
        name.endsWith('.json'),
      );
      assert.ok(runs.length >= 1);
      const recoveredRun = await request(
        second.url,
        secondToken,
        'GET',
        `/lives/${liveId}/output?runId=${firstRunId}`,
      );
      assert.equal(recoveredRun.status, 200);
      assert.equal(recoveredRun.body['status'], 'completed');
      assert.equal(recoveredRun.body['runId'], firstRunId);

      const reloaded = await request(second.url, secondToken, 'POST', '/lives/load', {
        liveId,
        project,
      });
      assert.equal(reloaded.status, 200, JSON.stringify(reloaded.body));
      const wakeAfterRestart = await wakeAndWait(
        second.url,
        secondToken,
        liveId,
        numberPrompt(1000, 9999),
      );
      const outputAfterRestart = await request(
        second.url,
        secondToken,
        'GET',
        `/lives/${liveId}/output`,
      );
      assert.equal(outputAfterRestart.status, 200);
      const outputs = outputAfterRestart.body['outputs'] as Record<string, unknown>[];
      assert.ok(
        /^\d{4}$/.test(textOf(outputs[0]?.['value']).trim()),
        'post-restart output must be a four-digit integer (value not recorded)',
      );
      assert.equal(
        (await request(second.url, secondToken, 'POST', '/lives/save', { liveId })).status,
        200,
      );
      t.diagnostic(
        `SIGTERM restart: health=200 catalogState=unloaded reload=200 ` +
          `wake=${String(wakeAfterRestart.status)} staleLockStolen=true tokenReplaced=true`,
      );

      // A second forced termination, now with SIGKILL, must behave the same.
      const secondDescendants = directChildPids(second.child.pid ?? -1);
      for (const pid of secondDescendants) {
        orphans.add(pid);
      }
      assert.equal(second.child.kill('SIGKILL'), true);
      const secondExit = await withTimeout(second.exit, 30_000, 'SIGKILL exit');
      const secondSurvived = [...orphans].filter(isAlive);
      for (const pid of secondSurvived) {
        killOrphan(pid);
      }
      orphans.clear();
      if (process.platform === 'win32') {
        assert.equal(secondExit.code, null);
        assert.equal(secondExit.signal, 'SIGKILL');
      } else {
        assert.equal(secondExit.code, 0);
      }
      assert.equal(existsSync(join(daemonDir, 'server.json')), true);
      second = undefined;
      t.diagnostic(
        `forced SIGKILL: code=${String(secondExit.code)} signal=${String(secondExit.signal)} ` +
          `nativeChildrenBefore=${String(secondDescendants.length)} ` +
          `nativeChildrenSurvived=${String(secondSurvived.length)}`,
      );

      third = await startChildDaemon(stateRoot, daemonDir);
      const thirdToken = readToken(third.tokenPath);
      assert.notEqual(thirdToken, secondToken);
      assert.equal((await request(third.url, thirdToken, 'GET', '/health')).status, 200);
      const thirdCatalog = await request(third.url, thirdToken, 'GET', '/lives');
      assert.equal(thirdCatalog.status, 200);
      const thirdEntry = (thirdCatalog.body['lives'] as Record<string, unknown>[]).find(
        (item) => item['liveId'] === liveId,
      );
      assert.equal(thirdEntry?.['state'], 'unloaded');
      assert.equal(readJson(livePath)['liveId'], liveId);
      assert.equal(readJson(join(daemonDir, 'server.json'))['pid'], third.child.pid);
      t.diagnostic(
        `SIGKILL restart: health=200 catalogState=unloaded liveJsonReadable=true ` +
          `staleLockStolen=true tokenReplaced=true`,
      );
    } finally {
      const survivors = [...orphans].filter(isAlive);
      for (const pid of survivors) {
        killOrphan(pid);
      }
      for (const daemon of [first, second, third]) {
        if (daemon !== undefined) {
          forceKillTree(daemon.child.pid);
          await withTimeout(daemon.exit, 15_000, 'child daemon cleanup').catch(() => undefined);
        }
      }
    }
  },
);
