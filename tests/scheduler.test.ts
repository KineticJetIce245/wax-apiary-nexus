import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { HoneyStore, honeyPaths } from '../src/storage/honey.js';
import {
  Scheduler,
  parseSchedulerState,
  type SchedulerState,
  type SchedulerTimers,
} from '../src/daemon/scheduler.js';
import type { TriggerDefinition } from '../src/runtime/index.js';

const START = Date.parse('2026-11-05T12:00:00.000Z');

interface ScheduledTimer {
  readonly due: number;
  readonly handler: () => void;
}

/** Deterministic clock and timer queue for scheduler tests. */
class ManualTimers implements SchedulerTimers {
  time: number;
  private nextId = 1;
  private readonly timers = new Map<number, ScheduledTimer>();

  constructor(start: number) {
    this.time = start;
  }

  readonly now = (): number => this.time;

  readonly setTimeout = (handler: () => void, delayMs: number): unknown => {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { due: this.time + Math.max(0, delayMs), handler });
    return id;
  };

  readonly clearTimeout = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };

  advance(ms: number): void {
    const target = this.time + ms;
    for (;;) {
      let nextId: number | undefined;
      let nextDue = Number.POSITIVE_INFINITY;
      for (const [id, timer] of this.timers) {
        if (timer.due <= target && timer.due < nextDue) {
          nextId = id;
          nextDue = timer.due;
        }
      }
      if (nextId === undefined) {
        break;
      }
      const timer = this.timers.get(nextId);
      if (timer === undefined) {
        break;
      }
      this.timers.delete(nextId);
      this.time = Math.max(this.time, timer.due);
      timer.handler();
    }
    this.time = target;
  }
}

function atTrigger(id: string, atMs: number, target = 'plan'): TriggerDefinition {
  return {
    id,
    target,
    schedule: { kind: 'at', at: new Date(atMs).toISOString() },
  };
}

function everyTrigger(id: string, everyMs: number, target = 'plan'): TriggerDefinition {
  return { id, target, schedule: { kind: 'every', everyMs } };
}

interface Harness {
  readonly scheduler: Scheduler;
  readonly timers: ManualTimers;
  readonly fired: { readonly id: string; readonly at: number }[];
  readonly events: string[];
}

function harness(
  triggers: readonly TriggerDefinition[],
  options: {
    start?: number;
    state?: ReturnType<Scheduler['exportState']>;
    failPersistOn?: number;
  } = {},
): Harness {
  const start = options.start ?? START;
  const timers = new ManualTimers(start);
  const fired: { id: string; at: number }[] = [];
  const events: string[] = [];
  let writes = 0;
  const scheduler = new Scheduler({
    triggers,
    ...(options.state === undefined ? {} : { state: options.state }),
    now: timers.now,
    timers,
    persist: () => {
      writes += 1;
      if (options.failPersistOn !== undefined && writes === options.failPersistOn) {
        throw new Error('disk full');
      }
      events.push('persist');
    },
    onTrigger: (trigger) => {
      events.push('trigger');
      fired.push({ id: trigger.id, at: timers.time });
    },
  });
  return { scheduler, timers, fired, events };
}

test('a future at trigger fires once at its due instant', () => {
  const testHarness = harness([atTrigger('once', START + 1000)]);

  testHarness.scheduler.start();
  testHarness.timers.advance(999);
  assert.equal(testHarness.fired.length, 0);

  testHarness.timers.advance(1);
  assert.deepEqual(testHarness.fired, [{ id: 'once', at: START + 1000 }]);

  testHarness.timers.advance(60_000);
  assert.equal(testHarness.fired.length, 1);
  assert.equal(testHarness.scheduler.exportState().triggers['once']?.kind, 'at');
  const state = testHarness.scheduler.exportState().triggers['once'];
  assert.ok(state !== undefined && state.kind === 'at');
  assert.equal(state.fired, true);
  testHarness.scheduler.stop();
});

