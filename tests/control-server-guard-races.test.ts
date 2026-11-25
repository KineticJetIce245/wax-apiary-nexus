import assert from 'node:assert/strict';
import test from 'node:test';

import { FakeAdapter } from './support/fake-adapter.js';
import {
  decide,
  dispose,
  distribution,
  dualHarness,
  fiveHundredLogs,
  load,
  makeEnv,
  record,
  refuse500,
  settleWake,
  singleHarness,
  start,
  STRESS_ROUNDS,
  unloadLive,
  waitForGuardCount,
  wakeLive,
  type Observation,
} from './support/guard-stress.js';

const ROUNDS = STRESS_ROUNDS;
const MULTI_ROUNDS = Math.max(5, Math.min(ROUNDS, 20));

test(
  `two pending guards settle independently over ${String(MULTI_ROUNDS)} rounds`,
  async (t) => {
    const codex = new FakeAdapter({ askApproval: true, output: 'codex' });
    const dsh = new FakeAdapter({ askApproval: true, output: 'dsh' });
    const env = makeEnv(dualHarness(codex, dsh));
    const running = await start(env, 10_000);
    t.after(async () => {
      await dispose(running, env);
    });

    const observations: Observation[] = [];
    for (let round = 1; round <= MULTI_ROUNDS; round += 1) {
      const liveA = `multi-a-${String(round)}`;
      const liveB = `multi-b-${String(round)}`;
      await load(running, env, liveA, 'codex');
      await load(running, env, liveB, 'dsh');
      const wakeA = wakeLive(running, liveA);
      await waitForGuardCount(running, 1);
      const wakeB = wakeLive(running, liveB);
      const guards = await waitForGuardCount(running, 2);
      const guardA = guards[0];
      const guardB = guards[1];
      assert.ok(guardA !== undefined && guardB !== undefined);
      const decideA = await decide(running, guardA['requestId'], 'allow_once');
      const decideB = await decide(running, guardB['requestId'], 'reject_once');
      refuse500(running, decideA, 'multi-decide-a', guardA['requestId'], 0);
      refuse500(running, decideB, 'multi-decide-b', guardB['requestId'], 0);
      record(observations, round, 'multi-decide-a', decideA);
      record(observations, round, 'multi-decide-b', decideB);
      assert.equal(decideA.status, 200);
      assert.equal(decideB.status, 200);

      await Promise.all([
        settleWake(running, liveA, wakeA),
        settleWake(running, liveB, wakeB),
      ]);
      assert.equal(codex.approvals.at(-1)?.kind, 'allow_once');
      assert.equal(dsh.approvals.at(-1)?.kind, 'reject_once');
      await waitForGuardCount(running, 0);

      // A decided request cannot be re-opened; an unknown id stays distinct.
      const repeatedA = await decide(running, guardA['requestId'], 'allow_once');
      const repeatedB = await decide(running, guardB['requestId'], 'reject_once');
      refuse500(running, repeatedA, 'multi-repeat-a', guardA['requestId'], 0);
      refuse500(running, repeatedB, 'multi-repeat-b', guardB['requestId'], 0);
      record(observations, round, 'multi-repeat-a', repeatedA);
      record(observations, round, 'multi-repeat-b', repeatedB);
      assert.equal(repeatedA.status, 409);
      assert.equal(repeatedA.code, 'conflict');
      assert.equal(repeatedB.status, 409);
      assert.equal(repeatedB.code, 'conflict');

      const unknown = await decide(running, `multi-missing-${String(round)}`, 'allow_once');
      refuse500(running, unknown, 'multi-unknown', 'multi-missing', 0);
      record(observations, round, 'multi-unknown', unknown);
      assert.equal(unknown.status, 404);
      assert.equal(unknown.code, 'not-found');
      await unloadLive(running, liveA);
      await unloadLive(running, liveB);
    }

    t.diagnostic(
      `multi-pending rounds=${String(MULTI_ROUNDS)} distribution=${distribution(observations)} ` +
        `server500s=${String(fiveHundredLogs(running).length)}`,
    );
  },
);

test('concurrent duplicate decisions settle exactly once and never answer 500', async (t) => {
  const adapter = new FakeAdapter({ askApproval: true, output: 'once' });
  const env = makeEnv(singleHarness(adapter));
  const running = await start(env, 10_000);
  t.after(async () => {
    await dispose(running, env);
  });
  const rounds = Math.max(3, Math.min(ROUNDS, 10));
  const observations: Observation[] = [];

  for (let round = 1; round <= rounds; round += 1) {
    const liveId = `duplicate-${String(round)}`;
    await load(running, env, liveId);
    const wakePromise = wakeLive(running, liveId);
    const guards = await waitForGuardCount(running, 1);
    const guard = guards[0];
    assert.ok(guard !== undefined);
    const requestId = guard['requestId'];

    // Eight independent connections race the same request. Exactly one may
    // settle it; the rest must be a settled conflict, never a 500.
    const results = await Promise.all(
      Array.from({ length: 8 }, () => decide(running, requestId, 'allow_once')),
    );
    for (const result of results) {
      refuse500(running, result, 'concurrent-duplicate', requestId, 0);
      record(observations, round, 'concurrent-duplicate', result);
    }
    assert.equal(results.filter((result) => result.status === 200).length, 1);
    const conflicts = results.filter((result) => result.status === 409);
    assert.equal(conflicts.length, 7);
    assert.deepEqual(
      conflicts.map((result) => result.code),
      Array.from({ length: 7 }, () => 'conflict'),
    );

    await settleWake(running, liveId, wakePromise);
    assert.equal(adapter.approvals.at(-1)?.kind, 'allow_once');
    await waitForGuardCount(running, 0);
    await unloadLive(running, liveId);
  }

  t.diagnostic(
    `duplicate-race rounds=${String(rounds)} distribution=${distribution(observations)} ` +
      `server500s=${String(fiveHundredLogs(running).length)}`,
  );
});

