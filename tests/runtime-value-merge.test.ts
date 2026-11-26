import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyDrop,
  applyWriteBack,
  assertNoDropOverlap,
  deepMerge,
  deletePath,
  getPath,
  isSubtreePath,
  isValidPath,
  parsePath,
  setPath,
  ValueDropOverlapError,
  ValuePathError,
  type Value,
} from '../src/runtime/index.js';

test('dot paths read, write and delete nested JSON', () => {
  const value: Value = { message: 'hi', meta: { topic: 'review', tags: ['a', 'b'] } };
  assert.deepEqual(getPath(value, 'meta.topic'), { found: true, value: 'review' });
  assert.deepEqual(getPath(value, 'meta.tags.1'), { found: true, value: 'b' });
  assert.equal(getPath(value, 'meta.missing').found, false);
  assert.equal(getPath(value, 'meta.tags.nope').found, false);

  setPath(value, 'meta.score', 3);
  assert.deepEqual(value['meta'], { topic: 'review', tags: ['a', 'b'], score: 3 });
  setPath(value, 'new.branch.leaf', null);
  assert.deepEqual(getPath(value, 'new.branch.leaf'), { found: true, value: null });

  assert.equal(deletePath(value, 'meta.score'), true);
  assert.equal(deletePath(value, 'meta.score'), false);
});

test('paths reject empty segments, array indices in writes and prototype keys', () => {
  for (const path of ['', '.message', 'message.', 'meta..topic', 'a/b', 'items.0']) {
    assert.equal(isValidPath(path, 'write'), false, path);
  }
  assert.equal(isValidPath('items.0', 'read'), true);
  for (const path of ['__proto__', 'meta.__proto__', 'constructor', 'prototype.polluted']) {
    assert.equal(isValidPath(path, 'read'), false, path);
    assert.throws(() => parsePath(path), ValuePathError);
  }
  assert.equal(isValidPath('meta.topic', 'read'), true);
  assert.equal(isSubtreePath('meta.topic', 'meta'), true);
  assert.equal(isSubtreePath('metadata', 'meta'), false);
});

test('deep merge recurses into objects and replaces arrays, scalars and null', () => {
  const base: Value = {
    message: 'hello',
    meta: { topic: 'a', score: 1 },
    items: [1, 2],
    flag: true,
    nullable: { keep: true },
  };
  const patch: Value = {
    message: 'updated',
    meta: { score: 2, extra: null },
    items: [3],
    flag: false,
    nullable: null,
    added: { deep: 'x' },
  };
  assert.deepEqual(deepMerge(base, patch), {
    message: 'updated',
    meta: { topic: 'a', score: 2, extra: null },
    items: [3],
    flag: false,
    nullable: null,
    added: { deep: 'x' },
  });
  // Inputs are not mutated by the pure form.
  assert.deepEqual(base['items'], [1, 2]);
  assert.deepEqual(base['meta'], { topic: 'a', score: 1 });
});

test('write-back returns the merged value and applies drop afterwards', () => {
  const original: Value = {
    message: 'old',
    meta: { topic: 't', debug: 'secret' },
    items: [1],
  };
  const applied = applyWriteBack(original, {
    message: 'new',
    meta: { score: 2 },
    extra: [1, 2],
  }, ['meta.debug', 'not.there']);

  assert.deepEqual(applied.value, {
    message: 'new',
    meta: { topic: 't', score: 2 },
    items: [1],
    extra: [1, 2],
  });
  assert.deepEqual(applied.dropped, ['meta.debug']);
  assert.deepEqual(applied.missing, ['not.there']);
  // The previous value is never mutated by write-back.
  assert.deepEqual(original, {
    message: 'old',
    meta: { topic: 't', debug: 'secret' },
    items: [1],
  });
});

test('dropping a missing path is a logged no-op, not an error', () => {
  const value: Value = { message: 'x' };
  const missing: string[] = [];
  const applied = applyDrop(value, ['meta.missing'], (path) => missing.push(path));
  assert.deepEqual(applied.dropped, []);
  assert.deepEqual(applied.missing, ['meta.missing']);
  assert.deepEqual(missing, ['meta.missing']);
  assert.deepEqual(value, { message: 'x' });
});

test('an array index in a drop path is a configuration error', () => {
  const value: Value = { items: [1, 2, 3] };
  assert.throws(() => applyDrop(value, ['items.0']), ValuePathError);
  assert.deepEqual(value, { items: [1, 2, 3] });
});

test('a result may not carry a value and a drop for the same path', () => {
  assert.throws(
    () => assertNoDropOverlap({ meta: { debug: 'x' } }, ['meta.debug']),
    ValueDropOverlapError,
  );
  assert.throws(
    () => applyWriteBack({}, { meta: { debug: 'x' } }, ['meta.debug']),
    /same path/,
  );
  // A parent drop does not overlap a sibling value.
  assert.doesNotThrow(() => assertNoDropOverlap({ meta: { keep: 1 } }, ['other']));
});

test('null is a normal merge value and never deletes the key', () => {
  const applied = applyWriteBack({ a: { b: 1 } }, { a: null });
  assert.deepEqual(applied.value, { a: null });
});
