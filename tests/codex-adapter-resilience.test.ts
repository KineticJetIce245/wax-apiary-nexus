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

test('treats a timed-out turn/start without acceptance as unknown and keeps the conversation busy', async () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'uw-codex-uncertain-'));
  const adapter = new CodexAppServerAdapter({
    launch: makeFakeServer('no-accept'),
    requestTimeoutMs: 100,
    closeTerminalTimeoutMs: 200,
  });
  const workspace = new Workspace(adapter);
  const states: string[] = [];
  workspace.onEvent((event) => {
    if (event.type === 'execution/state') {
      states.push(event.state);
    }
  });

  try {
    await adapter.start();
    const conversation = await workspace.createConversation({ id: 'uncertain', directory: projectDir });
    await assert.rejects(workspace.submit(conversation.id, 'first'), SubmitOutcomeUnknownError);
    assert.equal(states[0], 'unknown');
    await assert.rejects(workspace.submit(conversation.id, 'second'), ConversationBusyError);
  } finally {
    await workspace.stop();
  }
});

test('keeps a timed-out turn alive when turn/started arrives later and releases it afterwards', async () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'uw-codex-late-start-'));
  const adapter = new CodexAppServerAdapter({
    launch: makeFakeServer('late-start'),
    requestTimeoutMs: 100,
    closeTerminalTimeoutMs: 1_000,
  });
  const workspace = new Workspace(adapter);

  try {
    await adapter.start();
    const conversation = await workspace.createConversation({ id: 'late', directory: projectDir });
    await assert.rejects(workspace.submit(conversation.id, 'first'), SubmitOutcomeUnknownError);
    await delay(300);
    const second = await workspace.submit(conversation.id, 'second');
    assert.equal(second.state, 'running');
  } finally {
    await workspace.stop();
  }
});

test('does not report cancelled when close cannot confirm a native terminal', async () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'uw-codex-no-terminal-'));
  const adapter = new CodexAppServerAdapter({
    launch: makeFakeServer('no-terminal'),
    requestTimeoutMs: 200,
    closeTerminalTimeoutMs: 200,
  });
  const workspace = new Workspace(adapter);
  try {
    await adapter.start();
    const conversation = await workspace.createConversation({ id: 'no-terminal', directory: projectDir });
    const execution = await workspace.submit(conversation.id, 'first');
    await assert.rejects(workspace.closeConversation(conversation.id), /did not reach a terminal/);
    assert.equal(workspace.getExecution(execution.id)?.state, 'unknown');
    await assert.rejects(workspace.submit(conversation.id, 'second'), ConversationClosingError);
  } finally {
    await workspace.stop();
  }
});

test('closes only after a late native terminal event arrives', async () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'uw-codex-late-terminal-'));
  const adapter = new CodexAppServerAdapter({
    launch: makeFakeServer('late-terminal'),
    requestTimeoutMs: 200,
    closeTerminalTimeoutMs: 1_000,
  });
  const workspace = new Workspace(adapter);
  try {
    await adapter.start();
    const conversation = await workspace.createConversation({ id: 'late-terminal', directory: projectDir });
    const execution = await workspace.submit(conversation.id, 'first');
    await workspace.closeConversation(conversation.id);
    assert.equal(workspace.getExecution(execution.id)?.state, 'cancelled');
  } finally {
    await workspace.stop();
  }
});

test('ignores a stale turn completion instead of settling the new execution', async () => {
  const session = await open('stale-terminal');
  try {
    const nativeId = await session.adapter.createConversation({ id: 'p', directory: session.projectDir });
    await session.adapter.submit(nativeId, 'exec-1', 'first');
    await delay(20);
    await session.adapter.cancel(nativeId);
    await waitForEvent(session.events, (event) => event.type === 'execution/cancelled');

    await session.adapter.submit(nativeId, 'exec-2', 'second');
    await delay(60);
    assert.equal(
      session.events.some((event) => event.type === 'execution/completed'),
      false,
      'stale turn-1 completion settled the second execution',
    );
    const completed = await waitForEvent(session.events, (event) => event.type === 'execution/completed', 2_000);
    assert.equal(completed.type === 'execution/completed' ? completed.executionId : '', 'exec-2');
  } finally {
    await session.adapter.stop();
  }
});

test('declines an approval request that belongs to a previous turn', async () => {
  const session = await open('stale-approval');
  try {
    const nativeId = await session.adapter.createConversation({ id: 'p', directory: session.projectDir });
    await session.adapter.submit(nativeId, 'exec-1', 'first');
    await waitForEvent(session.events, (event) => event.type === 'execution/completed');

    await session.adapter.submit(nativeId, 'exec-2', 'second');
    await waitForEvent(
      session.events,
      (event) => event.type === 'execution/completed' && event.executionId === 'exec-2',
      2_000,
    );
    assert.equal(
      session.events.some((event) => event.type === 'execution/approval-requested'),
      false,
      'an old-turn approval was presented to the new execution',
    );
  } finally {
    await session.adapter.stop();
  }
});


