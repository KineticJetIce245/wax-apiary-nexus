import assert from 'node:assert/strict';
import test from 'node:test';

import { LiveHiveLock } from '../src/daemon/live-hive-lock.js';

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let settle: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return {
    promise,
    resolve: () => {
      settle?.();
    },
  };
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test('serializes operations for the same live id in call order', async () => {
  const lock = new LiveHiveLock();
  const events: string[] = [];
  const gate = deferred();

  const first = lock.run('alpha', async () => {
    events.push('first-start');
    await gate.promise;
    events.push('first-end');
    return 'first';
  });
  const second = lock.run('alpha', async () => {
    events.push('second');
    return 'second';
  });

  await tick();
  assert.deepEqual(events, ['first-start']);
  gate.resolve();
  assert.equal(await first, 'first');
  assert.equal(await second, 'second');
  assert.deepEqual(events, ['first-start', 'first-end', 'second']);
});

test('different live ids run in parallel', async () => {
  const lock = new LiveHiveLock();
  const alphaGate = deferred();
  const betaGate = deferred();
  const started: string[] = [];

  const alpha = lock.run('alpha', async () => {
    started.push('alpha');
    await alphaGate.promise;
    return 'a';
  });
  const beta = lock.run('beta', async () => {
    started.push('beta');
    await betaGate.promise;
    return 'b';
  });

  await tick();
  assert.deepEqual(started, ['alpha', 'beta']);
  alphaGate.resolve();
  betaGate.resolve();
  assert.equal(await alpha, 'a');
  assert.equal(await beta, 'b');
});

test('a rejected operation does not poison the next one', async () => {
  const lock = new LiveHiveLock();
  const calls: string[] = [];

  const failed = lock.run('alpha', async () => {
    calls.push('failed');
    throw new Error('boom');
  });
  const next = lock.run('alpha', async () => {
    calls.push('next');
    return 'ok';
  });

  await assert.rejects(failed, /boom/);
  assert.equal(await next, 'ok');
  assert.deepEqual(calls, ['failed', 'next']);
});

test('tryRun refuses a busy id and runs on an idle one', async () => {
  const lock = new LiveHiveLock();
  const gate = deferred();
  const first = lock.run('alpha', async () => {
    await gate.promise;
    return 'first';
  });

  const refused = await lock.tryRun('alpha', async () => 'should-not-run');
  assert.deepEqual(refused, { acquired: false });
  const other = await lock.tryRun('beta', async () => 'other');
  assert.deepEqual(other, { acquired: true, value: 'other' });

  gate.resolve();
  assert.equal(await first, 'first');
  const after = await lock.tryRun('alpha', async () => 'after');
  assert.deepEqual(after, { acquired: true, value: 'after' });
});

test('queue advances even when several operations reject', async () => {
  const lock = new LiveHiveLock();
  const calls: string[] = [];

  const first = lock.run('alpha', async () => {
    calls.push('first');
    throw new Error('first failed');
  });
  const second = lock.run('alpha', async () => {
    calls.push('second');
    return 2;
  });
  const third = lock.run('alpha', async () => {
    calls.push('third');
    throw new Error('third failed');
  });
  const fourth = lock.run('alpha', async () => {
    calls.push('fourth');
    return 4;
  });

  await assert.rejects(first, /first failed/);
  assert.equal(await second, 2);
  await assert.rejects(third, /third failed/);
  assert.equal(await fourth, 4);
  assert.deepEqual(calls, ['first', 'second', 'third', 'fourth']);
});
