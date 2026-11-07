import assert from 'node:assert/strict';
import test from 'node:test';

import {
  validateBindings,
  type BindingIssue,
  type BindingIssueCode,
  type BindingLookup,
  type GraphBindings,
} from '../src/graph/binding.js';
import { parseComposition } from '../src/runtime/index.js';
import type { CompositionDefinition } from '../src/runtime/types.js';

function makeDefinition(nodes: Record<string, unknown>): CompositionDefinition {
  return parseComposition({
    schemaVersion: 1,
    id: 'binding-test',
    nodes,
    edges: [],
  });
}

function foragerNode(prompt = 'go'): Record<string, unknown> {
  return { kind: 'forager', config: { connection: 'codex', prompt } };
}

function workerNode(): Record<string, unknown> {
  return { kind: 'worker', config: { command: 'echo', args: [] } };
}

/**
 * Lookup double. `create` is deliberately not part of BindingLookup; the
 * counting copy lets a test prove validation never reaches a creating path.
 */
interface FakeRecord {
  readonly sessionId: string;
  readonly harness?: string;
  readonly projectDirectory?: string;
}

class FakeLookup implements BindingLookup {
  private readonly sessions = new Map<string, FakeRecord>();
  readonly busy = new Set<string>();
  getCalls = 0;
  busyCalls = 0;
  createCalls = 0;

  constructor(entries: readonly (string | FakeRecord)[] = []) {
    for (const entry of entries) {
      const record: FakeRecord = typeof entry === 'string' ? { sessionId: entry } : entry;
      this.sessions.set(record.sessionId, record);
    }
  }

  get(sessionId: string): FakeRecord | undefined {
    this.getCalls += 1;
    const record = this.sessions.get(sessionId);
    return record === undefined ? undefined : { ...record };
  }

  isBusy(sessionId: string): boolean {
    this.busyCalls += 1;
    return this.busy.has(sessionId);
  }

  create(sessionId: string): string {
    this.createCalls += 1;
    this.sessions.set(sessionId, { sessionId });
    return sessionId;
  }

  get sessionCount(): number {
    return this.sessions.size;
  }
}

interface IssueKey {
  readonly code: BindingIssueCode;
  readonly nodeId?: string;
  readonly sessionId?: string;
}

function issueKeys(issues: readonly BindingIssue[]): IssueKey[] {
  return issues.map((issue) => ({
    code: issue.code,
    ...(issue.nodeId === undefined ? {} : { nodeId: issue.nodeId }),
    ...(issue.sessionId === undefined ? {} : { sessionId: issue.sessionId }),
  }));
}

test('accepts a complete binding set where every forager is bound', () => {
  const definition = makeDefinition({
    start: foragerNode(),
    plan: foragerNode('plan'),
    sync: workerNode(),
  });
  const lookup = new FakeLookup(['session-1']);

  const result = validateBindings(
    definition,
    {
      start: { kind: 'session', sessionId: 'session-1' },
      plan: { kind: 'fresh', model: 'deepseek-chat', reasoning: 'high' },
    },
    lookup,
  );

  assert.deepEqual(result, { ok: true, issues: [] });
  assert.equal(lookup.getCalls, 1);
  assert.equal(lookup.busyCalls, 1);
});

test('reports a forager without a binding with its node id', () => {
  const definition = makeDefinition({
    start: foragerNode(),
    plan: foragerNode('plan'),
  });
  const lookup = new FakeLookup(['session-1']);

  const result = validateBindings(
    definition,
    { start: { kind: 'session', sessionId: 'session-1' } },
    lookup,
  );

  assert.equal(result.ok, false);
  assert.deepEqual(issueKeys(result.issues), [{ code: 'missing-binding', nodeId: 'plan' }]);
  assert.equal(lookup.getCalls, 1);
});

test('rejects a binding for a node that is not a forager without looking it up', () => {
  const definition = makeDefinition({
    start: foragerNode(),
    sync: workerNode(),
  });
  const lookup = new FakeLookup(['session-1', 'session-2']);

  const result = validateBindings(
    definition,
    {
      start: { kind: 'session', sessionId: 'session-1' },
      sync: { kind: 'session', sessionId: 'session-2' },
    },
    lookup,
  );

  assert.deepEqual(issueKeys(result.issues), [
    { code: 'not-forager', nodeId: 'sync', sessionId: 'session-2' },
  ]);
  // Only the forager's session is looked up; a non-forager binding is rejected
  // by node kind and must not touch the session layer.
  assert.equal(lookup.getCalls, 1);
  assert.equal(lookup.busyCalls, 1);
});

