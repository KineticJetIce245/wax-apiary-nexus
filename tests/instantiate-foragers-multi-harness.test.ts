import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { GraphBindings } from '../src/graph/binding.js';
import { GraphBindingStore } from '../src/graph/binding-store.js';
import type { Project } from '../src/project/kernel.js';
import {
  parseComposition,
  type CompositionDefinition,
  type ForagerNode,
  type Value,
} from '../src/runtime/index.js';
import { instantiateForagers } from '../src/session/instantiate-foragers.js';
import { SessionRegistry } from '../src/session/session-registry.js';
import { Workspace } from '../src/session/workspace.js';
import { FakeAdapter } from './support/fake-adapter.js';

const FIXED_NOW = '2026-11-06T22:00:00.000Z';

function makeProject(): Project {
  return {
    id: `project-${String(Date.now())}-${String(Math.random())}`,
    directory: mkdtempSync(join(tmpdir(), 'wax-m9a-instantiate-')),
  };
}

function foragerNode(prompt = 'go'): Record<string, unknown> {
  return { kind: 'forager', config: { connection: 'codex', prompt } };
}

function makeDefinition(nodes: Record<string, unknown>): CompositionDefinition {
  return parseComposition({
    schemaVersion: 1,
    id: 'instantiate-multi-harness-test',
    nodes,
    edges: [],
  });
}

function foragerOf(definition: CompositionDefinition, nodeId: string): ForagerNode {
  const node = definition.nodes.get(nodeId);
  if (node === undefined || node.kind !== 'forager') {
    throw new Error(`expected a forager node '${nodeId}'`);
  }
  return node;
}

function text(value: string): Value {
  return { message: value };
}

test('routes each forager binding to its own harness workspace', async (t) => {
  const codexAdapter = new FakeAdapter({ output: 'codex-output' });
  const dshAdapter = new FakeAdapter({ output: 'dsh-output' });
  const codexWorkspace = new Workspace(codexAdapter);
  const dshWorkspace = new Workspace(dshAdapter);
  t.after(async () => {
    await codexWorkspace.stop();
    await dshWorkspace.stop();
  });

  const project = makeProject();
  const registry = new SessionRegistry({
    workspaces: new Map([
      ['codex', codexWorkspace],
      ['dsh', dshWorkspace],
    ]),
    now: () => FIXED_NOW,
  });
  const codexSession = await registry.create(project, { harness: 'codex' });

  const definition = makeDefinition({
    reuse: foragerNode('reuse {{message}}'),
    fresh_dsh: foragerNode('fresh dsh {{message}}'),
    fresh_codex: foragerNode('fresh codex {{message}}'),
  });
  const bindings: GraphBindings = {
    reuse: { kind: 'session', sessionId: codexSession.sessionId },
    fresh_dsh: { kind: 'fresh', harness: 'dsh' },
    fresh_codex: { kind: 'fresh', harness: 'codex' },
  };

  // Registry breadth must route every binding by its record/harness.
  const instantiated = await instantiateForagers({
    definition,
    bindings,
    registry,
    project,
  });
  t.after(() => instantiated.dispose());

  assert.equal(instantiated.sessions.get('reuse')?.harness, 'codex');
  assert.equal(instantiated.sessions.get('fresh_dsh')?.harness, 'dsh');
  assert.equal(instantiated.sessions.get('fresh_codex')?.harness, 'codex');

  const fresh_dsh = instantiated.sessions.get('fresh_dsh');
  const fresh_codex = instantiated.sessions.get('fresh_codex');
  assert.ok(fresh_dsh !== undefined && fresh_codex !== undefined);
  assert.ok(dshWorkspace.getConversation(fresh_dsh.sessionId) !== undefined);
  assert.equal(codexWorkspace.getConversation(fresh_dsh.sessionId), undefined);
  assert.ok(codexWorkspace.getConversation(fresh_codex.sessionId) !== undefined);
  assert.equal(dshWorkspace.getConversation(fresh_codex.sessionId), undefined);
  assert.ok(codexWorkspace.getConversation(codexSession.sessionId) !== undefined);

  const reused = await instantiated.routing.execute(
    foragerOf(definition, 'reuse'),
    text('one'),
  );
  const dsh = await instantiated.routing.execute(
    foragerOf(definition, 'fresh_dsh'),
    text('two'),
  );
  const fallback = await instantiated.routing.execute(
    foragerOf(definition, 'fresh_codex'),
    text('three'),
  );

  assert.deepEqual(reused, text('codex-output'));
  assert.deepEqual(dsh, text('dsh-output'));
  assert.deepEqual(fallback, text('codex-output'));
  assert.deepEqual(codexAdapter.prompts, ['reuse one', 'fresh codex three']);
  assert.deepEqual(dshAdapter.prompts, ['fresh dsh two']);
});

test('fresh_once mapping is reused for an explicit harness', async (t) => {
  const codexAdapter = new FakeAdapter({ output: 'codex-output' });
  const dshAdapter = new FakeAdapter({ output: 'dsh-output' });
  const codexWorkspace = new Workspace(codexAdapter);
  const dshWorkspace = new Workspace(dshAdapter);
  t.after(async () => {
    await codexWorkspace.stop();
    await dshWorkspace.stop();
  });

  const project = makeProject();
  const registry = new SessionRegistry({
    workspaces: new Map([
      ['codex', codexWorkspace],
      ['dsh', dshWorkspace],
    ]),
    now: () => FIXED_NOW,
  });
  const bindingStore = new GraphBindingStore(
    join(mkdtempSync(join(tmpdir(), 'wax-m9a-once-')), 'graph-bindings.json'),
    { now: () => FIXED_NOW },
  );
  const definition = makeDefinition({ only: foragerNode('run {{message}}') });
  const options = {
    definition,
    graphId: 'once-dsh',
    bindings: { only: { kind: 'fresh', mode: 'once', harness: 'dsh' } } satisfies GraphBindings,
    registry,
    project,
    bindingStore,
  } as const;

  const first = await instantiateForagers(options);
  t.after(() => first.dispose());
  const created = first.sessions.get('only');
  assert.ok(created !== undefined);
  assert.equal(created.harness, 'dsh');
  assert.equal(bindingStore.get('once-dsh', 'only')?.harness, 'dsh');
  assert.deepEqual(first.createdSessionIds, [created.sessionId]);

  const second = await instantiateForagers(options);
  t.after(() => second.dispose());
  assert.deepEqual(second.createdSessionIds, []);
  assert.equal(second.sessions.get('only')?.sessionId, created.sessionId);
  assert.equal(dshAdapter.displayNames.length, 1);
  assert.equal(codexAdapter.displayNames.length, 0);
});
