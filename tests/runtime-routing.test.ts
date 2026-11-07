import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { HarnessEvent } from '../src/adapters/harness.js';
import { validateBindings, type GraphBindings } from '../src/graph/binding.js';
import type { Project } from '../src/project/kernel.js';
import type { AttachmentDraft } from '../src/shared/content.js';
import {
  parseComposition,
  PheromoneRuntime,
  type PheromoneFieldSnapshot,
  type Value,
} from '../src/runtime/index.js';
import {
  BindingValidationError,
  instantiateForagers,
  type InstantiatedForagers,
} from '../src/session/instantiate-foragers.js';
import { SessionRegistry, type SessionRecord } from '../src/session/session-registry.js';
import { Workspace } from '../src/session/workspace.js';
import { FakeAdapter } from './support/fake-adapter.js';

const FIXED_NOW = '2026-11-06T22:00:00.000Z';
const START = Date.parse('2026-11-06T22:00:00.000Z');

function makeProject(): Project {
  return {
    id: `project-${String(Date.now())}-${String(Math.random())}`,
    directory: mkdtempSync(join(tmpdir(), 'wax-m3b-runtime-')),
  };
}

function text(value: string): Value {
  return { kind: 'text', text: value };
}

function foragerNode(prompt: string): Record<string, unknown> {
  return { kind: 'forager', config: { connection: 'codex', prompt } };
}

function routingDefinition(): ReturnType<typeof parseComposition> {
  return parseComposition({
    schemaVersion: 1,
    id: 'runtime-routing',
    nodes: {
      start: foragerNode('start {{input}}'),
      fork: {
        kind: 'fork',
        config: {
          branches: [
            { id: 'a', to: 'branch-a' },
            { id: 'b', to: 'branch-b' },
          ],
        },
      },
      'branch-a': foragerNode('branch-a {{input}}'),
      'branch-b': foragerNode('branch-b {{input}}'),
      merge: { kind: 'merge', config: { required: ['a', 'b'], combine: 'text' } },
      done: foragerNode('done {{input}}'),
    },
    edges: [
      { id: 'e1', from: 'start', to: 'fork' },
      { id: 'e2', from: 'branch-a', to: 'merge' },
      { id: 'e3', from: 'branch-b', to: 'merge' },
      { id: 'e4', from: 'merge', to: 'done' },
    ],
  });
}

/**
 * FakeAdapter emits one fixed output for every conversation. This variant
 * labels its output with the native id and records prompts per conversation,
 * so the test can prove which session actually received a node's prompt.
 */
class EchoAdapter extends FakeAdapter {
  readonly promptsByNative = new Map<string, string[]>();
  private readonly echoListeners = new Set<(event: HarnessEvent) => void>();

  override async submit(
    nativeId: string,
    executionId: string,
    promptText: string,
    attachments: readonly AttachmentDraft[] = [],
  ): Promise<void> {
    this.prompts.push(promptText);
    this.submittedAttachments.push([...attachments]);
    const prompts = this.promptsByNative.get(nativeId) ?? [];
    prompts.push(promptText);
    this.promptsByNative.set(nativeId, prompts);

    setTimeout(() => {
      this.emitEcho({ type: 'execution/started', executionId });
      this.emitEcho({
        type: 'execution/output',
        executionId,
        channel: 'assistant',
        text: `reply(${nativeId}):${promptText}`,
      });
      this.emitEcho({ type: 'execution/completed', executionId, stopReason: 'end_turn' });
    }, 0);
  }

  override onEvent(handler: (event: HarnessEvent) => void): () => void {
    this.echoListeners.add(handler);
    return () => {
      this.echoListeners.delete(handler);
    };
  }

  private emitEcho(event: HarnessEvent): void {
    for (const listener of this.echoListeners) {
      listener(event);
    }
  }
}

function promptsFor(adapter: EchoAdapter, record: SessionRecord): readonly string[] {
  const prompts = adapter.promptsByNative.get(record.nativeId);
  assert.ok(prompts !== undefined, `no prompt reached session '${record.sessionId}'`);
  return prompts;
}

function sessionOf(instantiated: InstantiatedForagers, nodeId: string): SessionRecord {
  const record = instantiated.sessions.get(nodeId);
  assert.ok(record !== undefined, `no session bound to node '${nodeId}'`);
  return record;
}

function waitForExecutionSettled(workspace: Workspace, executionId: string): Promise<void> {
  const execution = workspace.getExecution(executionId);
  if (execution !== undefined && execution.state !== 'running') {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const unsubscribe = workspace.onEvent((event) => {
      if (event.type === 'execution/state' && event.executionId === executionId) {
        unsubscribe();
        resolve();
      }
    });
  });
}

/**
 * Pumps until Rest. Each pump may activate a node once; advancing the injected
 * clock past `minIntervalMs` lets the same node (here: merge) run again without
 * a real sleep.
 */
async function pumpUntilRest(
  runtime: PheromoneRuntime,
  advanceClock: () => void,
  maxPumps = 10,
): Promise<PheromoneFieldSnapshot> {
  for (let pump = 1; pump <= maxPumps; pump += 1) {
    await runtime.pump();
    const snapshot = runtime.snapshot();
    if (snapshot.rest) {
      return snapshot;
    }
    advanceClock();
  }
  throw new Error(`field did not reach Rest after ${String(maxPumps)} pumps`);
}

