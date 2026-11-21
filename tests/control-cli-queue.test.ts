import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runCli } from '../src/cli/cli.js';
import { runQueueCli } from '../src/cli/queue-cli.js';
import {
  assertNoSecret,
  invokeControl,
  singleJson,
} from './support/control-cli-fixtures.js';

const TOKEN = 'queue-token-0123456789';
const FIXED_PORT = 45_999;
const BASE_URL = `http://127.0.0.1:${String(FIXED_PORT)}`;

interface FakeDaemon {
  readonly dir: string;
}

/**
 * A daemon directory discovery accepts. The HTTP transport is always faked, so
 * no server is started and nothing is bound on `FIXED_PORT`.
 */
function fakeDaemon(): FakeDaemon {
  const dir = mkdtempSync(join(tmpdir(), 'wax-cli-queue-'));
  writeFileSync(join(dir, 'token'), TOKEN, 'utf8');
  writeFileSync(
    join(dir, 'server.json'),
    JSON.stringify({
      url: BASE_URL,
      host: '127.0.0.1',
      port: FIXED_PORT,
      pid: 1,
      startedAt: '2026-11-19T00:00:00.000Z',
      tokenPath: join(dir, 'token'),
    }),
    'utf8',
  );
  return { dir };
}

interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | null;
}

interface FakeHttp {
  readonly fetchImpl: typeof fetch;
  readonly requests: RecordedRequest[];
}

