import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AdapterPool,
  HarnessUnavailableError,
} from '../src/session/adapter-pool.js';
import { Workspace } from '../src/session/workspace.js';
import { FakeAdapter } from './support/fake-adapter.js';

class LifecycleAdapter extends FakeAdapter {
  constructor(
    readonly harness: string,
    protected readonly events: string[],
  ) {
    super();
  }

  override async start(): Promise<void> {
    this.events.push(`start:${this.harness}`);
    await super.start();
  }

  override async stop(): Promise<void> {
    this.events.push(`stop:${this.harness}`);
    await super.stop();
  }
}

class FailingStartAdapter extends LifecycleAdapter {
  override async start(): Promise<void> {
    this.events.push(`fail:${this.harness}`);
    this.startCalls += 1;
    throw new Error('NATIVE_START_SECRET');
  }
}

function poolWith(
  events: string[],
  failHarnesses: ReadonlySet<string> = new Set(),
): { readonly pool: AdapterPool; readonly adapters: Map<string, LifecycleAdapter> } {
  const adapters = new Map<string, LifecycleAdapter>();
  const pool = new AdapterPool({
    createAdapter: (harness) => {
      const adapter = failHarnesses.has(harness)
        ? new FailingStartAdapter(harness, events)
        : new LifecycleAdapter(harness, events);
      adapters.set(harness, adapter);
      return adapter;
    },
  });
  return { pool, adapters };
}

test('starts one adapter and Workspace per harness and is idempotent', async (t) => {
  const events: string[] = [];
  const { pool, adapters } = poolWith(events);
  t.after(() => pool.stop());

  await pool.start(['codex', 'dsh']);
  await pool.start(['codex', 'dsh']);

  assert.deepEqual(pool.harnesses(), ['codex', 'dsh']);
  assert.deepEqual(events, ['start:codex', 'start:dsh']);
  assert.equal(pool.adapterFor('codex'), adapters.get('codex'));
  assert.equal(pool.adapterFor('dsh'), adapters.get('dsh'));
  assert.ok(pool.workspaceFor('codex') instanceof Workspace);
  assert.notEqual(pool.workspaceFor('codex'), pool.workspaceFor('dsh'));

  assert.throws(
    () => pool.adapterFor('unknown'),
    (error: unknown) => {
      assert.ok(error instanceof HarnessUnavailableError);
      assert.equal(error.harness, 'unknown');
      assert.equal(error.reason, 'not-started');
      return true;
    },
  );
  assert.throws(() => pool.workspaceFor('unknown'), HarnessUnavailableError);
});

test('stops in reverse start order and is idempotent', async (t) => {
  const events: string[] = [];
  const { pool } = poolWith(events);
  t.after(() => pool.stop());

  await pool.start(['codex', 'dsh']);
  await pool.stop();
  await pool.stop();

  assert.deepEqual(events, [
    'start:codex',
    'start:dsh',
    'stop:dsh',
    'stop:codex',
  ]);
  assert.deepEqual(pool.harnesses(), []);
  assert.throws(
    () => pool.adapterFor('codex'),
    (error: unknown) => {
      assert.ok(error instanceof HarnessUnavailableError);
      assert.equal(error.reason, 'stopped');
      return true;
    },
  );
  await assert.rejects(pool.start(['codex']), /AdapterPool has been stopped/);
});

test('one adapter failure marks only that harness unavailable', async (t) => {
  const events: string[] = [];
  const { pool, adapters } = poolWith(events, new Set(['codex']));
  t.after(() => pool.stop());

  await pool.start(['codex', 'dsh']);

  assert.deepEqual(pool.harnesses(), ['dsh']);
  assert.equal(pool.adapterFor('dsh'), adapters.get('dsh'));
  assert.throws(
    () => pool.adapterFor('codex'),
    (error: unknown) => {
      assert.ok(error instanceof HarnessUnavailableError);
      assert.equal(error.harness, 'codex');
      assert.equal(error.reason, 'start-failed');
      // The native error text is not forwarded.
      assert.equal(error.message.includes('NATIVE_START_SECRET'), false);
      return true;
    },
  );
  assert.throws(
    () => pool.workspaceFor('codex'),
    (error: unknown) => error instanceof HarnessUnavailableError,
  );

  // A later start does not retry the failed harness.
  await pool.start(['codex']);
  assert.deepEqual(events, ['fail:codex', 'stop:codex', 'start:dsh']);
});

test('a failing start does not prevent the remaining harnesses from stopping', async (t) => {
  const events: string[] = [];
  const { pool } = poolWith(events, new Set(['codex']));
  t.after(() => pool.stop());

  await pool.start(['codex', 'dsh']);
  await pool.stop();

  assert.deepEqual(events, [
    'fail:codex',
    'stop:codex',
    'start:dsh',
    'stop:dsh',
  ]);
});

test('start with duplicate names creates one adapter', async (t) => {
  const events: string[] = [];
  const { pool } = poolWith(events);
  t.after(() => pool.stop());

  await pool.start(['codex', 'codex']);

  assert.deepEqual(pool.harnesses(), ['codex']);
  assert.deepEqual(events, ['start:codex']);
});

test('concurrent start calls serialize and create one adapter per harness', async (t) => {
  const events: string[] = [];
  const { pool, adapters } = poolWith(events);
  t.after(() => pool.stop());

  await Promise.all([pool.start(['codex', 'dsh']), pool.start(['codex', 'dsh'])]);

  assert.deepEqual(pool.harnesses(), ['codex', 'dsh']);
  assert.deepEqual(events, ['start:codex', 'start:dsh']);
  assert.equal(adapters.size, 2);
});
