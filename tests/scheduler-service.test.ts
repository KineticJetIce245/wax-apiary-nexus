import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  SchedulerState,
  SchedulerTimers,
  SchedulerUnconfirmedOccurrence,
} from '../src/daemon/scheduler.js';
import { SchedulerService } from '../src/daemon/scheduler-service.js';
import {
  parseComposition,
  type CompositionDefinition,
  type TriggerDefinition,
} from '../src/runtime/index.js';

const START = Date.parse('2026-11-15T12:00:00.000Z');

interface ScheduledTimer {
  readonly due: number;
  readonly handler: () => void;
}

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

function definition(triggers: readonly TriggerDefinition[]): CompositionDefinition {
  return parseComposition({
    schemaVersion: 1,
    id: 'scheduled',
    nodes: {
      only: { kind: 'forager', config: { connection: 'fake', prompt: 'go' } },
    },
    edges: [],
    triggers,
  });
}

function at(id: string, atMs: number): TriggerDefinition {
  return {
    id,
    target: 'only',
    schedule: { kind: 'at', at: new Date(atMs).toISOString() },
  };
}

function every(id: string, everyMs: number): TriggerDefinition {
  return { id, target: 'only', schedule: { kind: 'every', everyMs } };
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test('a due at trigger fires after the marker is persisted', async () => {
  const timers = new ManualTimers(START);
  const events: string[] = [];
  const fired: string[] = [];
  const service = new SchedulerService({ now: timers.now, timers });
  service.start(
    'live',
    definition([at('once', START - 1_000)]),
    {
      persist: () => {
        events.push('persist');
      },
    },
    async (trigger) => {
      events.push('fire');
      fired.push(trigger.id);
    },
  );

  await tick();
  assert.deepEqual(fired, ['once']);
  assert.equal(events[0], 'persist');
  assert.equal(events.at(-1), 'fire');
  service.stop('live');
  assert.equal(service.has('live'), false);
});

test('an every trigger fires on each due interval and stops cleanly', async () => {
  const timers = new ManualTimers(START);
  const fired: string[] = [];
  const service = new SchedulerService({ now: timers.now, timers });
  service.start(
    'live',
    definition([every('repeat', 1_000)]),
    { persist: () => undefined },
    async (trigger) => {
      fired.push(trigger.id);
    },
  );

  assert.deepEqual(fired, []);
  timers.advance(1_000);
  await tick();
  assert.deepEqual(fired, ['repeat']);
  timers.advance(1_000);
  await tick();
  assert.deepEqual(fired, ['repeat', 'repeat']);

  service.stop('live');
  timers.advance(5_000);
  await tick();
  assert.deepEqual(fired, ['repeat', 'repeat']);
});

test('an unconfirmed occurrence is reported once and never replayed', async () => {
  const timers = new ManualTimers(START);
  const state: SchedulerState = {
    schemaVersion: 1,
    triggers: {
      once: {
        kind: 'at',
        at: new Date(START - 1_000).toISOString(),
        fired: true,
        unconfirmed: { scheduledFor: new Date(START - 1_000).toISOString() },
      },
    },
  };
  const unconfirmed: SchedulerUnconfirmedOccurrence[] = [];
  const fired: string[] = [];
  const service = new SchedulerService({
    now: timers.now,
    timers,
    onUnconfirmed: (_graphId, _trigger, occurrence) => {
      unconfirmed.push(occurrence);
    },
  });
  service.start(
    'live',
    definition([at('once', START - 1_000)]),
    { state, persist: () => undefined },
    async (trigger) => {
      fired.push(trigger.id);
    },
  );

  await tick();
  assert.deepEqual(unconfirmed, [
    { scheduledFor: new Date(START - 1_000).toISOString() },
  ]);
  assert.deepEqual(fired, []);
});

test('a trigger callback failure is reported and does not stop later occurrences', async () => {
  const timers = new ManualTimers(START);
  const errors: unknown[] = [];
  const attempts: string[] = [];
  const service = new SchedulerService({
    now: timers.now,
    timers,
    onError: (_graphId, error) => {
      errors.push(error);
    },
  });
  service.start(
    'live',
    definition([every('repeat', 1_000)]),
    { persist: () => undefined },
    async (trigger) => {
      attempts.push(trigger.id);
      throw new Error('trigger failed');
    },
  );

  timers.advance(1_000);
  await tick();
  assert.deepEqual(attempts, ['repeat']);
  assert.equal(errors.length, 1);

  timers.advance(1_000);
  await tick();
  assert.deepEqual(attempts, ['repeat', 'repeat']);
  assert.equal(errors.length, 2);
});

test('a scheduler whose marker cannot be persisted fails before firing', async () => {
  const timers = new ManualTimers(START);
  let fired = 0;
  const service = new SchedulerService({ now: timers.now, timers });
  assert.throws(
    () =>
      service.start(
        'live',
        definition([at('once', START - 1_000)]),
        {
          persist: () => {
            throw new Error('disk full');
          },
        },
        async () => {
          fired += 1;
        },
      ),
    /disk full/,
  );
  await tick();
  assert.equal(fired, 0);
  assert.equal(service.has('live'), false);
});

test('a graph without triggers creates no scheduler or writes', () => {
  const timers = new ManualTimers(START);
  let writes = 0;
  const service = new SchedulerService({ now: timers.now, timers });
  service.start(
    'live',
    definition([]),
    { persist: () => (writes += 1) },
    async () => undefined,
  );
  assert.equal(service.has('live'), false);
  assert.equal(writes, 0);
});

test('stopAll stops every graph timer', async () => {
  const timers = new ManualTimers(START);
  let fired = 0;
  const service = new SchedulerService({ now: timers.now, timers });
  const schedule = (id: string): void => {
    service.start(
      id,
      definition([every(id, 1_000)]),
      { persist: () => undefined },
      async () => {
        fired += 1;
      },
    );
  };
  schedule('a');
  schedule('b');
  service.stopAll();
  timers.advance(5_000);
  await tick();
  assert.equal(fired, 0);
  assert.equal(service.has('a'), false);
  assert.equal(service.has('b'), false);
});