test('a past at trigger fires once on start and never again', () => {
  const testHarness = harness([atTrigger('past', START - 5000)]);

  testHarness.scheduler.start();
  testHarness.timers.advance(60_000);

  assert.deepEqual(testHarness.fired, [{ id: 'past', at: START }]);
  testHarness.scheduler.stop();
});

test('the occurrence is persisted before the trigger callback', () => {
  const testHarness = harness([atTrigger('past', START - 1000)]);

  testHarness.scheduler.start();

  assert.equal(testHarness.fired.length, 1);
  assert.deepEqual(testHarness.events.slice(-2), ['persist', 'trigger']);
  testHarness.scheduler.stop();
});

test('a failed occurrence write never fires the trigger', () => {
  // start() writes the reconciled state first; fail the second (due) write.
  const testHarness = harness([atTrigger('past', START - 1000)], { failPersistOn: 2 });

  assert.throws(() => testHarness.scheduler.start(), /disk full/);
  assert.equal(testHarness.fired.length, 0);
  testHarness.scheduler.stop();
});

test('a crash after the occurrence write but before the callback loses it instead of replaying it', () => {
  const timers = new ManualTimers(START);
  const trigger = atTrigger('past', START - 1000);
  let persisted: SchedulerState | undefined;
  let writes = 0;
  let callbackRan = false;

  const first = new Scheduler({
    triggers: [trigger],
    now: timers.now,
    timers,
    persist: (state) => {
      writes += 1;
      persisted = structuredClone(state);
      if (writes === 2) {
        // The durable write completed, then the process died before onTrigger.
        throw new Error('process died after the durable occurrence write');
      }
    },
    onTrigger: () => {
      callbackRan = true;
    },
  });

  assert.throws(() => first.start(), /process died/);
  assert.equal(callbackRan, false);
  assert.equal(writes, 2);
  assert.ok(persisted !== undefined);
  const fired = persisted.triggers['past'];
  assert.ok(fired !== undefined && fired.kind === 'at');
  assert.equal(fired.fired, true);

  let restartedCallbackRan = false;
  const secondTimers = new ManualTimers(START + 60_000);
  const second = new Scheduler({
    triggers: [trigger],
    state: persisted,
    now: secondTimers.now,
    timers: secondTimers,
    persist: () => undefined,
    onTrigger: () => {
      restartedCallbackRan = true;
    },
  });
  second.start();
  secondTimers.advance(60_000);

  assert.equal(
    restartedCallbackRan,
    false,
    'at-most-once does not replay an occurrence after the crash window',
  );
  second.stop();
});

test('a persisted at occurrence is not repeated after a restart', () => {
  const first = harness([atTrigger('once', START + 1000)]);
  first.scheduler.start();
  first.timers.advance(1000);
  assert.equal(first.fired.length, 1);
  const state = first.scheduler.exportState();
  first.scheduler.stop();

  const second = harness([atTrigger('once', START + 1000)], {
    start: START + 60_000,
    state,
  });
  second.scheduler.start();
  second.timers.advance(60_000);
  assert.equal(second.fired.length, 0);
  second.scheduler.stop();
});

test('an every trigger fires at each expected interval', () => {
  const testHarness = harness([everyTrigger('tick', 1000)]);

  testHarness.scheduler.start();
  testHarness.timers.advance(999);
  assert.equal(testHarness.fired.length, 0);

  testHarness.timers.advance(1);
  testHarness.timers.advance(1000);
  testHarness.timers.advance(1000);

  assert.deepEqual(testHarness.fired, [
    { id: 'tick', at: START + 1000 },
    { id: 'tick', at: START + 2000 },
    { id: 'tick', at: START + 3000 },
  ]);
  testHarness.scheduler.stop();
});

