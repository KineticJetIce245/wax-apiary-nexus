import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CodexAppServerAdapter } from '../src/adapters/codex/adapter.js';
import type { HarnessEvent } from '../src/adapters/harness.js';
import { SubmitOutcomeUnknownError } from '../src/adapters/harness.js';
import type { CodexLaunch } from '../src/session/connection.js';
import { ConversationBusyError, ConversationClosingError, Workspace } from '../src/session/workspace.js';
import { assertHarnessAdapterContract } from './support/harness-adapter-contract.js';
import {
  makeFakeServer,
  open,
  waitForEvent,
  delay,
} from './support/codex-adapter-fixtures.js';

test('streams assistant text once for a turn', async () => {
  const session = await open('happy');
  try {
    const nativeId = await session.adapter.createConversation({ id: 'p', directory: session.projectDir });
    await session.adapter.submit(nativeId, 'exec-1', 'hello');
    await waitForEvent(session.events, (event) => event.type === 'execution/completed');
    const text = session.events
      .filter((event) => event.type === 'execution/output' && event.channel === 'assistant')
      .map((event) => (event.type === 'execution/output' ? event.text : ''))
      .join('');
    assert.equal(text, 'hello');
  } finally {
    await session.adapter.stop();
  }
});

test('relays a command approval and maps allow_once to accept', async () => {
  const session = await open('approval');
  try {
    const nativeId = await session.adapter.createConversation({ id: 'p', directory: session.projectDir });
    await session.adapter.submit(nativeId, 'exec-1', 'run it');
    const requested = await waitForEvent(session.events, (event) => event.type === 'execution/approval-requested');
    assert.equal(requested.type, 'execution/approval-requested');
    if (requested.type !== 'execution/approval-requested') {
      return;
    }
    assert.match(requested.request.summary, /echo hi/);
    assert.deepEqual(requested.request.options.map((option) => option.kind), ['allow_once', 'reject_once']);
    await session.adapter.respondToApproval({ requestId: requested.request.requestId, kind: 'allow_once' });
    await waitForEvent(session.events, (event) => event.type === 'execution/completed');
    const text = session.events
      .filter((event) => event.type === 'execution/output')
      .map((event) => (event.type === 'execution/output' ? event.text : ''))
      .join('');
    assert.equal(text, 'decision=accept');
  } finally {
    await session.adapter.stop();
  }
});

test('maps reject_once to decline', async () => {
  const session = await open('deny');
  try {
    const nativeId = await session.adapter.createConversation({ id: 'p', directory: session.projectDir });
    await session.adapter.submit(nativeId, 'exec-1', 'run it');
    const requested = await waitForEvent(session.events, (event) => event.type === 'execution/approval-requested');
    if (requested.type !== 'execution/approval-requested') {
      return;
    }
    await session.adapter.respondToApproval({ requestId: requested.request.requestId, kind: 'reject_once' });
    await waitForEvent(session.events, (event) => event.type === 'execution/completed');
    const text = session.events
      .filter((event) => event.type === 'execution/output')
      .map((event) => (event.type === 'execution/output' ? event.text : ''))
      .join('');
    assert.equal(text, 'decision=decline');
  } finally {
    await session.adapter.stop();
  }
});

test('passes thread/start config through to Codex', async () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'uw-codex-config-project-'));
  const recordPath = join(projectDir, 'thread-start.json');
  const adapter = new CodexAppServerAdapter({
    launch: makeFakeServer('happy', recordPath),
    requestTimeoutMs: 2_000,
    config: { mcp_servers: { unified_delegate: { command: 'node' } } },
  });
  try {
    await adapter.start();
    await adapter.createConversation({ id: 'p', directory: projectDir });
    const recorded = JSON.parse(readFileSync(recordPath, 'utf8')) as {
      config?: unknown;
    };
    assert.deepEqual(recorded.config, {
      mcp_servers: { unified_delegate: { command: 'node' } },
    });
  } finally {
    await adapter.stop();
  }
});