test('reports a binding whose node id is absent from the composition', () => {
  const definition = makeDefinition({ sync: workerNode() });
  const lookup = new FakeLookup();

  const result = validateBindings(
    definition,
    { ghost: { kind: 'fresh', model: 'deepseek-chat' } },
    lookup,
  );

  assert.deepEqual(issueKeys(result.issues), [{ code: 'unknown-binding', nodeId: 'ghost' }]);
  assert.equal(lookup.getCalls, 0);
});

test('rejects a non-object binding map without touching the lookup', () => {
  const definition = makeDefinition({ start: foragerNode() });

  for (const invalid of [null, [], 'bindings', 42, undefined]) {
    const lookup = new FakeLookup(['session-1']);
    const result = validateBindings(
      definition,
      invalid as unknown as GraphBindings,
      lookup,
    );

    assert.equal(result.ok, false);
    assert.deepEqual(issueKeys(result.issues), [{ code: 'invalid-binding' }]);
    assert.equal(lookup.getCalls, 0);
    assert.equal(lookup.busyCalls, 0);
  }
});

test('rejects non-object and unknown-kind bindings with the node id', () => {
  const definition = makeDefinition({ start: foragerNode() });

  for (const invalid of [null, 42, 'binding', [], true]) {
    const lookup = new FakeLookup(['session-1']);
    const result = validateBindings(
      definition,
      { start: invalid } as unknown as GraphBindings,
      lookup,
    );

    assert.deepEqual(issueKeys(result.issues), [
      { code: 'invalid-binding', nodeId: 'start' },
    ]);
    assert.equal(lookup.getCalls, 0);
    assert.equal(lookup.busyCalls, 0);
  }

  for (const kind of [undefined, null, 'weird', 42]) {
    const lookup = new FakeLookup(['session-1']);
    const result = validateBindings(
      definition,
      { start: { kind } } as unknown as GraphBindings,
      lookup,
    );

    assert.deepEqual(issueKeys(result.issues), [
      { code: 'invalid-binding', nodeId: 'start' },
    ]);
    assert.equal(lookup.getCalls, 0);
    assert.equal(lookup.busyCalls, 0);
  }
});

test('rejects a non-string session id without calling trim or the lookup', () => {
  const definition = makeDefinition({ start: foragerNode() });
  const lookup = new FakeLookup(['session-1']);

  const result = validateBindings(
    definition,
    { start: { kind: 'session', sessionId: 123 } } as unknown as GraphBindings,
    lookup,
  );

  assert.deepEqual(issueKeys(result.issues), [
    { code: 'invalid-binding', nodeId: 'start' },
  ]);
  assert.equal(lookup.getCalls, 0);
  assert.equal(lookup.busyCalls, 0);
});

test('does not treat an inherited object key as a forager binding', () => {
  // `constructor` is a legal node id. Without an own binding, lookup must not
  // fall through to Object.prototype.constructor and crash on `.sessionId`.
  const definition = makeDefinition({ constructor: foragerNode() });

  const result = validateBindings(definition, {}, new FakeLookup());

  assert.deepEqual(issueKeys(result.issues), [
    { code: 'missing-binding', nodeId: 'constructor' },
  ]);
});

test('rejects empty and whitespace-only session ids without a lookup', () => {
  const definition = makeDefinition({
    start: foragerNode(),
    plan: foragerNode('plan'),
  });
  const lookup = new FakeLookup();

  const result = validateBindings(
    definition,
    {
      start: { kind: 'session', sessionId: '' },
      plan: { kind: 'session', sessionId: '   ' },
    },
    lookup,
  );

  assert.deepEqual(issueKeys(result.issues), [
    { code: 'empty-session', nodeId: 'start', sessionId: '' },
    { code: 'empty-session', nodeId: 'plan', sessionId: '   ' },
  ]);
  assert.equal(lookup.getCalls, 0);
  assert.equal(lookup.busyCalls, 0);
});