test('a missed every interval fires once on start and reschedules from now', () => {
  const first = harness([everyTrigger('tick', 1000)]);
  first.scheduler.start();
  first.timers.advance(1000);
  assert.equal(first.fired.length, 1);
  const state = first.scheduler.exportState();
  first.scheduler.stop();

  const restartAt = START + 5000;
  const second = harness([everyTrigger('tick', 1000)], { start: restartAt, state });
  second.scheduler.start();
  assert.equal(second.fired.length, 1, 'several missed intervals collapse into one');

  const everyState = second.scheduler.exportState().triggers['tick'];
  assert.ok(everyState !== undefined && everyState.kind === 'every');
  assert.equal(everyState.nextDueMs, restartAt + 1000);

  second.timers.advance(999);
  assert.equal(second.fired.length, 1);
  second.timers.advance(1);
  assert.equal(second.fired.length, 2);
  second.scheduler.stop();
});

test('a persisted every occurrence is not repeated after a restart', () => {
  const first = harness([everyTrigger('tick', 1000)]);
  first.scheduler.start();
  first.timers.advance(1000);
  assert.equal(first.fired.length, 1);
  const state = first.scheduler.exportState();
  first.scheduler.stop();

  const second = harness([everyTrigger('tick', 1000)], {
    start: START + 1500,
    state,
  });
  second.scheduler.start();
  second.timers.advance(499);
  assert.equal(second.fired.length, 0);
  second.timers.advance(1);
  assert.deepEqual(second.fired, [{ id: 'tick', at: START + 2000 }]);
  second.scheduler.stop();
});

test('shutdown stops future triggers', () => {
  const testHarness = harness([everyTrigger('tick', 1000)]);
  testHarness.scheduler.start();
  testHarness.scheduler.stop();

  testHarness.timers.advance(60_000);
  assert.equal(testHarness.fired.length, 0);
  assert.throws(() => testHarness.scheduler.start(), /already started|stopped/);

  const neverStarted = harness([everyTrigger('tick', 1000)]);
  neverStarted.scheduler.stop();
  assert.throws(() => neverStarted.scheduler.start(), /stopped/);
});

test('changing an every interval resets the schedule instead of reusing old state', () => {
  const stored = {
    schemaVersion: 1 as const,
    triggers: {
      tick: { kind: 'every' as const, everyMs: 1000, nextDueMs: START + 1000 },
    },
  };
  const testHarness = harness([everyTrigger('tick', 5000)], { state: stored });

  testHarness.scheduler.start();
  testHarness.timers.advance(4999);
  assert.equal(testHarness.fired.length, 0);
  testHarness.timers.advance(1);
  assert.deepEqual(testHarness.fired, [{ id: 'tick', at: START + 5000 }]);
  testHarness.scheduler.stop();
});

test('scheduler state survives the Honey store and rejects corruption', () => {
  const root = mkdtempSync(join(tmpdir(), 'wax-scheduler-state-'));
  const store = HoneyStore.forComposition(root, 'apiary', 'scheduled');
  const state = {
    schemaVersion: 1 as const,
    triggers: {
      once: { kind: 'at' as const, at: '2026-11-06T09:00:00-05:00', fired: true },
      tick: { kind: 'every' as const, everyMs: 1000, nextDueMs: START + 1000 },
    },
  };

  store.saveScheduler(state);
  assert.deepEqual(store.loadScheduler(), state);
  assert.equal(store.paths.scheduler, join(pathsDirectory(root), 'honey', 'scheduler.json'));

  writeFileSync(store.paths.scheduler, '{ not json');
  assert.throws(() => store.loadScheduler(), /not valid JSON/);
});

test('parseSchedulerState rejects malformed entries', () => {
  assert.throws(() => parseSchedulerState({ schemaVersion: 2, triggers: {} }), /schemaVersion/);
  assert.throws(
    () => parseSchedulerState({ schemaVersion: 1, triggers: { t: { kind: 'at', fired: false } } }),
    /at must be a timestamp/,
  );
  assert.throws(
    () =>
      parseSchedulerState({
        schemaVersion: 1,
        triggers: { t: { kind: 'every', everyMs: 10, nextDueMs: START } },
      }),
    /everyMs/,
  );
});

function pathsDirectory(root: string): string {
  return honeyPaths(root, 'apiary', 'scheduled').directory;
}
