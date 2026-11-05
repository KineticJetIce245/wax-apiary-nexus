import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { HoneyStore } from '../src/honey.js';
import {
  parseComposition,
  PheromoneRuntime,
  renderPrompt,
  serializeValue,
  type CompositionDefinition,
  type NodeExecutor,
  type Value,
} from '../src/runtime/index.js';

const START = Date.parse('2026-07-01T00:00:00.000Z');

function structured(value: unknown): Value {
  return { kind: 'structured', value } as unknown as Value;
}

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'wax-structured-'));
}

function passthrough(): NodeExecutor {
  return {
    async execute(_node, input) {
      return input;
    },
  };
}

/** One terminal Forager; enough to exercise trigger validation and Honey. */
function triggerComposition(): CompositionDefinition {
  return parseComposition({
    schemaVersion: 1,
    id: 'structured-trigger',
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'start {{input}}' } },
    },
    edges: [],
  });
}

/** start -> check -> yes/no; the Condition uses its text mode. */
function conditionComposition(): CompositionDefinition {
  return parseComposition({
    schemaVersion: 1,
    id: 'structured-condition',
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt: 'start {{input}}' } },
      check: { kind: 'condition', config: { mode: 'text', contains: '"go":true' } },
      yes: { kind: 'forager', config: { connection: 'codex', prompt: 'yes' } },
      no: { kind: 'forager', config: { connection: 'codex', prompt: 'no' } },
    },
    edges: [
      { id: 'e1', from: 'start', to: 'check' },
      { id: 'e2', from: 'check', to: 'yes', when: 'true' },
      { id: 'e3', from: 'check', to: 'no', when: 'false' },
    ],
  });
}

test('accepts every JSON-safe payload shape and keeps it intact', () => {
  const payloads: readonly unknown[] = [
    null,
    true,
    false,
    0,
    -1.5,
    'text',
    [],
    [1, 'a', null, { nested: true }],
    {},
    { a: { b: [1, 2] }, z: null },
  ];

  for (const payload of payloads) {
    const runtime = new PheromoneRuntime(triggerComposition(), {
      executeForager: passthrough(),
      now: () => START,
    });
    runtime.trigger('start', structured(payload));
    assert.deepEqual(
      runtime.snapshot().pheromones[0]?.value,
      { kind: 'structured', value: payload },
      `expected ${JSON.stringify(payload) ?? String(payload)} to round-trip`,
    );
  }
});

test('a structured payload may contain existing Value objects', () => {
  const input = structured({
    message: { kind: 'message', text: 'hello', attachments: [] },
    text: { kind: 'text', text: 'x' },
    list: [{ kind: 'choice', choice: 'a' }, { kind: 'boolean', value: false }],
  });
  const runtime = new PheromoneRuntime(triggerComposition(), {
    executeForager: passthrough(),
    now: () => START,
  });

  runtime.trigger('start', input);

  assert.deepEqual(runtime.snapshot().pheromones[0]?.value, input);
});

test('rejects payloads that JSON cannot round-trip', () => {
  const cyclic: Record<string, unknown> = {};
  cyclic['self'] = cyclic;
  const cases: readonly {
    readonly label: string;
    readonly payload: unknown;
    readonly error: RegExp;
  }[] = [
    { label: 'undefined', payload: undefined, error: /undefined is not JSON-safe/ },
    { label: 'function', payload: () => 1, error: /function is not JSON-safe/ },
    { label: 'bigint', payload: 10n, error: /bigint is not JSON-safe/ },
    { label: 'symbol', payload: Symbol('x'), error: /symbol is not JSON-safe/ },
    { label: 'NaN', payload: Number.NaN, error: /non-finite numbers are not JSON-safe/ },
    { label: 'Infinity', payload: Infinity, error: /non-finite numbers are not JSON-safe/ },
    { label: '-Infinity', payload: -Infinity, error: /non-finite numbers are not JSON-safe/ },
    { label: 'cycle', payload: cyclic, error: /a cycle is not JSON-safe/ },
    { label: 'Date', payload: new Date(START), error: /only plain objects are JSON-safe/ },
    {
      label: 'nested undefined',
      payload: { nested: undefined },
      error: /\.nested: undefined is not JSON-safe/,
    },
    {
      label: 'nested function',
      payload: { list: [() => 1] },
      error: /\.list\[0\]: function is not JSON-safe/,
    },
  ];

  for (const { label, payload, error } of cases) {
    const runtime = new PheromoneRuntime(triggerComposition(), {
      executeForager: passthrough(),
      now: () => START,
    });
    assert.throws(() => runtime.trigger('start', structured(payload)), error, label);
  }

  // A shared child is JSON-safe; only an ancestor cycle is rejected.
  const shared = { ok: true };
  const runtime = new PheromoneRuntime(triggerComposition(), {
    executeForager: passthrough(),
    now: () => START,
  });
  assert.doesNotThrow(() =>
    runtime.trigger('start', structured({ left: shared, right: shared })),
  );
});

