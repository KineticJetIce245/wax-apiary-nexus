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
  readonly persisted: SchedulerState[];
  readonly unconfirmed: { readonly id: string; readonly scheduledFor: string }[];
  readonly errors: { readonly error: unknown; readonly triggerId: string | undefined }[];
}

function harness(
  triggers: readonly TriggerDefinition[],
  options: {
    start?: number;
    state?: ReturnType<Scheduler['exportState']>;
    failPersistOn?: number;
    crashAfterPersistOn?: number;
    triggerError?: unknown;
  } = {},
): Harness {
  const start = options.start ?? START;
  const timers = new ManualTimers(start);
  const fired: { id: string; at: number }[] = [];
  const events: string[] = [];
  const persisted: SchedulerState[] = [];
  const unconfirmed: { id: string; scheduledFor: string }[] = [];
  const errors: { error: unknown; triggerId: string | undefined }[] = [];
  let writes = 0;
  const scheduler = new Scheduler({
    triggers,
    ...(options.state === undefined ? {} : { state: options.state }),
    now: timers.now,
    timers,
    persist: (state) => {
      writes += 1;
      if (options.failPersistOn !== undefined && writes === options.failPersistOn) {
        throw new Error('disk full');
      }
      events.push('persist');
      persisted.push(structuredClone(state));
      if (
        options.crashAfterPersistOn !== undefined &&
        writes === options.crashAfterPersistOn
      ) {
        // The write landed, then the process died before the next step.
        throw new Error('process died after the durable write');
      }
    },
    onTrigger: (trigger) => {
      events.push('trigger');
      fired.push({ id: trigger.id, at: timers.time });
      if (options.triggerError !== undefined) {
        throw options.triggerError;
      }
    },
    onUnconfirmed: (trigger, occurrence) => {
      events.push('unconfirmed');
      unconfirmed.push({ id: trigger.id, scheduledFor: occurrence.scheduledFor });
    },
    onError: (error, trigger) => {
      errors.push({ error, triggerId: trigger?.id });
    },
  });
  return { scheduler, timers, fired, events, persisted, unconfirmed, errors };
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

test('the occurrence and its marker are persisted before the trigger callback', () => {
  const testHarness = harness([atTrigger('past', START - 1000)]);

  testHarness.scheduler.start();

  assert.equal(testHarness.fired.length, 1);
  assert.deepEqual(testHarness.events, ['persist', 'persist', 'trigger', 'persist']);

  const marked = testHarness.persisted[1]?.triggers['past'];
  assert.ok(marked !== undefined && marked.kind === 'at');
  assert.deepEqual(marked.unconfirmed, {
    scheduledFor: new Date(START - 1000).toISOString(),
  });

  const cleared = testHarness.scheduler.exportState().triggers['past'];
  assert.ok(cleared !== undefined);
  assert.equal(cleared.unconfirmed, undefined);
  testHarness.scheduler.stop();
});

test('a successful callback clears its marker so a restart reports nothing', () => {
  const first = harness([atTrigger('once', START + 1000)]);
  first.scheduler.start();
  first.timers.advance(1000);

  assert.equal(first.fired.length, 1);
  assert.deepEqual(first.events.slice(-3), ['persist', 'trigger', 'persist']);
  const state = first.scheduler.exportState();
  first.scheduler.stop();

  const second = harness([atTrigger('once', START + 1000)], {
    start: START + 60_000,
    state,
  });
  second.scheduler.start();

  assert.deepEqual(second.unconfirmed, []);
  assert.deepEqual(second.fired, []);
  second.scheduler.stop();
});

test('a failed occurrence write never fires the trigger', () => {
  // start() writes the reconciled state first; fail the second (due) write.
  const testHarness = harness([atTrigger('past', START - 1000)], { failPersistOn: 2 });

  assert.throws(() => testHarness.scheduler.start(), /disk full/);
  assert.equal(testHarness.fired.length, 0);
  testHarness.scheduler.stop();
});

test('a crash after the marker write reports it once on restart and never replays it', () => {
  const trigger = atTrigger('past', START - 1000);
  const scheduledFor = new Date(START - 1000).toISOString();
  const first = harness([trigger], { crashAfterPersistOn: 2 });

  assert.throws(() => first.scheduler.start(), /process died/);
  assert.deepEqual(first.fired, [], 'the callback never ran');
  assert.equal(first.persisted.length, 2);

  const disk = first.persisted[1];
  assert.ok(disk !== undefined);
  const marked = disk.triggers['past'];
  assert.ok(marked !== undefined && marked.kind === 'at');
  assert.equal(marked.fired, true);
  assert.deepEqual(marked.unconfirmed, { scheduledFor });

  const second = harness([trigger], { start: START + 60_000, state: disk });
  second.scheduler.start();
  second.timers.advance(60_000);

  assert.deepEqual(second.unconfirmed, [{ id: 'past', scheduledFor }]);
  assert.deepEqual(second.fired, [], 'an unconfirmed occurrence is never replayed');
  assert.deepEqual(second.events, ['persist', 'unconfirmed', 'persist']);
  assert.equal(second.persisted.at(-1)?.triggers['past']?.unconfirmed, undefined);
  second.scheduler.stop();
});

test('a callback that ran before the clear write failed is reported but not rerun', () => {
  const trigger = atTrigger('past', START - 1000);
  const scheduledFor = new Date(START - 1000).toISOString();
  // The third write is the post-callback clear; fail it before it lands.
  const first = harness([trigger], { failPersistOn: 3 });

  assert.throws(() => first.scheduler.start(), /disk full/);
  assert.equal(first.fired.length, 1, 'the callback already ran');
  assert.equal(first.persisted.length, 2);
  assert.deepEqual(first.events.slice(-2), ['persist', 'trigger']);

  const disk = first.persisted[1];
  assert.ok(disk !== undefined);
  const marked = disk.triggers['past'];
  assert.ok(marked !== undefined && marked.kind === 'at');
  assert.deepEqual(marked.unconfirmed, { scheduledFor });

  const second = harness([trigger], { start: START + 60_000, state: disk });
  second.scheduler.start();
  second.timers.advance(60_000);

  assert.deepEqual(second.unconfirmed, [{ id: 'past', scheduledFor }]);
  assert.deepEqual(second.fired, [], 'the callback is never rerun after the crash');
  assert.equal(second.persisted.at(-1)?.triggers['past']?.unconfirmed, undefined);
  second.scheduler.stop();
});

test('a throwing trigger callback is reported and still clears its marker', () => {
  const first = harness([atTrigger('past', START - 1000)], {
    triggerError: new Error('boom'),
  });
  first.scheduler.start();

  assert.equal(first.fired.length, 1);
  assert.equal(first.errors.length, 1);
  assert.equal(first.errors[0]?.triggerId, 'past');
  assert.match(String(first.errors[0]?.error), /boom/);
  assert.equal(first.events.at(-1), 'persist');
  assert.equal(first.scheduler.exportState().triggers['past']?.unconfirmed, undefined);
  const state = first.scheduler.exportState();
  first.scheduler.stop();

  const second = harness([atTrigger('past', START - 1000)], {
    start: START + 60_000,
    state,
  });
  second.scheduler.start();

  assert.deepEqual(second.unconfirmed, []);
  assert.deepEqual(second.fired, []);
  second.scheduler.stop();
});

test('a failed unconfirmed clear write leaves the marker for the next start', () => {
  const trigger = atTrigger('past', START - 1000);
  const scheduledFor = new Date(START - 1000).toISOString();
  const stored = {
    schemaVersion: 1 as const,
    triggers: {
      past: { kind: 'at' as const, at: scheduledFor, fired: true, unconfirmed: { scheduledFor } },
    },
  };
  // The first write is the startup persist; the second is the clear.
  const first = harness([trigger], { state: stored, failPersistOn: 2 });

  assert.throws(() => first.scheduler.start(), /disk full/);
  assert.deepEqual(first.unconfirmed, [{ id: 'past', scheduledFor }]);
  assert.deepEqual(first.fired, []);
  assert.equal(first.persisted.length, 1);
  assert.equal(first.persisted[0]?.triggers['past']?.unconfirmed?.scheduledFor, scheduledFor);

  const retryState = first.persisted[0];
  assert.ok(retryState !== undefined);
  const second = harness([trigger], { start: START + 60_000, state: retryState });
  second.scheduler.start();

  assert.deepEqual(second.unconfirmed, [{ id: 'past', scheduledFor }]);
  assert.deepEqual(second.fired, []);
  second.scheduler.stop();
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

test('an every marker records the due time before it is advanced', () => {
  const nextDueMs = START + 1000;
  const testHarness = harness([everyTrigger('tick', 1000)], {
    start: START + 5000,
    state: {
      schemaVersion: 1,
      triggers: { tick: { kind: 'every', everyMs: 1000, nextDueMs } },
    },
  });

  testHarness.scheduler.start();

  assert.equal(testHarness.fired.length, 1);
  const marked = testHarness.persisted[1]?.triggers['tick'];
  assert.ok(marked !== undefined && marked.kind === 'every');
  assert.deepEqual(marked.unconfirmed, {
    scheduledFor: new Date(nextDueMs).toISOString(),
  });

  const after = testHarness.scheduler.exportState().triggers['tick'];
  assert.ok(after !== undefined && after.kind === 'every');
  assert.equal(after.nextDueMs, START + 5000 + 1000);
  assert.equal(after.unconfirmed, undefined);
  testHarness.scheduler.stop();
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

test('a changed schedule discards an unconfirmed marker instead of reporting it', () => {
  const oldAt = new Date(START - 5000).toISOString();
  const stored = {
    schemaVersion: 1 as const,
    triggers: {
      once: {
        kind: 'at' as const,
        at: oldAt,
        fired: true,
        unconfirmed: { scheduledFor: oldAt },
      },
    },
  };

  const changed = harness([atTrigger('once', START + 1000)], { state: stored });
  changed.scheduler.start();
  assert.deepEqual(changed.unconfirmed, []);
  changed.timers.advance(1000);
  assert.deepEqual(changed.fired, [{ id: 'once', at: START + 1000 }]);
  changed.scheduler.stop();

  const unchanged = harness([atTrigger('once', START - 5000)], { state: stored });
  unchanged.scheduler.start();
  assert.deepEqual(unchanged.unconfirmed, [{ id: 'once', scheduledFor: oldAt }]);
  assert.deepEqual(unchanged.fired, []);
  unchanged.scheduler.stop();
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

test('parseSchedulerState accepts legacy state without unconfirmed markers', () => {
  const parsed = parseSchedulerState({
    schemaVersion: 1,
    triggers: {
      once: { kind: 'at', at: '2026-11-05T12:00:00.000Z', fired: true },
      tick: { kind: 'every', everyMs: 1000, nextDueMs: START + 1000 },
    },
  });

  assert.equal(parsed.triggers['once']?.unconfirmed, undefined);
  assert.equal(parsed.triggers['tick']?.unconfirmed, undefined);
});

test('parseSchedulerState rejects malformed unconfirmed markers', () => {
  const at = { kind: 'at', at: '2026-11-05T12:00:00.000Z', fired: true };
  for (const bad of [
    null,
    'marker',
    {},
    { scheduledFor: 123 },
    { scheduledFor: '' },
    { scheduledFor: 'not-a-date' },
  ]) {
    assert.throws(
      () =>
        parseSchedulerState({
          schemaVersion: 1,
          triggers: { once: { ...at, unconfirmed: bad } },
        }),
      /unconfirmed/,
    );
  }

  assert.throws(
    () =>
      parseSchedulerState({
        schemaVersion: 1,
        triggers: {
          tick: {
            kind: 'every',
            everyMs: 1000,
            nextDueMs: START,
            unconfirmed: { scheduledFor: 123 },
          },
        },
      }),
    /scheduledFor/,
  );
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
