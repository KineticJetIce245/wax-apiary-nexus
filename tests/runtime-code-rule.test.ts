import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CompositionValidationError,
  evaluateGroupKey,
  matchesRule,
  parseComposition,
  RuleExecutionError,
  runCodeRule,
  type Rule,
  type Value,
} from '../src/runtime/index.js';
import {
  fastDefinition,
  recorder,
  runtimeOf,
} from './support/m19-runtime.js';

async function branchOf(when: Record<string, unknown>, value: Value): Promise<string> {
  const definition = fastDefinition(
    'rule',
    {
      check: { kind: 'condition', config: { when } },
      yes: { kind: 'user', config: { modality: 'text', prompt: 'yes?' } },
      no: { kind: 'user', config: { modality: 'text', prompt: 'no?' } },
    },
    [
      { id: 't', from: 'check', to: 'yes', when: 'true' },
      { id: 'f', from: 'check', to: 'no', when: 'false' },
    ],
  );
  const runtime = runtimeOf(definition, recorder().executor);
  await runtime.admit('check', value);
  await runtime.pump();
  const snapshot = runtime.snapshot();
  if (snapshot.nodes['yes']?.hover !== undefined) {
    return 'true';
  }
  if (snapshot.nodes['no']?.hover !== undefined) {
    return 'false';
  }
  return 'none';
}

test('declarative rules cover equals, oneOf, exists and type', async () => {
  assert.equal(await branchOf({ path: 'kind', equals: 'review' }, { kind: 'review' }), 'true');
  assert.equal(await branchOf({ path: 'kind', equals: 'review' }, { kind: 'draft' }), 'false');
  assert.equal(
    await branchOf({ path: 'kind', oneOf: ['draft', 'review'] }, { kind: 'review' }),
    'true',
  );
  assert.equal(await branchOf({ path: 'kind', oneOf: ['draft'] }, { kind: 'review' }), 'false');
  assert.equal(await branchOf({ path: 'meta.topic', exists: true }, { meta: { topic: 1 } }), 'true');
  assert.equal(await branchOf({ path: 'meta.topic', exists: true }, { meta: {} }), 'false');
  assert.equal(await branchOf({ path: 'count', type: 'number' }, { count: 2 }), 'true');
  assert.equal(await branchOf({ path: 'count', type: 'string' }, { count: 2 }), 'false');
  assert.equal(await branchOf({ path: 'items', type: 'array' }, { items: [] }), 'true');
  assert.equal(await branchOf({ path: 'flag', type: 'null' }, { flag: null }), 'true');
});

test('a code rule returns a boolean and branches like a declarative rule', async () => {
  assert.equal(
    await branchOf({ code: "return value.kind === 'review';" }, { kind: 'review' }),
    'true',
  );
  assert.equal(
    await branchOf({ code: "return value.kind === 'review';" }, { kind: 'draft' }),
    'false',
  );
  assert.equal(
    await branchOf(
      { code: "return helpers.getPath(value, 'meta.topic') === 'release';" },
      { meta: { topic: 'release' } },
    ),
    'true',
  );
});

test('a code rule cannot see process, require or console', () => {
  const result = runCodeRule(
    [
      "if (typeof process !== 'undefined') throw new Error('process');",
      "if (typeof require !== 'undefined') throw new Error('require');",
      "if (typeof console !== 'undefined') throw new Error('console');",
      'return true;',
    ].join('\n'),
    { message: 'x' },
    'test',
  );
  assert.equal(result, true);
});

test('the code-rule helpers are frozen and read paths only', () => {
  const result = runCodeRule(
    [
      'let frozen = false;',
      'try { helpers.extra = 1; } catch { frozen = true; }',
      "if (!Object.isFrozen(helpers)) throw new Error('not frozen');",
      "return helpers.getPath(value, 'meta.topic') === 'release';",
    ].join('\n'),
    { meta: { topic: 'release' } },
    'test',
  );
  assert.equal(result, true);
});

test('a code rule receives a clone, so it cannot mutate the field value', () => {
  const value: Value = { message: 'original' };
  const result = runCodeRule(
    "value.message = 'mutated'; return value.message;",
    value,
    'test',
  );
  assert.equal(result, 'mutated');
  assert.deepEqual(value, { message: 'original' });
});

test('a throw, timeout or wrong result type is a typed rule error', async () => {
  await assert.rejects(
    branchOf({ code: "throw new Error('nope');" }, { message: 'x' }),
    (error: unknown) => error instanceof RuleExecutionError && /nope/.test(error.message),
  );
  await assert.rejects(
    branchOf({ code: 'return 1;' }, { message: 'x' }),
    (error: unknown) => error instanceof RuleExecutionError && /boolean/.test(error.message),
  );
  await assert.rejects(
    branchOf({ code: 'while (true) {}' }, { message: 'x' }),
    (error: unknown) => error instanceof RuleExecutionError && /timed out/.test(error.message),
  );
});

test('a code rule is syntax-checked at parse time', () => {
  assert.throws(
    () =>
      parseComposition({
        schemaVersion: 1,
        id: 'syntax',
        nodes: {
          check: { kind: 'condition', config: { when: { code: 'return (' } } },
          yes: { kind: 'user', config: { modality: 'text', prompt: 'yes?' } },
          no: { kind: 'user', config: { modality: 'text', prompt: 'no?' } },
        },
        edges: [
          { id: 't', from: 'check', to: 'yes', when: 'true' },
          { id: 'f', from: 'check', to: 'no', when: 'false' },
        ],
      }),
    (error: unknown) => {
      assert.ok(error instanceof CompositionValidationError);
      assert.ok(error.issues.some((issue) => issue.includes('syntax error')));
      return true;
    },
  );
});

test('matchesRule evaluates a parsed rule without a runtime', () => {
  const rule: Rule = { path: 'meta.topic', equals: 'release' };
  assert.equal(matchesRule(rule, { meta: { topic: 'release' } }, 'test'), true);
  assert.equal(matchesRule(rule, { meta: {} }, 'test'), false);
});

test('a group key is a non-empty string from a path or a code block', () => {
  assert.equal(
    evaluateGroupKey('meta.topic', { meta: { topic: 'release' } }, 'test'),
    'release',
  );
  assert.equal(
    evaluateGroupKey({ code: 'return `${value.meta.topic}:${value.lang}`;' }, {
      meta: { topic: 'release' },
      lang: 'en',
    }, 'test'),
    'release:en',
  );
  assert.throws(
    () => evaluateGroupKey('meta.missing', { meta: {} }, 'test'),
    RuleExecutionError,
  );
  assert.throws(
    () => evaluateGroupKey('meta.topic', { meta: { topic: '' } }, 'test'),
    RuleExecutionError,
  );
  assert.throws(
    () => evaluateGroupKey({ code: 'return 1;' }, { message: 'x' }, 'test'),
    RuleExecutionError,
  );
});