test('maps permissions approval to a turn-scoped grant', async () => {
  const session = await open('permissions');
  try {
    const nativeId = await session.adapter.createConversation({ id: 'p', directory: session.projectDir });
    await session.adapter.submit(nativeId, 'exec-1', 'need network');
    const requested = await waitForEvent(session.events, (event) => event.type === 'execution/approval-requested');
    if (requested.type !== 'execution/approval-requested') {
      return;
    }
    assert.match(requested.request.summary, /permissions/);
    assert.match(requested.request.summary, /network/);
    assert.match(requested.request.summary, /enabled/);
    await session.adapter.respondToApproval({ requestId: requested.request.requestId, kind: 'allow_once' });
    await waitForEvent(session.events, (event) => event.type === 'execution/completed');
    const text = session.events
      .filter((event) => event.type === 'execution/output')
      .map((event) => (event.type === 'execution/output' ? event.text : ''))
      .join('');
    assert.equal(
      text,
      'result={"permissions":{"network":{"enabled":true}},"scope":"turn"}',
    );
  } finally {
    await session.adapter.stop();
  }
});

test('maps elicitation approval to accept with empty content', async () => {
  const session = await open('elicitation');
  try {
    const nativeId = await session.adapter.createConversation({ id: 'p', directory: session.projectDir });
    await session.adapter.submit(nativeId, 'exec-1', 'call tool');
    const requested = await waitForEvent(session.events, (event) => event.type === 'execution/approval-requested');
    if (requested.type !== 'execution/approval-requested') {
      return;
    }
    assert.match(requested.request.summary, /unified_delegate/);
    await session.adapter.respondToApproval({ requestId: requested.request.requestId, kind: 'allow_once' });
    await waitForEvent(session.events, (event) => event.type === 'execution/completed');
    const text = session.events
      .filter((event) => event.type === 'execution/output')
      .map((event) => (event.type === 'execution/output' ? event.text : ''))
      .join('');
    assert.equal(text, 'result={"action":"accept","content":{}}');
  } finally {
    await session.adapter.stop();
  }
});

test('declines an elicitation whose turn is not the active turn', async () => {
  const session = await open('elicitation-mismatch');
  try {
    const nativeId = await session.adapter.createConversation({ id: 'p', directory: session.projectDir });
    await session.adapter.submit(nativeId, 'exec-1', 'call tool');
    await waitForEvent(session.events, (event) => event.type === 'execution/completed');
    const requested = session.events.filter((event) => event.type === 'execution/approval-requested');
    assert.equal(requested.length, 0);
    const text = session.events
      .filter((event) => event.type === 'execution/output')
      .map((event) => (event.type === 'execution/output' ? event.text : ''))
      .join('');
    assert.equal(text, 'result={"action":"decline","content":null}');
  } finally {
    await session.adapter.stop();
  }
});

test('maps permissions and elicitation rejection to empty/decline shapes', async () => {
  for (const mode of ['permissions-deny', 'elicitation-deny']) {
    const session = await open(mode);
    try {
      const nativeId = await session.adapter.createConversation({ id: 'p', directory: session.projectDir });
      await session.adapter.submit(nativeId, 'exec-1', 'deny');
      const requested = await waitForEvent(session.events, (event) => event.type === 'execution/approval-requested');
      if (requested.type !== 'execution/approval-requested') {
        continue;
      }
      await session.adapter.respondToApproval({ requestId: requested.request.requestId, kind: 'reject_once' });
      await waitForEvent(session.events, (event) => event.type === 'execution/completed');
      const text = session.events
        .filter((event) => event.type === 'execution/output')
        .map((event) => (event.type === 'execution/output' ? event.text : ''))
        .join('');
      assert.equal(
        text,
        mode === 'permissions-deny'
          ? 'result={"permissions":{},"scope":"turn"}'
          : 'result={"action":"decline","content":null}',
      );
    } finally {
      await session.adapter.stop();
    }
  }
});

test('rejects a second submission while a turn is running', async () => {
  const session = await open('hang-turn');
  try {
    const nativeId = await session.adapter.createConversation({ id: 'p', directory: session.projectDir });
    await session.adapter.submit(nativeId, 'exec-1', 'first');
    await assert.rejects(session.adapter.submit(nativeId, 'exec-2', 'second'), /active execution/);
  } finally {
    await session.adapter.stop();
  }
});

