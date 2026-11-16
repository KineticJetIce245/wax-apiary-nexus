import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import {
  DispatchConflictError,
  DispatchExecutionError,
  DispatchService,
  DispatchSessionNotFoundError,
  DispatchTimeoutError,
} from '../src/b/dispatch-service.js';
import type { Project } from '../src/project/kernel.js';
import { SessionRegistry } from '../src/session/session-registry.js';
import { Workspace } from '../src/session/workspace.js';
import { FakeAdapter, type FakeAdapterOptions } from './support/fake-adapter.js';

interface Harness {
  readonly adapter: FakeAdapter;
  readonly workspace: Workspace;
  readonly registry: SessionRegistry;
  readonly project: Project;
  readonly service: DispatchService;
}

function setup(
  t: TestContext,
  adapterOptions: FakeAdapterOptions = {},
  withDefaultProject = true,
): Harness {
  const adapter = new FakeAdapter(adapterOptions);
  const workspace = new Workspace(adapter);
  t.after(async () => {
    await workspace.stop();
  });
  const registry = new SessionRegistry({
    workspaces: new Map([['fake', workspace]]),
  });
  const project: Project = {
    id: 'dispatch-project',
    directory: mkdtempSync(join(tmpdir(), 'wax-dispatch-')),
  };
  const service = new DispatchService({
    registry,
    ...(withDefaultProject ? { defaultProject: project } : {}),
  });
  return { adapter, workspace, registry, project, service };
}

test('dispatch fresh creates one temporary session and returns its output', async (t) => {
  const harness = setup(t, { output: 'answer-42' });
  const result = await harness.service.dispatch('hello', {
    sessionParams: { harness: 'fake', model: 'm1', reasoning: 'high' },
  });

  assert.deepEqual(result, { output: 'answer-42', sessionId: result.sessionId });
  assert.equal(harness.adapter.prompts.length, 1);
  assert.equal(harness.adapter.prompts[0], 'hello');
  const record = harness.registry.get(result.sessionId);
  assert.ok(record !== undefined);
  assert.equal(record.harness, 'fake');
  assert.equal(record.model, 'm1');
  assert.equal(record.reasoning, 'high');
  assert.equal(harness.registry.list().length, 1);
  assert.deepEqual(readdirSync(harness.project.directory), []);
});

test('dispatch explicit session reuses it and uses its own harness metadata', async (t) => {
  const harness = setup(t, { output: 'reused' });
  const session = await harness.registry.create(harness.project, {
    harness: 'fake',
    model: 'session-model',
    reasoning: 'session-reasoning',
  });

  const result = await harness.service.dispatch('continue', {
    sessionId: session.sessionId,
    sessionParams: {
      harness: 'fake',
      model: 'session-model',
      reasoning: 'session-reasoning',
    },
  });

  assert.deepEqual(result, { output: 'reused', sessionId: session.sessionId });
  assert.equal(harness.registry.list().length, 1);
  assert.equal(harness.adapter.prompts[0], 'continue');
});

test('dispatch explicit session rejects conflicting creation parameters', async (t) => {
  const harness = setup(t, { output: 'ok' });
  const session = await harness.registry.create(harness.project, {
    harness: 'fake',
    model: 'session-model',
    reasoning: 'session-reasoning',
  });

  await assert.rejects(
    harness.service.dispatch('x', {
      sessionId: session.sessionId,
      sessionParams: { harness: 'other' },
    }),
    DispatchConflictError,
  );
  await assert.rejects(
    harness.service.dispatch('x', {
      sessionId: session.sessionId,
      sessionParams: { model: 'other' },
    }),
    DispatchConflictError,
  );
  await assert.rejects(
    harness.service.dispatch('x', {
      sessionId: session.sessionId,
      sessionParams: { reasoning: 'other' },
    }),
    DispatchConflictError,
  );
  assert.equal(harness.adapter.prompts.length, 0);
});

test('dispatch reports an unknown explicit session without creating one', async (t) => {
  const harness = setup(t);
  await assert.rejects(
    harness.service.dispatch('x', { sessionId: 'unknown-session' }),
    DispatchSessionNotFoundError,
  );
  assert.equal(harness.registry.list().length, 0);
  assert.equal(harness.adapter.prompts.length, 0);
});

test('dispatch requires input and one session choice; fresh needs a project', async (t) => {
  const harness = setup(t, {}, false);
  await assert.rejects(harness.service.dispatch('', { sessionParams: {} }), TypeError);
  await assert.rejects(harness.service.dispatch('x', {}), TypeError);
  await assert.rejects(harness.service.dispatch('x', { sessionParams: {} }), /needs a project/);
  assert.equal(harness.adapter.prompts.length, 0);
});

test('dispatch can use a per-call project and validates timeout', async (t) => {
  const harness = setup(t, { output: 'override' }, false);
  const result = await harness.service.dispatch('x', {
    sessionParams: { harness: 'fake' },
    project: harness.project,
  });
  assert.equal(result.output, 'override');
  await assert.rejects(
    harness.service.dispatch('x', {
      sessionParams: { harness: 'fake' },
      project: harness.project,
      timeoutMs: 0,
    }),
    TypeError,
  );
});

test('dispatch timeout cancels once, rejects and never replays the prompt', async (t) => {
  const harness = setup(t, { output: 'never', askApproval: true });
  const started = Date.now();
  await assert.rejects(
    harness.service.dispatch('side-effect', {
      sessionParams: { harness: 'fake' },
      timeoutMs: 40,
    }),
    DispatchTimeoutError,
  );
  assert.ok(Date.now() - started < 1_000);
  assert.equal(harness.adapter.prompts.length, 1);
  assert.equal(harness.adapter.prompts[0], 'side-effect');
});

test('dispatch reports failed and unknown terminal states without replay', async (t) => {
  const failed = setup(t, { terminal: 'failed', error: 'native failure' });
  await assert.rejects(
    failed.service.dispatch('x', { sessionParams: { harness: 'fake' } }),
    DispatchExecutionError,
  );
  assert.equal(failed.adapter.prompts.length, 1);

  const unknown = setup(t, { terminal: 'unknown', error: 'no outcome' });
  await assert.rejects(
    unknown.service.dispatch('x', { sessionParams: { harness: 'fake' } }),
    DispatchExecutionError,
  );
  assert.equal(unknown.adapter.prompts.length, 1);
});
