import assert from 'node:assert/strict';
import test from 'node:test';

import { FakeAdapter } from './support/fake-adapter.js';
import {
  decide,
  dispose,
  distribution,
  fiveHundredLogs,
  load,
  makeEnv,
  record,
  refuse500,
  singleHarness,
  sleep,
  start,
  STRESS_ROUNDS,
  unloadLive,
  waitForGuardCount,
  wakeLive,
  type Observation,
} from './support/guard-stress.js';

const ROUNDS = STRESS_ROUNDS;

test(
  `a late decision after guard expiry is always 409 guard-expired (${String(ROUNDS)} rounds)`,
  async (t) => {
    const adapter = new FakeAdapter({ askApproval: true, output: 'expired' });
    const env = makeEnv(singleHarness(adapter));
    const running = await start(env, 200);
    t.after(async () => {
      await dispose(running, env);
    });

    const observations: Observation[] = [];
    for (let round = 1; round <= ROUNDS; round += 1) {
      // A fresh live avoids the composition's 1s per-node pacing, which would
      // otherwise dominate a 50-round stress run.
      const liveId = `late-${String(round)}`;
      await load(running, env, liveId);
      const wakePromise = wakeLive(running, liveId);
      const guards = await waitForGuardCount(running, 1);
      const guard = guards[0];
      assert.ok(guard !== undefined);
      const requestId = guard['requestId'];
      const openedAt = Date.now();
      await waitForGuardCount(running, 0);
      const elapsedMs = Date.now() - openedAt;

      const late = await decide(running, requestId, 'allow_once');
      refuse500(running, late, 'late-decide', requestId, elapsedMs);
      assert.equal(
        late.status,
        409,
        `round ${String(round)}: expected 409, got ${String(late.status)}/${late.code}`,
      );
      assert.equal(late.code, 'guard-expired');
      record(observations, round, 'late-decide', late);

      // The settled reason survives; a repeated late decision is still expired,
      // never re-opened, and an unknown request is a distinct 404.
      const repeated = await decide(running, requestId, 'reject_once');
      refuse500(running, repeated, 'repeated-late-decide', requestId, elapsedMs);
      assert.equal(repeated.status, 409);
      assert.equal(repeated.code, 'guard-expired');
      record(observations, round, 'repeated-late-decide', repeated);

      const unknown = await decide(running, `missing-${String(round)}`, 'allow_once');
      refuse500(running, unknown, 'unknown-decide', requestId, elapsedMs);
      assert.equal(unknown.status, 404);
      assert.equal(unknown.code, 'not-found');
      record(observations, round, 'unknown-decide', unknown);

      const wake = await wakePromise;
      assert.equal(wake.status, 200, `round ${String(round)} wake: ${wake.text}`);
      assert.equal(adapter.approvals.at(-1)?.kind, 'cancelled');
      await unloadLive(running, liveId);
    }

    t.diagnostic(
      `late-expiry rounds=${String(ROUNDS)} distribution=${distribution(observations)} ` +
        `server500s=${String(fiveHundredLogs(running).length)}`,
    );
  },
);

test(
  `a decision racing the guard deadline is allow or expired, never 500 (${String(ROUNDS)} rounds)`,
  async (t) => {
    const adapter = new FakeAdapter({ askApproval: true, output: 'raced' });
    const env = makeEnv(singleHarness(adapter));
    const running = await start(env, 150);
    t.after(async () => {
      await dispose(running, env);
    });

    const observations: Observation[] = [];
    const deadlineRounds = Math.floor(ROUNDS / 2);
    for (let round = 1; round <= ROUNDS; round += 1) {
      const liveId = `race-${String(round)}`;
      await load(running, env, liveId);
      const wakePromise = wakeLive(running, liveId);
      const guards = await waitForGuardCount(running, 1);
      const guard = guards[0];
      assert.ok(guard !== undefined);
      const requestId = guard['requestId'];

      // Half the rounds decide early, half very near the deadline. Both can
      // win the race; either outcome is valid, an internal 500 is not.
      await sleep(round <= deadlineRounds ? 10 : 140);
      const decidedAt = Date.now();
      const decision = await decide(running, requestId, 'allow_once');
      refuse500(running, decision, 'deadline-decide', requestId, Date.now() - decidedAt);
      assert.ok(
        decision.status === 200 || decision.status === 409,
        `round ${String(round)}: unexpected ${String(decision.status)}/${decision.code}`,
      );
      if (decision.status === 409) {
        assert.equal(decision.code, 'guard-expired');
      }
      record(observations, round, 'deadline-decide', decision);

      const wake = await wakePromise;
      assert.equal(wake.status, 200, `round ${String(round)} wake: ${wake.text}`);
      const expected = decision.status === 200 ? 'allow_once' : 'cancelled';
      assert.equal(adapter.approvals.at(-1)?.kind, expected);
      await unloadLive(running, liveId);
    }

    t.diagnostic(
      `deadline-race rounds=${String(ROUNDS)} distribution=${distribution(observations)} ` +
        `server500s=${String(fiveHundredLogs(running).length)}`,
    );
  },
);
