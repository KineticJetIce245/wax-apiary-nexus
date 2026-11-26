import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertJsonValue,
  assertValue,
  isAttachment,
  parseComposition,
  PheromoneRuntime,
  type Value,
} from '../src/runtime/index.js';
import { fastDefinition, text } from './support/m19-runtime.js';

function definition() {
  return fastDefinition('free-json', {
    start: { kind: 'forager', config: { connection: 'fake', prompt: 'x' } },
  });
}

function passthrough(): PheromoneRuntime {
  return new PheromoneRuntime(definition(), {
    executeForager: { async execute(_node, input) { return input; } },
    now: () => Date.parse('2026-07-01T00:00:00.000Z'),
  });
}

test('a Value is any free JSON object: message, attachments, arbitrary fields', () => {
  const value: Value = {
    message: 'hello',
    attachments: [{ path: '/tmp/a.png', mediaType: 'image/png' }],
    meta: { topic: 'review', score: 3 },
    list: [1, 'two', null, { nested: true }],
    flag: false,
    count: 0,
  };
  assertValue(value);
  assert.doesNotThrow(() => assertJsonValue(value));
  assert.deepEqual(Object.keys(value).sort(), [
    'attachments',
    'count',
    'flag',
    'list',
    'message',
    'meta',
  ]);
  assert.equal(isAttachment({ path: '/tmp/a.png' }), true);
  assert.equal(isAttachment({ path: '' }), false);
  assert.equal(isAttachment({ path: '/a', kind: 'image' }), false);
});

test('a Value root is a JSON object, not an array or null', () => {
  assert.throws(() => assertValue(null), /JSON object/);
  assert.throws(() => assertValue([]), /JSON object/);
  assert.throws(() => assertValue('text'), /JSON object/);
  assert.throws(() => assertValue({ nested: undefined }), /undefined/);
  assert.throws(() => assertValue({ n: Number.NaN }), /non-finite/);
  assert.throws(() => assertValue({ fn: () => undefined }), /function/);
});

test('cycles, BigInts, symbols and non-plain objects are not JSON-safe', () => {
  const cyclic: Record<string, unknown> = {};
  cyclic['self'] = cyclic;
  assert.throws(() => assertValue(cyclic), /cycle/);
  assert.throws(() => assertValue({ big: 1n as unknown as boolean }), /bigint/);
  const symbolKeyed = { ok: true } as Record<symbol, boolean> & Value;
  Object.defineProperty(symbolKeyed, Symbol('x'), { value: true, enumerable: true });
  assert.throws(() => assertValue(symbolKeyed), /symbol/);
  assert.throws(() => assertValue({ date: new Date() }), /plain object/);
});

test('the field keeps the admitted free JSON value and moves it by reference', async () => {
  const runtime = passthrough();
  const input: Value = { message: 'go', meta: { topic: 't' }, items: [1, 2] };
  await runtime.admit('start', input);

  const entry = runtime.snapshot().nodes['start']?.receptor[0];
  assert.ok(entry !== undefined);
  assert.deepEqual(entry.value, input);

  await runtime.pump();
  const output = runtime.snapshot().nodes['start']?.lastOutput;
  assert.deepEqual(output, input);
  assert.equal(runtime.snapshot().rest, true);
});

test('null is a normal field value; a structured wrapper is gone', async () => {
  const runtime = passthrough();
  const input: Value = { message: null, custom: { nested: null } };
  assertValue(input);
  await runtime.admit('start', input);
  await runtime.pump();
  assert.deepEqual(runtime.snapshot().nodes['start']?.lastOutput, input);
});

test('a value with a legacy kind field is ordinary data, not a tag', async () => {
  const runtime = passthrough();
  const input: Value = { kind: 'text', text: 'arbitrary data', message: 'kept' };
  await runtime.admit('start', input);
  await runtime.pump();
  assert.deepEqual(runtime.snapshot().nodes['start']?.lastOutput, input);
});

test('the runtime rejects a non-object trigger value', async () => {
  const runtime = passthrough();
  await assert.rejects(runtime.admit('start', [] as unknown as Value), /JSON object/);
});

test('Honey v2 persists free JSON and rejects the old structured wrapper', () => {
  const runtime = passthrough();
  const field = runtime.exportField();
  assert.equal(field.schemaVersion, 2);
  assert.deepEqual(Object.keys(field), [
    'schemaVersion',
    'compositionId',
    'graphRevision',
    'rest',
    'nodes',
  ]);
  assert.equal(text('x')['message'], 'x');
});