test(
  'one of two pending guards expires while the other is decided, never 500',
  async (t) => {
    const codex = new FakeAdapter({ askApproval: true, output: 'live' });
    const dsh = new FakeAdapter({ askApproval: true, output: 'expiring' });
    const env = makeEnv(dualHarness(codex, dsh));
    const rounds = Math.max(5, Math.min(ROUNDS, 10));
    const running = await start(env, 250);
    t.after(async () => {
      await dispose(running, env);
    });

    const observations: Observation[] = [];
    for (let round = 1; round <= rounds; round += 1) {
      const liveA = `mixed-a-${String(round)}`;
      const liveB = `mixed-b-${String(round)}`;
      await load(running, env, liveA, 'codex');
      await load(running, env, liveB, 'dsh');
      const wakeA = wakeLive(running, liveA);
      await waitForGuardCount(running, 1);
      const wakeB = wakeLive(running, liveB);
      const guards = await waitForGuardCount(running, 2);
      const guardA = guards[0];
      const guardB = guards[1];
      assert.ok(guardA !== undefined && guardB !== undefined);

      const decided = await decide(running, guardA['requestId'], 'allow_once');
      refuse500(running, decided, 'mixed-decide-live', guardA['requestId'], 0);
      assert.equal(decided.status, 200);
      record(observations, round, 'mixed-decide-live', decided);
      await settleWake(running, liveA, wakeA);

      await waitForGuardCount(running, 0);
      const late = await decide(running, guardB['requestId'], 'allow_once');
      refuse500(running, late, 'mixed-late-decide-expired', guardB['requestId'], 0);
      assert.equal(late.status, 409);
      assert.equal(late.code, 'guard-expired');
      record(observations, round, 'mixed-late-decide-expired', late);
      await settleWake(running, liveB, wakeB);
      assert.equal(codex.approvals.at(-1)?.kind, 'allow_once');
      assert.equal(dsh.approvals.at(-1)?.kind, 'cancelled');
      await unloadLive(running, liveA);
      await unloadLive(running, liveB);
    }

    t.diagnostic(
      `mixed-expiry rounds=${String(rounds)} distribution=${distribution(observations)} ` +
        `server500s=${String(fiveHundredLogs(running).length)}`,
    );
  },
);

test('decisions racing shutdown never answer 500', async (t) => {
  const rounds = Math.max(3, Math.min(ROUNDS, 5));
  const observations: Observation[] = [];
  const cleanups: (() => Promise<void>)[] = [];
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) {
      await cleanup().catch(() => undefined);
    }
  });

  for (let round = 1; round <= rounds; round += 1) {
    const adapter = new FakeAdapter({ askApproval: true });
    const env = makeEnv(singleHarness(adapter));
    const running = await start(env, 10_000);
    cleanups.push(async () => {
      await dispose(running, env);
    });
    await load(running, env, `shutdown-${String(round)}`);
    const wakePromise = wakeLive(running, `shutdown-${String(round)}`).catch(
      () => undefined,
    );
    const guards = await waitForGuardCount(running, 1);
    const guard = guards[0];
    assert.ok(guard !== undefined);

    // Fire decisions, then stop in the same tick. The server may answer before
    // shutdown, refuse the settled guard, or close the socket; none of those
    // may be an internal 500.
    const deciding = Array.from({ length: 6 }, async () => {
      try {
        return await decide(running, guard['requestId'], 'allow_once');
      } catch {
        return { status: 0, code: 'network' } satisfies { status: number; code: string };
      }
    });
    await running.server.stop();
    const results = await Promise.all(deciding);
    await wakePromise;

    for (const result of results) {
      refuse500(running, result, 'shutdown-decide', guard['requestId'], 0);
      record(observations, round, 'shutdown-decide', result);
      assert.notEqual(result.status, 500);
    }
    const decide500s = running.logs.filter(
      (line) => line.includes('status=500') && line.includes('/guard/decide'),
    );
    assert.deepEqual(decide500s, []);
    const other500s = fiveHundredLogs(running);
    t.diagnostic(
      `shutdown round=${String(round)} ` +
        `statuses=${results.map((result) => `${String(result.status)}/${result.code}`).join(',')} ` +
        `server500s=${String(other500s.length)}` +
        (other500s.length === 0 ? '' : ` [${other500s.join(' | ')}]`),
    );
  }

  t.diagnostic(`shutdown rounds=${String(rounds)} distribution=${distribution(observations)}`);
});