test('cancels the active turn through turn/interrupt', async () => {
  const session = await open('hang-turn');
  try {
    const nativeId = await session.adapter.createConversation({ id: 'p', directory: session.projectDir });
    await session.adapter.submit(nativeId, 'exec-1', 'wait');
    await session.adapter.cancel(nativeId);
    await waitForEvent(session.events, (event) => event.type === 'execution/cancelled');
  } finally {
    await session.adapter.stop();
  }
});

test('fails the execution when the native turn fails', async () => {
  const session = await open('fail');
  try {
    const nativeId = await session.adapter.createConversation({ id: 'p', directory: session.projectDir });
    await session.adapter.submit(nativeId, 'exec-1', 'boom');
    const failed = await waitForEvent(session.events, (event) => event.type === 'execution/failed');
    assert.equal(failed.type, 'execution/failed');
    if (failed.type === 'execution/failed') {
      assert.equal(failed.error, 'boom');
    }
  } finally {
    await session.adapter.stop();
  }
});

test('marks an unrecognized turn status as unknown instead of completed', async () => {
  const session = await open('unknown-status');
  try {
    const nativeId = await session.adapter.createConversation({ id: 'p', directory: session.projectDir });
    await session.adapter.submit(nativeId, 'exec-1', 'mystery');
    await waitForEvent(session.events, (event) => event.type === 'execution/unknown');
    assert.equal(session.events.some((event) => event.type === 'execution/completed'), false);
  } finally {
    await session.adapter.stop();
  }
});

test('keeps the thread closing and blocks new work after a close timeout', async () => {
  const session = await open('hang-close');
  try {
    const nativeId = await session.adapter.createConversation({ id: 'p', directory: session.projectDir });
    await assert.rejects(session.adapter.closeConversation(nativeId), /timed out|timeout/i);
    await assert.rejects(session.adapter.submit(nativeId, 'exec-2', 'again'), /closing/);
  } finally {
    await session.adapter.stop();
  }
});

test('interrupts in-flight work before closing the thread', async () => {
  const session = await open('hang-turn');
  try {
    const nativeId = await session.adapter.createConversation({ id: 'p', directory: session.projectDir });
    await session.adapter.submit(nativeId, 'exec-1', 'wait');
    await session.adapter.closeConversation(nativeId);
    await waitForEvent(session.events, (event) => event.type === 'execution/cancelled');
    await assert.rejects(session.adapter.submit(nativeId, 'exec-2', 'again'), /Unknown Codex thread/);
  } finally {
    await session.adapter.stop();
  }
});

test('marks a running execution unknown when the app-server exits', async () => {
  const session = await open('exit');
  try {
    const nativeId = await session.adapter.createConversation({ id: 'p', directory: session.projectDir });
    await session.adapter.submit(nativeId, 'exec-1', 'die');
    const unknown = await waitForEvent(session.events, (event) => event.type === 'execution/unknown');
    assert.match(unknown.type === 'execution/unknown' ? unknown.reason : '', /exited/);
  } finally {
    await session.adapter.stop();
  }
});

test('rejects start when the executable does not exist', async () => {
  const adapter = new CodexAppServerAdapter({
    launch: { file: join(tmpdir(), `uw-missing-codex-${Date.now()}`), args: ['app-server'] },
    initializeTimeoutMs: 100,
  });
  try {
    await assert.rejects(adapter.start(), /ENOENT|spawn/i);
  } finally {
    await adapter.stop();
  }
});

test('advertises its implemented resume and rename capabilities', () => {
  const adapter = new CodexAppServerAdapter({ launch: { file: 'unused', args: [] } });
  assert.equal(adapter.capabilities.resume, true);
  assert.equal(adapter.capabilities.rename, true);
  assert.equal(typeof adapter.resume, 'function');
});

test('satisfies the harness adapter contract', async () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'uw-contract-project-'));
  const secondProjectDir = mkdtempSync(join(tmpdir(), 'uw-contract-project-'));
  const adapter = new CodexAppServerAdapter({
    launch: makeFakeServer('hang-turn'),
    requestTimeoutMs: 1_000,
  });

  try {
    await assertHarnessAdapterContract({
      adapter,
      project: { id: 'contract-project', directory: projectDir },
      secondProject: { id: 'contract-project-2', directory: secondProjectDir },
    });
  } finally {
    await adapter.stop().catch(() => undefined);
  }
});