test('resumes a thread and advertises resume capability', async () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'uw-codex-resume-'));
  const recordPath = join(projectDir, 'resume.json');
  const adapter = new CodexAppServerAdapter({
    launch: makeFakeServer('ok', recordPath),
    requestTimeoutMs: 2_000,
  });
  await adapter.start();
  try {
    assert.equal(adapter.capabilities.resume, true);
    await adapter.resume('thr-old', 'C:/fallback');
    assert.deepEqual(JSON.parse(readFileSync(recordPath, 'utf8')), { threadId: 'thr-old' });
  } finally {
    await adapter.stop();
  }
});

test('declares experimentalApi when initializing Codex', async () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'uw-codex-init-project-'));
  const adapter = new CodexAppServerAdapter({
    launch: makeFakeServer('happy', undefined, { recordDir: projectDir }),
    requestTimeoutMs: 2_000,
  });
  try {
    await adapter.start();
    const recorded = JSON.parse(readFileSync(join(projectDir, 'initialize.json'), 'utf8')) as {
      capabilities?: { experimentalApi?: boolean };
    };
    assert.equal(recorded.capabilities?.experimentalApi, true);
  } finally {
    await adapter.stop();
  }
});

test('assigns the longest project root that contains the project directory', async () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'uw-codex-project-assign-'));
  const recordPath = join(projectDir, 'thread-start.json');
  const adapter = new CodexAppServerAdapter({
    launch: makeFakeServer('project', recordPath, { projectRoot: projectDir }),
    requestTimeoutMs: 2_000,
  });
  try {
    await adapter.start();
    await adapter.createConversation({ id: 'p', directory: projectDir });
    const recorded = JSON.parse(readFileSync(recordPath, 'utf8')) as { projectId?: string };
    assert.equal(recorded.projectId, 'proj-inner');
  } finally {
    await adapter.stop();
  }
});

test('does not send projectId when project/list is empty', async () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'uw-codex-no-project-'));
  const recordPath = join(projectDir, 'thread-start.json');
  const adapter = new CodexAppServerAdapter({
    launch: makeFakeServer('project-empty', recordPath),
    requestTimeoutMs: 2_000,
  });
  try {
    await adapter.start();
    await adapter.createConversation({ id: 'p', directory: projectDir });
    const recorded = JSON.parse(readFileSync(recordPath, 'utf8')) as Record<string, unknown>;
    assert.equal('projectId' in recorded, false);
  } finally {
    await adapter.stop();
  }
});

test('sets the native thread name from the WAX display alias', async () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'uw-codex-name-'));
  const recordPath = join(projectDir, 'thread-start.json');
  const name = 'wax-apiary-nexus-session-demo-composition';
  const adapter = new CodexAppServerAdapter({
    launch: makeFakeServer('happy', recordPath, { recordDir: projectDir }),
    requestTimeoutMs: 2_000,
  });
  try {
    await adapter.start();
    const nativeId = await adapter.createConversation(
      { id: 'p', directory: projectDir },
      { displayName: name },
    );
    const recorded = JSON.parse(readFileSync(join(projectDir, 'thread-name.json'), 'utf8')) as {
      threadId?: string;
      name?: string;
    };
    assert.deepEqual(recorded, { threadId: nativeId, name });
  } finally {
    await adapter.stop();
  }
});

test('reports a project lookup failure and keeps the session usable', async () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'uw-codex-project-error-'));
  const recordPath = join(projectDir, 'thread-start.json');
  const adapter = new CodexAppServerAdapter({
    launch: makeFakeServer('project-error', recordPath),
    requestTimeoutMs: 2_000,
  });
  const events: HarnessEvent[] = [];
  adapter.onEvent((event) => events.push(event));
  try {
    await adapter.start();
    await adapter.createConversation({ id: 'p', directory: projectDir });
    const error = await waitForEvent(events, (event) => event.type === 'adapter/error');
    assert.match(error.type === 'adapter/error' ? error.message : '', /project lookup/);
    const recorded = JSON.parse(readFileSync(recordPath, 'utf8')) as Record<string, unknown>;
    assert.equal('projectId' in recorded, false);
  } finally {
    await adapter.stop();
  }
});

test('falls back to initialize without experimental capabilities when rejected', async () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'uw-codex-init-fallback-'));
  const recordPath = join(projectDir, 'thread-start.json');
  const adapter = new CodexAppServerAdapter({
    launch: makeFakeServer('init-reject', recordPath, { recordDir: projectDir }),
    requestTimeoutMs: 2_000,
  });
  const events: HarnessEvent[] = [];
  adapter.onEvent((event) => events.push(event));
  try {
    await adapter.start();
    const error = await waitForEvent(events, (event) => event.type === 'adapter/error');
    assert.match(error.type === 'adapter/error' ? error.message : '', /experimental API capabilities/);
    await adapter.createConversation({ id: 'p', directory: projectDir });
    const recorded = JSON.parse(readFileSync(recordPath, 'utf8')) as Record<string, unknown>;
    assert.equal('projectId' in recorded, false);
  } finally {
    await adapter.stop();
  }
});
