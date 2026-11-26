import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { LiveHiveHost } from '../src/daemon/graph-host.js';
import type { SchedulerTimers } from '../src/daemon/scheduler.js';
import type { GraphBindings } from '../src/graph/binding.js';
import type { Project } from '../src/project/kernel.js';
import { parseComposition } from '../src/runtime/index.js';
import { SessionRegistry } from '../src/session/session-registry.js';
import { Workspace } from '../src/session/workspace.js';
import { HoneyStore } from '../src/storage/honey.js';
import { FakeAdapter } from './support/fake-adapter.js';

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

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for scheduler trigger');
}

test('a loaded graph starts its Honey-backed scheduler and unload stops it', async (t) => {
  const adapter = new FakeAdapter({ output: 'scheduled output' });
  const workspace = new Workspace(adapter);
  const project: Project = {
    id: 'project-scheduler',
    directory: mkdtempSync(join(tmpdir(), 'wax-m9d-scheduler-project-')),
  };
  const registry = new SessionRegistry({
    workspaces: new Map([['fake', workspace]]),
  });
  const stateRoot = mkdtempSync(join(tmpdir(), 'wax-m9d-scheduler-state-'));
  const honey = HoneyStore.forComposition(stateRoot, 'apiary', 'scheduled');
  const timers = new ManualTimers(START);
  const host = new LiveHiveHost({
    registry,
    honeyForGraph: () => honey,
    now: timers.now,
    schedulerTimers: timers,
  });
  t.after(async () => {
    await host.dispose();
    await workspace.stop();
  });

  const definition = parseComposition({
    schemaVersion: 1,
    id: 'scheduled',
    nodes: {
      only: { kind: 'forager', config: { connection: 'fake', prompt: 'tick {{message}}' } },
    },
    edges: [],
    triggers: [{ id: 'tick', target: 'only', schedule: { kind: 'every', everyMs: 1_000 } }],
  });
  const bindings: GraphBindings = { only: { kind: 'fresh' } };
  await host.loadGraph({ definition, bindings, project });

  timers.advance(1_000);
  await waitFor(() => adapter.prompts.length === 1);
  await waitFor(() => host.statusOf('scheduled')?.rest === true);
  assert.match(adapter.prompts[0] ?? '', /tick/);

  const stored = honey.loadScheduler();
  assert.equal(stored?.triggers['tick']?.kind, 'every');
  if (stored?.triggers['tick']?.kind === 'every') {
    assert.equal(stored.triggers['tick'].unconfirmed, undefined);
    assert.equal(stored.triggers['tick'].nextDueMs, START + 2_000);
  }
  assert.equal(
    readFileSync(honey.paths.scheduler, 'utf8').includes('tick'),
    true,
  );

  assert.equal(await host.unload('scheduled'), true);
  timers.advance(5_000);
  await assert.rejects(
    waitFor(() => adapter.prompts.length > 1, 250),
    /timed out waiting for scheduler trigger/,
  );
  assert.equal(adapter.prompts.length, 1);
});

test('a graph without triggers starts no scheduler file', async (t) => {
  const adapter = new FakeAdapter();
  const workspace = new Workspace(adapter);
  const project: Project = {
    id: 'project-no-scheduler',
    directory: mkdtempSync(join(tmpdir(), 'wax-m9d-no-scheduler-project-')),
  };
  const registry = new SessionRegistry({
    workspaces: new Map([['fake', workspace]]),
  });
  const stateRoot = mkdtempSync(join(tmpdir(), 'wax-m9d-no-scheduler-state-'));
  const honey = HoneyStore.forComposition(stateRoot, 'apiary', 'no-scheduler');
  const timers = new ManualTimers(START);
  const host = new LiveHiveHost({
    registry,
    honeyForGraph: () => honey,
    now: timers.now,
    schedulerTimers: timers,
  });
  t.after(async () => {
    await host.dispose();
    await workspace.stop();
  });

  const definition = parseComposition({
    schemaVersion: 1,
    id: 'no-scheduler',
    nodes: {
      only: { kind: 'forager', config: { connection: 'fake', prompt: 'go' } },
    },
    edges: [],
  });
  await host.loadGraph({
    definition,
    bindings: { only: { kind: 'fresh' } },
    project,
  });
  assert.equal(
    (() => {
      try {
        readFileSync(honey.paths.scheduler);
        return true;
      } catch {
        return false;
      }
    })(),
    false,
  );
});
