import assert from 'node:assert/strict';
import test from 'node:test';

import { CompositionValidationError, parseComposition } from '../src/runtime/index.js';

function workerComposition(config: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: 'worker',
    nodes: {
      work: { kind: 'worker', config },
    },
    edges: [],
  };
}

function conditionComposition(config: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: 'condition-worker',
    nodes: {
      check: { kind: 'condition', config },
      yes: { kind: 'forager', config: { connection: 'codex', prompt: 'yes' } },
      no: { kind: 'forager', config: { connection: 'codex', prompt: 'no' } },
    },
    edges: [
      { id: 'e1', from: 'check', to: 'yes', when: 'true' },
      { id: 'e2', from: 'check', to: 'no', when: 'false' },
    ],
  };
}

function issuesOf(input: unknown): string[] {
  try {
    parseComposition(input);
  } catch (error) {
    assert.ok(error instanceof CompositionValidationError);
    return [...error.issues];
  }
  assert.fail('expected the composition to be rejected');
}

test('parses worker argv config with contract defaults and revises the graph', () => {
  const composition = parseComposition(workerComposition({ command: 'node' }));
  const work = composition.nodes.get('work');
  assert.ok(work !== undefined);
  assert.equal(work.kind, 'worker');
  if (work.kind !== 'worker') {
    assert.fail('expected a worker node');
  }
  assert.deepEqual(work.config, {
    command: 'node',
    args: [],
    cwd: '.',
    timeoutMs: 60_000,
  });

  const explicit = parseComposition(
    workerComposition({
      command: 'node',
      args: ['scripts/check.mjs', '--strict'],
      cwd: 'sub',
      timeoutMs: 1500,
    }),
  );
  const explicitWork = explicit.nodes.get('work');
  assert.ok(explicitWork !== undefined && explicitWork.kind === 'worker');
  assert.deepEqual(explicitWork.config, {
    command: 'node',
    args: ['scripts/check.mjs', '--strict'],
    cwd: 'sub',
    timeoutMs: 1500,
  });
  assert.notEqual(composition.graphRevision, explicit.graphRevision);

  const otherArgs = parseComposition(
    workerComposition({ command: 'node', args: ['other.mjs'] }),
  );
  assert.notEqual(explicit.graphRevision, otherArgs.graphRevision);
});

test('rejects malformed worker commands, args, cwd and timeout', () => {
  assert.ok(
    issuesOf(workerComposition({})).some((issue) => issue.includes('command: expected a non-empty string')),
  );
  assert.ok(
    issuesOf(workerComposition({ command: '   ' })).some((issue) =>
      issue.includes('command: expected a non-empty string'),
    ),
  );
  assert.ok(
    issuesOf(workerComposition({ command: 'node', args: '--check' })).some((issue) =>
      issue.includes('args: expected an array of strings'),
    ),
  );
  assert.ok(
    issuesOf(workerComposition({ command: 'node', args: ['ok', 3] })).some((issue) =>
      issue.includes('args[1]: expected a string'),
    ),
  );
  assert.ok(
    issuesOf(workerComposition({ command: 'node', args: ['a\0b'] })).some((issue) =>
      issue.includes('must not contain a NUL character'),
    ),
  );
  assert.ok(
    issuesOf(workerComposition({ command: 'node', cwd: '' })).some((issue) =>
      issue.includes('cwd: expected a non-empty string'),
    ),
  );
  assert.ok(
    issuesOf(workerComposition({ command: 'node', cwd: '../outside' })).some((issue) =>
      issue.includes("cwd: must not contain '..'"),
    ),
  );
  assert.ok(
    issuesOf(workerComposition({ command: 'node', timeoutMs: 0 })).some((issue) =>
      issue.includes('timeoutMs: expected a positive integer'),
    ),
  );
  assert.ok(
    issuesOf(workerComposition({ command: 'node', timeoutMs: 1.5 })).some((issue) =>
      issue.includes('timeoutMs: expected a positive integer'),
    ),
  );
  assert.ok(
    issuesOf(workerComposition({ command: 'node', shell: true })).some((issue) =>
      issue.includes("unknown field 'shell'"),
    ),
  );
});

test('parses a condition when-rule and rejects malformed rules', () => {
  const composition = parseComposition(
    conditionComposition({ when: { path: 'message', equals: 'go' } }),
  );
  const check = composition.nodes.get('check');
  assert.ok(check !== undefined);
  assert.equal(check.kind, 'condition');
  if (check.kind !== 'condition') {
    assert.fail('expected a condition node');
  }
  assert.deepEqual(check.config, { when: { path: 'message', equals: 'go' } });

  const legacy = issuesOf(conditionComposition({ mode: 'worker', command: 'node' }));
  assert.ok(legacy.some((issue) => issue.includes("unknown field 'mode'")));
  assert.ok(legacy.some((issue) => issue.includes('when: expected a rule object')));

  const ambiguous = issuesOf(
    conditionComposition({ when: { path: 'message', equals: 'a', type: 'string' } }),
  );
  assert.ok(ambiguous.some((issue) => issue.includes('exactly one of')));
});

test('worker nodes obey the normal-node edge shape', () => {
  const single = parseComposition(workerComposition({ command: 'node' }));
  assert.equal(single.nodes.get('work')?.kind, 'worker');

  const double = workerComposition({ command: 'node' });
  double['nodes'] = {
    work: { kind: 'worker', config: { command: 'node' } },
    a: { kind: 'forager', config: { connection: 'codex', prompt: 'a' } },
    b: { kind: 'forager', config: { connection: 'codex', prompt: 'b' } },
  };
  double['edges'] = [
    { id: 'e1', from: 'work', to: 'a' },
    { id: 'e2', from: 'work', to: 'b' },
  ];
  assert.ok(
    issuesOf(double).some((issue) => issue.includes('worker node has at most one outgoing edge')),
  );

  const when = workerComposition({ command: 'node' });
  when['nodes'] = {
    work: { kind: 'worker', config: { command: 'node' } },
    next: { kind: 'forager', config: { connection: 'codex', prompt: 'next' } },
  };
  when['edges'] = [{ id: 'e1', from: 'work', to: 'next', when: 'true' }];
  assert.ok(issuesOf(when).some((issue) => issue.includes("'when' is only allowed")));
});