test('rejects a structured executor output with an invalid payload', async () => {
  const runtime = new PheromoneRuntime(triggerComposition(), {
    executeForager: {
      async execute() {
        return structured({ nested: undefined });
      },
    },
    now: () => START,
  });

  runtime.trigger('start', { kind: 'text', text: 'seed' });
  await assert.rejects(runtime.pump(), /undefined is not JSON-safe/);
});

test('serializeValue renders structured as JSON and renderPrompt uses it', () => {
  const input = structured({ b: [true, null], a: 'x' });

  assert.equal(serializeValue(input), '{"b":[true,null],"a":"x"}');
  assert.equal(
    renderPrompt('before {{input}} after', input),
    'before {"b":[true,null],"a":"x"} after',
  );
  assert.equal(serializeValue(structured('hi')), '"hi"');
  assert.equal(serializeValue(structured(null)), 'null');
  assert.equal(serializeValue(structured([1, false])), '[1,false]');
});

test('Condition text mode compares the JSON serialization', async () => {
  const calls: string[] = [];
  const runtime = new PheromoneRuntime(conditionComposition(), {
    executeForager: {
      async execute(node, input) {
        calls.push(node.id);
        return input;
      },
    },
    now: () => START,
  });

  runtime.trigger('start', structured({ go: true, note: 'ok' }));
  await runtime.pump();

  assert.deepEqual(calls, ['start', 'yes']);
  assert.equal(runtime.snapshot().rest, true);
});

test('Honey persists and restores a structured Value without flattening', async () => {
  const definition = triggerComposition();
  const input = structured({
    textValue: { kind: 'text', text: 'hello' },
    list: [1, true, null],
    nested: { ok: false },
  });
  const received: Value[] = [];
  const executor: NodeExecutor = {
    async execute(_node, value) {
      received.push(value);
      return value;
    },
  };
  const runtime = new PheromoneRuntime(definition, {
    executeForager: executor,
    now: () => START,
  });
  runtime.trigger('start', input);

  const store = HoneyStore.forComposition(tempRoot(), 'apiary', 'structured-honey');
  const field = runtime.exportField();
  store.save(field);
  const raw = readFileSync(store.paths.field, 'utf8');
  assert.match(raw, /"kind": "structured"/);
  assert.match(raw, /"text": "hello"/);

  const loaded = store.load();
  assert.ok(loaded !== undefined);
  assert.deepEqual(loaded, field);

  const restored = PheromoneRuntime.restore(definition, loaded, {
    executeForager: executor,
    now: () => START,
  }).runtime;
  await restored.pump();

  assert.deepEqual(received, [input]);
  assert.equal(restored.snapshot().rest, true);
});

test('Honey rejects a structured Value without a JSON-safe payload', () => {
  const store = HoneyStore.forComposition(tempRoot(), 'apiary', 'structured-bad');
  store.save({
    schemaVersion: 1,
    compositionId: 'structured-bad',
    graphRevision: 'rev',
    rest: false,
    nodes: {},
  });
  writeFileSync(
    store.paths.field,
    JSON.stringify({
      schemaVersion: 1,
      compositionId: 'structured-bad',
      graphRevision: 'rev',
      rest: false,
      nodes: {
        start: {
          queue: [
            {
              id: 'ph_bad',
              traceId: 'tr_bad',
              at: new Date(START).toISOString(),
              value: { kind: 'structured' },
            },
          ],
        },
      },
    }),
  );

  assert.throws(() => store.load(), /undefined is not JSON-safe/);
});
