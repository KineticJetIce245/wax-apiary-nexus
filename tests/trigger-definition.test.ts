import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CompositionValidationError,
  parseComposition,
} from '../src/runtime/index.js';

function composition(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: 'scheduled',
    nodes: {
      plan: { kind: 'forager', config: { connection: 'codex', prompt: 'plan {{input}}' } },
      work: {
        kind: 'worker',
        config: { command: 'node', args: ['-e', 'process.exit(0)'] },
      },
      ask: { kind: 'user', config: { modality: 'text', prompt: 'Ask?' } },
      check: { kind: 'condition', config: { mode: 'text', contains: 'go' } },
      yes: { kind: 'forager', config: { connection: 'codex', prompt: 'yes' } },
      no: { kind: 'forager', config: { connection: 'codex', prompt: 'no' } },
    },
    edges: [
      { id: 'e1', from: 'check', to: 'yes', when: 'true' },
      { id: 'e2', from: 'check', to: 'no', when: 'false' },
    ],
    ...overrides,
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

test('parses at and every scheduled triggers', () => {
  const parsed = parseComposition(
    composition({
      triggers: [
        {
          id: 'morning',
          target: 'plan',
          schedule: { kind: 'at', at: '2026-11-06T09:00:00-05:00' },
        },
        {
          id: 'hourly',
          target: 'work',
          schedule: { kind: 'every', everyMs: 3_600_000 },
        },
      ],
    }),
  );

  assert.deepEqual(parsed.triggers, [
    {
      id: 'morning',
      target: 'plan',
      schedule: { kind: 'at', at: '2026-11-06T09:00:00-05:00' },
    },
    {
      id: 'hourly',
      target: 'work',
      schedule: { kind: 'every', everyMs: 3_600_000 },
    },
  ]);
});

test('accepts a missing or empty triggers array', () => {
  assert.deepEqual(parseComposition(composition()).triggers, []);
  assert.deepEqual(parseComposition(composition({ triggers: [] })).triggers, []);
});

test('rejects an at timestamp without Z or an explicit offset', () => {
  const issues = issuesOf(
    composition({
      triggers: [
        {
          id: 'local',
          target: 'plan',
          schedule: { kind: 'at', at: '2026-11-06T09:00:00' },
        },
      ],
    }),
  );

  assert.ok(issues.some((issue) => issue.includes('timezone-less times are rejected')));
});

test('rejects everyMs below one second and non-integers', () => {
  for (const everyMs of [999, 0, -1000, 1000.5, '1000']) {
    const issues = issuesOf(
      composition({
        triggers: [{ id: 'too-fast', target: 'plan', schedule: { kind: 'every', everyMs } }],
      }),
    );
    assert.ok(
      issues.some((issue) => issue.includes('everyMs: expected an integer >= 1000')),
      `everyMs ${String(everyMs)} should be rejected`,
    );
  }

  const accepted = parseComposition(
    composition({
      triggers: [{ id: 'one-second', target: 'plan', schedule: { kind: 'every', everyMs: 1000 } }],
    }),
  );
  assert.equal(accepted.triggers.length, 1);
});

test('rejects duplicate trigger ids and invalid schedule kinds', () => {
  const duplicate = issuesOf(
    composition({
      triggers: [
        { id: 'same', target: 'plan', schedule: { kind: 'every', everyMs: 1000 } },
        { id: 'same', target: 'work', schedule: { kind: 'every', everyMs: 1000 } },
      ],
    }),
  );
  assert.ok(duplicate.some((issue) => issue.includes("duplicate trigger id 'same'")));

  const badKind = issuesOf(
    composition({
      triggers: [{ id: 'bad', target: 'plan', schedule: { kind: 'cron', cron: '* * * * *' } }],
    }),
  );
  assert.ok(badKind.some((issue) => issue.includes("schedule.kind: expected 'at' or 'every'")));
});

test('rejects scheduled control, user and unknown targets', () => {
  const control = issuesOf(
    composition({
      triggers: [{ id: 'control', target: 'check', schedule: { kind: 'every', everyMs: 1000 } }],
    }),
  );
  assert.ok(
    control.some((issue) =>
      issue.includes("scheduled trigger target 'check' must be a forager or worker node"),
    ),
  );

  const user = issuesOf(
    composition({
      triggers: [{ id: 'human', target: 'ask', schedule: { kind: 'every', everyMs: 1000 } }],
    }),
  );
  assert.ok(user.some((issue) => issue.includes('scheduled user triggers are deferred')));

  const unknown = issuesOf(
    composition({
      triggers: [{ id: 'ghost', target: 'ghost', schedule: { kind: 'every', everyMs: 1000 } }],
    }),
  );
  assert.ok(unknown.some((issue) => issue.includes("unknown node 'ghost'")));
});

test('rejects unknown trigger and schedule fields', () => {
  const triggerFields = issuesOf(
    composition({
      triggers: [
        { id: 't', target: 'plan', schedule: { kind: 'every', everyMs: 1000 }, extra: true },
      ],
    }),
  );
  assert.ok(triggerFields.some((issue) => issue.includes("unknown field 'extra'")));

  const scheduleFields = issuesOf(
    composition({
      triggers: [
        { id: 't', target: 'plan', schedule: { kind: 'at', at: '2026-11-06T09:00:00Z', x: 1 } },
      ],
    }),
  );
  assert.ok(scheduleFields.some((issue) => issue.includes("unknown field 'x'")));
});

test('a trigger schedule change does not change the graph revision', () => {
  const first = parseComposition(
    composition({
      triggers: [{ id: 't', target: 'plan', schedule: { kind: 'every', everyMs: 1000 } }],
    }),
  );
  const second = parseComposition(
    composition({
      triggers: [{ id: 't', target: 'plan', schedule: { kind: 'every', everyMs: 2000 } }],
    }),
  );

  assert.equal(first.graphRevision, second.graphRevision);
});