test('reports an unknown session and never asks whether it is busy', () => {
  const definition = makeDefinition({ start: foragerNode() });
  const lookup = new FakeLookup();

  const result = validateBindings(
    definition,
    { start: { kind: 'session', sessionId: 'session-missing' } },
    lookup,
  );

  assert.deepEqual(issueKeys(result.issues), [
    { code: 'unknown-session', nodeId: 'start', sessionId: 'session-missing' },
  ]);
  assert.equal(lookup.getCalls, 1);
  assert.equal(lookup.busyCalls, 0);
});

test('reports a busy session', () => {
  const definition = makeDefinition({ start: foragerNode() });
  const lookup = new FakeLookup(['session-1']);
  lookup.busy.add('session-1');

  const result = validateBindings(
    definition,
    { start: { kind: 'session', sessionId: 'session-1' } },
    lookup,
  );

  assert.deepEqual(issueKeys(result.issues), [
    { code: 'busy-session', nodeId: 'start', sessionId: 'session-1' },
  ]);
  assert.equal(lookup.getCalls, 1);
  assert.equal(lookup.busyCalls, 1);
});

test('rejects two foragers binding the same session', () => {
  const definition = makeDefinition({
    start: foragerNode(),
    plan: foragerNode('plan'),
  });
  const lookup = new FakeLookup(['session-1']);

  const result = validateBindings(
    definition,
    {
      start: { kind: 'session', sessionId: 'session-1' },
      plan: { kind: 'session', sessionId: 'session-1' },
    },
    lookup,
  );

  assert.deepEqual(issueKeys(result.issues), [
    { code: 'duplicate-session', nodeId: 'plan', sessionId: 'session-1' },
  ]);
  // The duplicate is rejected before a second lookup: sharing is a binding
  // error regardless of the session's runtime state.
  assert.equal(lookup.getCalls, 1);
});

test('accepts fresh bindings with absent, model-only, or reasoning-only metadata', () => {
  const definition = makeDefinition({ start: foragerNode() });
  const lookup = new FakeLookup();

  for (const binding of [
    { kind: 'fresh' as const },
    { kind: 'fresh' as const, model: 'deepseek-chat' },
    { kind: 'fresh' as const, reasoning: 'low' },
  ]) {
    const result = validateBindings(definition, { start: binding }, lookup);
    assert.deepEqual(result, { ok: true, issues: [] });
  }

  assert.equal(lookup.getCalls, 0);
  assert.equal(lookup.busyCalls, 0);
});

test('accepts fresh bindings with mode once or always and keeps absent mode valid', () => {
  const definition = makeDefinition({ start: foragerNode() });
  const lookup = new FakeLookup();

  for (const binding of [
    { kind: 'fresh' as const },
    { kind: 'fresh' as const, mode: 'once' as const },
    { kind: 'fresh' as const, mode: 'always' as const, model: 'deepseek-chat' },
  ]) {
    assert.deepEqual(validateBindings(definition, { start: binding }, lookup), {
      ok: true,
      issues: [],
    });
  }

  assert.equal(lookup.getCalls, 0);
  assert.equal(lookup.busyCalls, 0);
});

test('rejects an unknown fresh mode as invalid-fresh', () => {
  const definition = makeDefinition({ start: foragerNode() });
  const lookup = new FakeLookup();

  for (const mode of ['sometimes', '', 42, null]) {
    const result = validateBindings(
      definition,
      { start: { kind: 'fresh', mode } } as unknown as GraphBindings,
      lookup,
    );

    assert.deepEqual(issueKeys(result.issues), [
      { code: 'invalid-fresh', nodeId: 'start' },
    ]);
    assert.match(result.issues[0]?.message ?? '', /mode/);
  }

  assert.equal(lookup.getCalls, 0);
  assert.equal(lookup.busyCalls, 0);
});

test('rejects empty and whitespace-only fresh model and reasoning metadata', () => {
  const definition = makeDefinition({ start: foragerNode() });
  const lookup = new FakeLookup();

  const result = validateBindings(
    definition,
    { start: { kind: 'fresh', model: '', reasoning: '   ' } },
    lookup,
  );

  assert.deepEqual(issueKeys(result.issues), [
    { code: 'invalid-fresh', nodeId: 'start' },
    { code: 'invalid-fresh', nodeId: 'start' },
  ]);
  assert.match(result.issues[0]?.message ?? '', /model/);
  assert.match(result.issues[1]?.message ?? '', /reasoning/);
});

