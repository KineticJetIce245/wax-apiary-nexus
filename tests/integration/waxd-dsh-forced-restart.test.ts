import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
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
  shellWritePrompt,
  startChildDaemon,
  textOf,
  waitFor,
  waitForRest,
  withTimeout,
  WAXD_ENTRY,
  type ChildDaemon,
  type HttpResult,
} from '../support/dsh-daemon-harness.js';

// A shell write must ask the native harness, so a pending approval exists when
// the OS process is terminated. Node runs every test file in its own process.
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

function outputText(body: Record<string, any>): string {
  const entries = body['outputs'] as Record<string, unknown>[];
  return textOf(entries[0]?.['value']).trim();
}

test(
  'real DSH daemon recovers after forced termination on the same state',
  dshIntegrationOptions,
  async (t) => {
    assert.equal(existsSync(WAXD_ENTRY), true, `compiled daemon entry is missing: ${WAXD_ENTRY}`);
    const stateRoot = mkdtempSync(join(tmpdir(), 'wax-m12b-forced-state-'));
    const daemonDir = join(stateRoot, 'waxd');
    const runsDirectory = join(daemonDir, 'runs');
    const project: Project = {
      id: 'project-m12b-forced',
      directory: mkdtempSync(join(tmpdir(), 'wax-m12b-forced-project-')),
    };
    const liveId = 'm12b-forced';
    const livePath = join(stateRoot, 'lives', liveId, 'live.json');
    const markerFile = 'forced-wake-m12b.txt';
    assert.deepEqual(catalogOnDisk(daemonDir), {});

    let first: ChildDaemon | undefined;
    let second: ChildDaemon | undefined;
    let third: ChildDaemon | undefined;
    const orphans = new Set<number>();

    try {
      first = await startChildDaemon(stateRoot, daemonDir);
      const firstToken = readToken(first.tokenPath);
      assert.equal(existsSync(runsDirectory), false, 'startup created a runs/ directory');
      const loaded = await request(first.url, firstToken, 'POST', '/lives', {
        live: liveFor(liveId),
        project,
      });
      assert.equal(loaded.status, 200, JSON.stringify(loaded.body));
      await triggerAndWait(first.url, firstToken, liveId, numberPrompt(100, 999));
      const saved = await request(first.url, firstToken, 'POST', '/lives/save', { liveId });
      assert.equal(saved.status, 200);
      const firstOutput = await request(
        first.url,
        firstToken,
        'GET',
        `/lives/${liveId}/output`,
      );
      assert.equal(firstOutput.status, 200);
      assert.equal(firstOutput.body['runId'], undefined);
      assert.equal(firstOutput.body['traceId'], undefined);
      assert.ok(/^\d{3}$/.test(outputText(firstOutput.body)));

      const marker = `M12B-FORCED-${String(Date.now())}`;
      const inFlight = requestOutcome(first.url, firstToken, 'POST', '/lives/trigger', {
        liveId,
        beeId: 'only',
        input: shellWritePrompt(markerFile, marker),
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
      assert.equal(existsSync(join(project.directory, markerFile)), false);

      const descendants = directChildPids(first.child.pid ?? -1);
      assert.ok(descendants.length >= 1, 'real DSH ACP child process must be running');
      for (const pid of descendants) {
        orphans.add(pid);
      }

      const sentAt = Date.now();
      assert.equal(first.child.kill('SIGTERM'), true);
      const firstExit = await withTimeout(first.exit, 30_000, 'SIGTERM exit');
      const inFlightOutcome = await withTimeout(inFlight, 30_000, 'SIGTERM delivery settlement');
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
      assert.equal(existsSync(runsDirectory), false, 'a runs/ record was written');

      // D2: Honey restores the field, not a run history. The output cache was
      // memory-only; after the crash there is nothing to read and nothing is
      // replayed, including the pending side effect.
      const staleOutput = await request(
        second.url,
        secondToken,
        'GET',
        `/lives/${liveId}/output`,
      );
      assert.equal(staleOutput.status, 404);
      const guardsAfterRestart = await request(second.url, secondToken, 'GET', '/guards');
      assert.deepEqual(guardsAfterRestart.body['guards'], []);
      assert.equal(
        existsSync(join(project.directory, markerFile)),
        false,
        'the pending side effect was replayed after forced termination',
      );

      const reloaded = await request(second.url, secondToken, 'POST', '/lives/load', {
        liveId,
        project,
      });
      assert.equal(reloaded.status, 200, JSON.stringify(reloaded.body));
      const inspected = await request(second.url, secondToken, 'GET', `/lives/${liveId}/inspect`);
      assert.equal(inspected.status, 200);
      assert.equal(inspected.body['status']?.['rest'], true);
      assert.deepEqual(inspected.body['outputs'], []);

      await triggerAndWait(second.url, secondToken, liveId, numberPrompt(1000, 9999));
      const outputAfterRestart = await request(
        second.url,
        secondToken,
        'GET',
        `/lives/${liveId}/output`,
      );
      assert.equal(outputAfterRestart.status, 200);
      assert.equal(outputAfterRestart.body['runId'], undefined);
      assert.ok(
        /^\d{4}$/.test(outputText(outputAfterRestart.body)),
        'post-restart output must be a four-digit integer (value not recorded)',
      );
      assert.equal(
        (await request(second.url, secondToken, 'POST', '/lives/save', { liveId })).status,
        200,
      );
      t.diagnostic(
        `SIGTERM restart: health=200 catalogState=unloaded reload=200 ` +
          `staleOutput=${String(staleOutput.status)} noReplay=true ` +
          `staleLockStolen=true tokenReplaced=true`,
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
      assert.equal(existsSync(runsDirectory), false);
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