test('fork routes each branch to its own session through merge to Rest', async (t) => {
  const adapter = new EchoAdapter();
  const workspace = new Workspace(adapter);
  t.after(() => workspace.stop());
  const project = makeProject();
  const registry = new SessionRegistry({ workspace, harness: 'fake-harness', now: () => FIXED_NOW });
  const sessionA = await registry.create(project, { displayName: 'branch-a-session' });
  const sessionB = await registry.create(project, { displayName: 'branch-b-session' });
  const definition = routingDefinition();
  const bindings: GraphBindings = {
    start: { kind: 'fresh' },
    'branch-a': { kind: 'session', sessionId: sessionA.sessionId },
    'branch-b': { kind: 'session', sessionId: sessionB.sessionId },
    done: { kind: 'fresh' },
  };
  const instantiated = await instantiateForagers({
    definition,
    bindings,
    registry,
    workspace,
    project,
  });
  t.after(() => instantiated.dispose());

  const records = {
    start: sessionOf(instantiated, 'start'),
    branchA: sessionOf(instantiated, 'branch-a'),
    branchB: sessionOf(instantiated, 'branch-b'),
    done: sessionOf(instantiated, 'done'),
  };
  assert.equal(records.branchA.sessionId, sessionA.sessionId);
  assert.equal(records.branchB.sessionId, sessionB.sessionId);
  assert.equal(
    new Set(Object.values(records).map((record) => record.sessionId)).size,
    4,
    'all four foragers use distinct sessions',
  );

  let clock = START;
  const runtime = new PheromoneRuntime(definition, {
    executeForager: instantiated.routing,
    projectDirectory: project.directory,
    now: () => clock,
  });
  runtime.trigger('start', text('seed'));
  const snapshot = await pumpUntilRest(runtime, () => {
    clock += 1000;
  });

  assert.equal(snapshot.rest, true);
  assert.deepEqual(snapshot.pheromones, []);
  assert.equal(adapter.prompts.length, 4);

  assert.deepEqual(promptsFor(adapter, records.start), ['start seed']);
  const branchAPrompts = promptsFor(adapter, records.branchA);
  const branchBPrompts = promptsFor(adapter, records.branchB);
  assert.equal(branchAPrompts.length, 1);
  assert.equal(branchBPrompts.length, 1);
  assert.match(branchAPrompts[0] ?? '', /^branch-a /);
  assert.match(branchBPrompts[0] ?? '', /^branch-b /);
  // Each branch executor saw the start node's output, produced by its own
  // session, and never the sibling branch's prompt.
  assert.ok(branchAPrompts[0]?.includes(`reply(${records.start.nativeId}):start seed`));
  assert.ok(branchBPrompts[0]?.includes(`reply(${records.start.nativeId}):start seed`));
  assert.equal(branchAPrompts[0]?.includes('branch-b '), false);
  assert.equal(branchBPrompts[0]?.includes('branch-a '), false);

  const donePrompts = promptsFor(adapter, records.done);
  assert.equal(donePrompts.length, 1);
  const donePrompt = donePrompts[0] ?? '';
  assert.match(donePrompt, /^done /);
  // The merge output carried the two branch results from their two sessions.
  assert.ok(donePrompt.includes(`reply(${records.branchA.nativeId}):branch-a `));
  assert.ok(donePrompt.includes(`reply(${records.branchB.nativeId}):branch-b `));
  assert.equal(
    (donePrompt.match(new RegExp(`reply\\(${escapeRegExp(records.branchA.nativeId)}\\)`, 'g')) ?? [])
      .length,
    1,
  );
  assert.equal(
    (donePrompt.match(new RegExp(`reply\\(${escapeRegExp(records.branchB.nativeId)}\\)`, 'g')) ?? [])
      .length,
    1,
  );

  assert.deepEqual(
    instantiated.routing.lastOutput,
    instantiated.executors.get('done')?.lastOutput,
  );
  const finalText = instantiated.routing.lastOutput;
  assert.equal(finalText?.kind, 'text');
  if (finalText?.kind === 'text') {
    assert.match(finalText.text, new RegExp(`^reply\\(${escapeRegExp(records.done.nativeId)}\\):done `));
  }
});

test('a busy session stops instantiation before the graph runs', async (t) => {
  const adapter = new EchoAdapter();
  const workspace = new Workspace(adapter);
  t.after(() => workspace.stop());
  const project = makeProject();
  const registry = new SessionRegistry({ workspace, harness: 'fake-harness', now: () => FIXED_NOW });
  const busy = await registry.create(project);
  const execution = await workspace.submit(busy.sessionId, 'hold');
  const settled = waitForExecutionSettled(workspace, execution.id);
  const definition = parseComposition({
    schemaVersion: 1,
    id: 'busy-routing',
    nodes: {
      run: foragerNode('run {{input}}'),
      extra: foragerNode('extra {{input}}'),
    },
    edges: [{ id: 'e1', from: 'run', to: 'extra' }],
  });
  const bindings: GraphBindings = {
    run: { kind: 'session', sessionId: busy.sessionId },
    extra: { kind: 'fresh' },
  };

  try {
    const validation = validateBindings(definition, bindings, registry, {
      harness: registry.harness,
      projectDirectory: project.directory,
    });
    assert.deepEqual(
      validation.issues.map((issue) => issue.code),
      ['busy-session'],
    );

    await assert.rejects(
      instantiateForagers({ definition, bindings, registry, workspace, project }),
      (error: unknown) => {
        assert.ok(error instanceof BindingValidationError);
        assert.deepEqual(
          error.issues.map((issue) => issue.code),
          ['busy-session'],
        );
        return true;
      },
    );

    // No fresh session and no graph prompt: only the hold submission ran.
    assert.deepEqual(adapter.prompts, ['hold']);
    assert.equal(registry.list().length, 1);
    assert.equal(adapter.displayNames.length, 1);
  } finally {
    await settled;
  }
  assert.equal(registry.isBusy(busy.sessionId), false);
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
