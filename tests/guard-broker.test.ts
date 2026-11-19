import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GuardAlreadySettledError,
  GuardBroker,
  GuardExpiredError,
  GuardNotFoundError,
} from '../src/control/guard-broker.js';
import type { GuardRequest } from '../src/runtime/index.js';

const FIXED_NOW = Date.parse('2026-11-15T12:00:00.000Z');

function request(requestId = 'req-1'): GuardRequest {
  return {
    requestId,
    executionId: 'exec-1',
    summary: 'run a command',
    options: ['allow_once', 'reject_once'],
  };
}

function attributedRequest(requestId = 'req-attributed'): GuardRequest {
  return {
    ...request(requestId),
    liveId: 'live-1',
    beeId: 'bee-1',
    sessionId: 'session-1',
  };
}

test('list exposes live, bee and session attribution when the request has it', async () => {
  const broker = new GuardBroker({ now: () => FIXED_NOW });
  void broker.request(attributedRequest());

  assert.deepEqual(broker.list(), [
    {
      requestId: 'req-attributed',
      executionId: 'exec-1',
      summary: 'run a command',
      options: ['allow_once', 'reject_once'],
      createdAt: '2026-11-15T12:00:00.000Z',
      liveId: 'live-1',
      beeId: 'bee-1',
      sessionId: 'session-1',
    },
  ]);
  broker.cancelAll();
});

test('list omits attribution fields the request does not carry', async () => {
  const broker = new GuardBroker({ now: () => FIXED_NOW });
  void broker.request({ ...request(), liveId: 'live-only' });

  const [summary] = broker.list();
  assert.ok(summary !== undefined);
  assert.equal(summary.liveId, 'live-only');
  assert.equal(
    Object.hasOwn(summary, 'beeId'),
    false,
    'an unknown bee must be omitted, not set to an empty id',
  );
  assert.equal(Object.hasOwn(summary, 'sessionId'), false);
  broker.cancelAll();
});

test('request lists metadata and resolves an explicit decision', async () => {
  const broker = new GuardBroker({ now: () => FIXED_NOW });
  const pending = broker.request(request());

  assert.deepEqual(broker.list(), [
    {
      requestId: 'req-1',
      executionId: 'exec-1',
      summary: 'run a command',
      options: ['allow_once', 'reject_once'],
      createdAt: '2026-11-15T12:00:00.000Z',
    },
  ]);
  broker.decide('req-1', 'allow_once');
  assert.equal(await pending, 'allow_once');
  assert.deepEqual(broker.list(), []);
});

test('allow, reject and cancel are all explicit decisions', async () => {
  const broker = new GuardBroker();
  const allowed = broker.request(request('allow'));
  broker.decide('allow', 'allow_once');
  assert.equal(await allowed, 'allow_once');

  const rejected = broker.request(request('reject'));
  broker.decide('reject', 'reject_once');
  assert.equal(await rejected, 'reject_once');

  const cancelled = broker.request(request('cancel'));
  broker.decide('cancel', 'cancelled');
  assert.equal(await cancelled, 'cancelled');
});

test('unknown and duplicate decisions are distinct failures', async () => {
  const broker = new GuardBroker();
  assert.throws(() => broker.decide('missing', 'allow_once'), GuardNotFoundError);

  const pending = broker.request(request('once'));
  broker.decide('once', 'reject_once');
  assert.equal(await pending, 'reject_once');
  assert.throws(
    () => broker.decide('once', 'allow_once'),
    GuardAlreadySettledError,
  );
});

test('a pending request times out as cancelled, never allowed', async () => {
  const broker = new GuardBroker({ timeoutMs: 20 });
  const pending = broker.request(request('slow'));
  assert.equal(await pending, 'cancelled');
  assert.deepEqual(broker.list(), []);
  assert.throws(() => broker.decide('slow', 'allow_once'), GuardExpiredError);
});

test('expired, decided, cancelled and unknown requests stay distinct', async () => {
  const broker = new GuardBroker({ timeoutMs: 20 });

  const expired = broker.request(request('expired'));
  assert.equal(await expired, 'cancelled');
  assert.throws(() => broker.decide('expired', 'allow_once'), GuardExpiredError);

  const decided = broker.request(request('decided'));
  broker.decide('decided', 'reject_once');
  assert.equal(await decided, 'reject_once');
  assert.throws(() => broker.decide('decided', 'allow_once'), GuardAlreadySettledError);

  const cancelled = broker.request(request('cancelled'));
  broker.cancelAll();
  assert.equal(await cancelled, 'cancelled');
  assert.throws(
    () => broker.decide('cancelled', 'allow_once'),
    GuardAlreadySettledError,
    'shutdown cancellation is already-settled, not expired',
  );

  assert.throws(() => broker.decide('missing', 'allow_once'), GuardNotFoundError);
});

test('expire is idempotent and never overwrites a decision', async () => {
  const broker = new GuardBroker({ timeoutMs: 60_000 });

  const expired = broker.request(request('late-expire'));
  broker.expire('late-expire');
  broker.expire('late-expire');
  assert.equal(await expired, 'cancelled');
  assert.throws(() => broker.decide('late-expire', 'allow_once'), GuardExpiredError);

  const decided = broker.request(request('late-notification'));
  broker.decide('late-notification', 'allow_once');
  assert.equal(await decided, 'allow_once');
  // A late runtime expiry signal must not turn a real decision into expired.
  broker.expire('late-notification');
  assert.throws(
    () => broker.decide('late-notification', 'reject_once'),
    GuardAlreadySettledError,
  );
});

test('cancelAll cancels every pending request on shutdown', async () => {
  const broker = new GuardBroker();
  const first = broker.request(request('first'));
  const second = broker.request(request('second'));
  broker.cancelAll();
  assert.equal(await first, 'cancelled');
  assert.equal(await second, 'cancelled');
  assert.deepEqual(broker.list(), []);
});

test('a duplicate pending request is refused instead of replaced', () => {
  const broker = new GuardBroker();
  void broker.request(request('duplicate'));
  assert.throws(() => broker.request(request('duplicate')), /already pending/);
  broker.cancelAll();
});