test('validation never creates a session and leaves the lookup unchanged', () => {
  const definition = makeDefinition({ start: foragerNode() });
  const lookup = new FakeLookup(['session-1']);
  const bindings: GraphBindings = {
    start: { kind: 'session', sessionId: 'session-1' },
  };

  const result = validateBindings(definition, bindings, lookup);

  assert.deepEqual(result, { ok: true, issues: [] });
  assert.equal(lookup.createCalls, 0);
  assert.equal(lookup.sessionCount, 1);
  // A second pass sees the same untouched lookup.
  assert.deepEqual(validateBindings(definition, bindings, lookup), result);
  assert.equal(lookup.createCalls, 0);
  assert.equal(lookup.sessionCount, 1);
});

test('accepts a session whose harness and project match the binding context', () => {
  const definition = makeDefinition({ start: foragerNode() });
  const lookup = new FakeLookup([
    { sessionId: 'session-1', harness: 'codex', projectDirectory: '/opt/wax/project' },
  ]);

  const result = validateBindings(
    definition,
    { start: { kind: 'session', sessionId: 'session-1' } },
    lookup,
    { harness: 'codex', projectDirectory: '/opt/wax/project' },
  );

  assert.deepEqual(result, { ok: true, issues: [] });
  assert.equal(lookup.busyCalls, 1);
});

test('reports a session recorded for another harness', () => {
  const definition = makeDefinition({ start: foragerNode() });
  const lookup = new FakeLookup([
    { sessionId: 'session-1', harness: 'codex', projectDirectory: '/opt/wax/project' },
  ]);

  const result = validateBindings(
    definition,
    { start: { kind: 'session', sessionId: 'session-1' } },
    lookup,
    { harness: 'dsh-acp', projectDirectory: '/opt/wax/project' },
  );

  assert.deepEqual(issueKeys(result.issues), [
    { code: 'wrong-harness', nodeId: 'start', sessionId: 'session-1' },
  ]);
  assert.match(result.issues[0]?.message ?? '', /codex/);
  assert.match(result.issues[0]?.message ?? '', /dsh-acp/);
});

test('reports a session recorded for another project directory', () => {
  const definition = makeDefinition({ start: foragerNode() });
  const lookup = new FakeLookup([
    { sessionId: 'session-1', harness: 'codex', projectDirectory: '/opt/wax/one' },
  ]);

  const result = validateBindings(
    definition,
    { start: { kind: 'session', sessionId: 'session-1' } },
    lookup,
    { harness: 'codex', projectDirectory: '/opt/wax/two' },
  );

  assert.deepEqual(issueKeys(result.issues), [
    { code: 'wrong-project', nodeId: 'start', sessionId: 'session-1' },
  ]);
  assert.match(result.issues[0]?.message ?? '', /\/opt\/wax\/two/);
});

test('reports both harness and project mismatches in a fixed order', () => {
  const definition = makeDefinition({ start: foragerNode() });
  const lookup = new FakeLookup([
    { sessionId: 'session-1', harness: 'codex', projectDirectory: '/opt/wax/one' },
  ]);

  const result = validateBindings(
    definition,
    { start: { kind: 'session', sessionId: 'session-1' } },
    lookup,
    { harness: 'dsh-acp', projectDirectory: '/opt/wax/two' },
  );

  assert.deepEqual(issueKeys(result.issues), [
    { code: 'wrong-harness', nodeId: 'start', sessionId: 'session-1' },
    { code: 'wrong-project', nodeId: 'start', sessionId: 'session-1' },
  ]);
});

test('checks the context before busy, independent of the busy state', () => {
  const definition = makeDefinition({ start: foragerNode() });
  const lookup = new FakeLookup([
    { sessionId: 'session-1', harness: 'codex', projectDirectory: '/opt/wax/project' },
  ]);
  lookup.busy.add('session-1');

  const result = validateBindings(
    definition,
    { start: { kind: 'session', sessionId: 'session-1' } },
    lookup,
    { harness: 'dsh-acp', projectDirectory: '/opt/wax/project' },
  );

  // Wrong harness comes before busy; both are reported because the public
  // issue list is not capped at one issue per binding.
  assert.deepEqual(issueKeys(result.issues), [
    { code: 'wrong-harness', nodeId: 'start', sessionId: 'session-1' },
    { code: 'busy-session', nodeId: 'start', sessionId: 'session-1' },
  ]);
});