/** Fake control HTTP that records every attempt so retries are observable. */
function fakeHttp(status: number, body: unknown): FakeHttp {
  const requests: RecordedRequest[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    requests.push({
      method: init?.method ?? 'GET',
      url: String(input),
      authorization: headers.get('authorization'),
    });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

interface QueueItemFixture {
  readonly queueId: string;
  readonly liveId: string;
  readonly beeId: string;
  readonly sessionId: string;
  readonly status: string;
  readonly position?: number;
  readonly runId?: string;
  readonly error?: string;
}

function item(overrides: Partial<QueueItemFixture> = {}): QueueItemFixture {
  return {
    queueId: 'q-1',
    liveId: 'live-a',
    beeId: 'only',
    sessionId: 'session-1',
    status: 'queued',
    ...overrides,
  };
}

function statusInvocation(
  daemon: FakeDaemon,
  http: FakeHttp,
  extra: readonly string[],
  queueId = 'q-1',
) {
  return invokeControl(runQueueCli, ['queue', 'status', queueId, ...extra], {
    daemonDir: daemon.dir,
    fetchImpl: http.fetchImpl,
  });
}

test('wax queue status reports a queued item in text and JSON', async () => {
  const daemon = fakeDaemon();
  const queued = item({ position: 2 });

  const textHttp = fakeHttp(200, { ok: true, queue: queued });
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCli(
    ['queue', 'status', 'q-1', '--daemon-dir', daemon.dir],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      env: {},
      fetchImpl: textHttp.fetchImpl,
    },
  );
  assert.equal(code, 0, stderr.join(' | '));
  assert.deepEqual(stdout, ['q-1 queued position=2']);
  assert.equal(stderr.length, 0);
  assertNoSecret(stdout, TOKEN);
  assert.equal(textHttp.requests.length, 1, 'a queue read must not be retried');
  assert.equal(textHttp.requests[0]?.method, 'GET');
  assert.equal(textHttp.requests[0]?.url, `${BASE_URL}/queues/q-1`);
  assert.equal(textHttp.requests[0]?.authorization, `Bearer ${TOKEN}`);

  const jsonHttp = fakeHttp(200, { ok: true, queue: queued });
  const json = await statusInvocation(daemon, jsonHttp, ['--json']);
  assert.deepEqual(singleJson(json), queued);
  assert.equal(jsonHttp.requests.length, 1);
  assertNoSecret(json.stdout, TOKEN);
});

test('wax queue status prints running, completed and dropped items', async () => {
  const daemon = fakeDaemon();
  const cases: readonly { readonly queue: QueueItemFixture; readonly line: string }[] = [
    {
      queue: item({ queueId: 'q-run', status: 'running', runId: 'run-1' }),
      line: 'q-run running runId=run-1',
    },
    {
      queue: item({ queueId: 'q-done', status: 'completed', runId: 'run-2' }),
      line: 'q-done completed runId=run-2',
    },
    {
      queue: item({ queueId: 'q-drop', status: 'dropped', error: 'wait timeout' }),
      line: 'q-drop dropped',
    },
    {
      queue: item({
        queueId: 'q-mixed',
        status: 'running',
        position: 0,
        runId: 'run-3',
      }),
      line: 'q-mixed running position=0 runId=run-3',
    },
  ];

  for (const entry of cases) {
    const http = fakeHttp(200, { ok: true, queue: entry.queue });
    const text = await statusInvocation(daemon, http, [], entry.queue.queueId);
    assert.equal(text.code, 0, text.stderr.join(' | '));
    assert.deepEqual(text.stdout, [entry.line]);
    assert.equal(text.stderr.length, 0);
    assert.equal(http.requests.length, 1, `${entry.queue.queueId} was retried`);
    assert.equal(http.requests[0]?.url, `${BASE_URL}/queues/${entry.queue.queueId}`);

    const json = await statusInvocation(daemon, fakeHttp(200, { ok: true, queue: entry.queue }), [
      '--json',
    ], entry.queue.queueId);
    assert.deepEqual(singleJson(json), entry.queue);
  }
});

test('wax queue status maps an unknown id to exit 1 without retrying', async () => {
  const daemon = fakeDaemon();
  const http = fakeHttp(404, { ok: false, code: 'not-found', message: 'unknown queue item' });

  const invocation = await statusInvocation(daemon, http, [], 'missing-queue');
  assert.equal(invocation.code, 1);
  assert.deepEqual(invocation.stdout, []);
  assert.deepEqual(invocation.stderr, ["error: queue item 'missing-queue' is unknown"]);
  assert.equal(http.requests.length, 1, 'a 404 queue read must not be retried');
  assertNoSecret(invocation.stderr, TOKEN);
  assertNoSecret(invocation.stdout, TOKEN);
});

test('wax queue usage errors exit 2 before discovery and help advertises queue', async () => {
  const daemon = fakeDaemon();
  const http = fakeHttp(500, { ok: false });
  const cases: (readonly string[])[] = [
    ['queue'],
    ['queue', 'bogus'],
    ['queue', 'status'],
    ['queue', 'status', 'q-1', 'q-2'],
    ['queue', 'status', ''],
    ['queue', 'status', 'q-1', '--wat'],
    ['queue', 'status', 'q-1', '--json', '--json'],
    ['queue', 'status', 'bad\u0000id'],
    ['queue', 'status', `${'x'.repeat(513)}`],
  ];
  for (const argv of cases) {
    const invocation = await invokeControl(runQueueCli, argv, {
      daemonDir: daemon.dir,
      fetchImpl: http.fetchImpl,
    });
    assert.equal(invocation.code, 2, argv.join(' '));
    assert.equal(invocation.stdout.length, 0, argv.join(' '));
    assert.equal(invocation.stderr.length, 1, argv.join(' '));
  }
  assert.equal(http.requests.length, 0, 'usage errors must not contact a daemon');

  const directStdout: string[] = [];
  const directStderr: string[] = [];
  const missingValue = await runQueueCli(
    ['queue', 'status', 'q-1', '--daemon-dir'],
    {
      stdout: (line) => directStdout.push(line),
      stderr: (line) => directStderr.push(line),
      env: {},
      fetchImpl: http.fetchImpl,
    },
  );
  assert.equal(missingValue, 2);
  assert.deepEqual(directStdout, []);
  assert.equal(directStderr.length, 1);
  assert.equal(http.requests.length, 0);

  const helpStderr: string[] = [];
  const helpCode = await runCli(['--help'], {
    stdout: () => undefined,
    stderr: (line) => helpStderr.push(line),
    env: {},
  });
  assert.equal(helpCode, 2);
  assert.match(helpStderr[0] as string, /usage: wax <waxd\|session\|live\|wake/);
  assert.match(helpStderr[0] as string, /\|queue\|guard>/);

  const unroutedStderr: string[] = [];
  const unroutedCode = await runCli(['queue'], {
    stdout: () => undefined,
    stderr: (line) => unroutedStderr.push(line),
    env: {},
  });
  assert.equal(unroutedCode, 2);
  assert.match(unroutedStderr[0] as string, /usage: wax queue status/);
});
