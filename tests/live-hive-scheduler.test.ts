import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { GraphHost } from '../src/daemon/graph-host.js';
import type { SchedulerTimers } from '../src/daemon/scheduler.js';
import { LiveHiveService } from '../src/b/live-hive-service.js';
import type { LiveHive } from '../src/b/types.js';
import type { Project } from '../src/project/kernel.js';
import { SessionRegistry } from '../src/session/session-registry.js';
import { Workspace } from '../src/session/workspace.js';
import { FakeAdapter } from './support/fake-adapter.js';

const START = Date.parse('2026-11-15T12:00:00.000Z');

class ManualTimers implements SchedulerTimers {
  time: number;
  private nextId = 1;
  private readonly timers = new Map<number, { due: number; handler: () => void }>();

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

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for B scheduler trigger');
}

function liveWith(schedules: LiveHive['schedules']): LiveHive {
  return {
    schemaVersion: 1,
    liveId: 'scheduled-live',
    bees: {
      only: {
        kind: 'forager',
        config: { connection: 'fake', prompt: 'tick {{input}}' },
        outgoing: [],
      },
    },
    beelines: {},
    bindings: {},
    ...(schedules === undefined ? {} : { schedules }),
  };
}

async function setupScheduler(
  t: TestContext,
  adapterOptions: ConstructorParameters<typeof FakeAdapter>[0] = { output: 'scheduled output' },
): Promise<{
  readonly adapter: FakeAdapter;
  readonly host: GraphHost;
  readonly service: LiveHiveService;
  readonly timers: ManualTimers;
}> {
  const adapter = new FakeAdapter(adapterOptions);
  const workspace = new Workspace(adapter);
  const project: Project = {
    id: 'project-b-scheduler',
    directory: mkdtempSync(join(tmpdir(), 'wax-m10b1-project-')),
  };
  const registry = new SessionRegistry({
    workspaces: new Map([['fake', workspace]]),
  });
  const timers = new ManualTimers(START);
  const host = new GraphHost({
    registry,
    now: timers.now,
    schedulerTimers: timers,
  });
  t.after(async () => {
    await host.dispose();
    await workspace.stop();
  });
  const service = new LiveHiveService({
    graphHost: host,
    registry,
    livesRoot: join(mkdtempSync(join(tmpdir(), 'wax-m10b1-state-')), 'lives'),
    defaultProject: project,
  });
  return { adapter, host, service, timers };
}

test('B at schedule wakes once on the fake clock', async (t) => {
  const { adapter, service, timers } = await setupScheduler(t);
  await service.new(
    liveWith([
      {
        scheduleId: 'once',
        targetBee: 'only',
        at: new Date(START + 1_000).toISOString(),
      },
    ]),
  );
  timers.advance(1_000);
  await waitFor(() => adapter.prompts.length === 1);
  assert.equal(adapter.prompts.length, 1);
  assert.match(adapter.prompts[0] ?? '', /tick/);
});

test('B every schedule failure is not replayed within one occurrence', async (t) => {
  const { adapter, service, timers } = await setupScheduler(t, {
    terminal: 'failed',
    error: 'scheduled failure',
  });
  await service.new(
    liveWith([{ scheduleId: 'tick', targetBee: 'only', everyMs: 1_000 }]),
  );
  timers.advance(1_000);
  await waitFor(() => adapter.prompts.length === 1);
  await new Promise<void>((resolve) => setTimeout(resolve, 100));
  assert.equal(adapter.prompts.length, 1);
});

test('B every schedule wakes twice and stops on unload', async (t) => {
  const { adapter, host, service, timers } = await setupScheduler(t);
  await service.new(
    liveWith([{ scheduleId: 'tick', targetBee: 'only', everyMs: 1_000 }]),
  );
  timers.advance(1_000);
  await waitFor(() => adapter.prompts.length === 1);
  timers.advance(1_000);
  await waitFor(() => adapter.prompts.length === 2);
  assert.equal(adapter.prompts.length, 2);

  assert.equal(await host.unload('scheduled-live'), true);
  timers.advance(5_000);
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  assert.equal(adapter.prompts.length, 2);
});