test('compares project paths with the same normalization as the conversation store', () => {
  const definition = makeDefinition({ start: foragerNode() });
  // On Windows case and separator differences must compare equal; elsewhere
  // only path normalization (e.g. `..`) is tested because case is significant.
  const recordPath =
    process.platform === 'win32' ? 'C:\\Files\\Wax\\Project' : '/opt/wax/../wax/Project';
  const contextPath =
    process.platform === 'win32' ? 'c:/files/wax/project' : '/opt/wax/Project';
  const lookup = new FakeLookup([
    { sessionId: 'session-1', harness: 'codex', projectDirectory: recordPath },
  ]);

  const result = validateBindings(
    definition,
    { start: { kind: 'session', sessionId: 'session-1' } },
    lookup,
    { harness: 'codex', projectDirectory: contextPath },
  );

  assert.deepEqual(result, { ok: true, issues: [] });
});

test('omits context checks entirely when no context is supplied', () => {
  const definition = makeDefinition({ start: foragerNode() });
  const lookup = new FakeLookup([
    { sessionId: 'session-1', harness: 'codex', projectDirectory: '/opt/wax/one' },
  ]);

  const result = validateBindings(
    definition,
    { start: { kind: 'session', sessionId: 'session-1' } },
    lookup,
  );

  assert.deepEqual(result, { ok: true, issues: [] });
});

test('checks only the context fields that are present', () => {
  const definition = makeDefinition({ start: foragerNode() });
  const record = {
    sessionId: 'session-1',
    harness: 'codex',
    projectDirectory: '/opt/wax/one',
  } as const;

  const harnessOnly = validateBindings(
    definition,
    { start: { kind: 'session', sessionId: 'session-1' } },
    new FakeLookup([record]),
    { harness: 'codex' },
  );
  const projectOnly = validateBindings(
    definition,
    { start: { kind: 'session', sessionId: 'session-1' } },
    new FakeLookup([record]),
    { projectDirectory: '/opt/wax/one' },
  );

  assert.deepEqual(harnessOnly, { ok: true, issues: [] });
  assert.deepEqual(projectOnly, { ok: true, issues: [] });
});

test('does not apply harness or project checks to a fresh binding', () => {
  const definition = makeDefinition({ start: foragerNode() });
  const lookup = new FakeLookup();

  const result = validateBindings(
    definition,
    { start: { kind: 'fresh', model: 'deepseek-chat' } },
    lookup,
    { harness: 'dsh-acp', projectDirectory: '/opt/wax/other' },
  );

  assert.deepEqual(result, { ok: true, issues: [] });
  assert.equal(lookup.getCalls, 0);
  assert.equal(lookup.busyCalls, 0);
});

test('reports issues in a stable definition-then-binding order', () => {
  const definition = makeDefinition({
    a: foragerNode(),
    w: workerNode(),
    b: foragerNode('b'),
    c: foragerNode('c'),
    d: foragerNode('d'),
    e: foragerNode('e'),
    f: foragerNode('f'),
    g: foragerNode('g'),
  });
  const lookup = new FakeLookup(['busy-session']);
  lookup.busy.add('busy-session');
  const bindings = {
    ghost: { kind: 'fresh' },
    f: { kind: 'fresh', model: '' },
    e: { kind: 'session', sessionId: 'busy-session' },
    d: { kind: 'session', sessionId: 'busy-session' },
    c: { kind: 'session', sessionId: 'missing-session' },
    b: { kind: 'session', sessionId: '' },
    w: { kind: 'session', sessionId: 'busy-session' },
    g: null,
  } as unknown as GraphBindings;

  const first = validateBindings(definition, bindings, lookup);
  const second = validateBindings(definition, bindings, lookup);

  assert.equal(first.ok, false);
  assert.deepEqual(issueKeys(first.issues), [
    { code: 'missing-binding', nodeId: 'a' },
    { code: 'not-forager', nodeId: 'w', sessionId: 'busy-session' },
    { code: 'empty-session', nodeId: 'b', sessionId: '' },
    { code: 'unknown-session', nodeId: 'c', sessionId: 'missing-session' },
    { code: 'busy-session', nodeId: 'd', sessionId: 'busy-session' },
    { code: 'duplicate-session', nodeId: 'e', sessionId: 'busy-session' },
    { code: 'invalid-fresh', nodeId: 'f' },
    { code: 'invalid-binding', nodeId: 'g' },
    { code: 'unknown-binding', nodeId: 'ghost' },
  ]);
  assert.deepEqual(second, first);
});
