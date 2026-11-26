import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BeeIoError,
  CompositionValidationError,
  createMemoryLog,
  parseComposition,
  PheromoneRuntime,
  renderPrompt,
  type BeeResult,
  type NodeExecutor,
  type RuntimeLogEntry,
  type Value,
} from '../src/runtime/index.js';
import {
  fastDefinition,
  recorder,
  runtimeOf,
  text,
} from './support/m19-runtime.js';

const START = Date.parse('2026-03-01T00:00:00.000Z');

function runtimeWith(
  definition: ReturnType<typeof parseComposition>,
  executor: NodeExecutor,
  onLog?: (entry: RuntimeLogEntry) => void,
): PheromoneRuntime {
  return new PheromoneRuntime(definition, {
    executeForager: executor,
    now: () => START,
    ...(onLog === undefined ? {} : { onLog }),
  });
}

function scripted(
  output: (nodeId: string, input: Value) => Value | BeeResult,
): { readonly executor: NodeExecutor; readonly inputs: { nodeId: string; input: Value }[] } {
  const inputs: { nodeId: string; input: Value }[] = [];
  return {
    inputs,
    executor: {
      async execute(node, input) {
        inputs.push({ nodeId: node.id, input });
        return output(node.id, input);
      },
    },
  };
}

test('built-in I/O defaults match the ARCH table and an instance may override them', () => {
  const definition = parseComposition({
    schemaVersion: 1,
    id: 'defaults',
    nodes: {
      f: { kind: 'forager', config: { connection: 'c', prompt: 'go {{message}}' } },
      w: { kind: 'worker', config: { command: 'node' } },
      c: { kind: 'condition', config: { when: { path: 'flag', equals: true } } },
      k: { kind: 'counter', config: { max: 1 } },
      u: { kind: 'user', config: { modality: 'text', prompt: '?' } },
      s: { kind: 'spread', config: { strategy: 'clone', targets: ['f'] } },
      g: {
        kind: 'gather',
        config: {
          strategy: 'assemble',
          types: { x: { match: { path: 'kind', equals: 'x' }, count: 1, reads: [] } },
        },
      },
    },
    edges: [
      { id: 'ct', from: 'c', to: 'f', when: 'true' },
      { id: 'cf', from: 'c', to: 'f', when: 'false' },
      { id: 'kc', from: 'k', to: 'f', when: 'continue' },
      { id: 'kd', from: 'k', to: 'f', when: 'done' },
    ],
  });

  const io = (id: string) => {
    const node = definition.nodes.get(id);
    assert.ok(node !== undefined, id);
    return { reads: node.reads, writes: node.writes };
  };
  assert.deepEqual(io('f'), { reads: ['message'], writes: ['message'] });
  assert.deepEqual(io('w'), { reads: [], writes: ['message'] });
  for (const id of ['c', 'k', 'u', 's', 'g']) {
    assert.deepEqual(io(id), { reads: [], writes: [] }, id);
  }
});

test('an instance may override the built-in I/O with fallback and filter', () => {
  const overridden = parseComposition({
    schemaVersion: 1,
    id: 'override',
    nodes: {
      f: {
        kind: 'forager',
        config: { connection: 'c', prompt: 'p' },
        reads: ['meta.topic'],
        writes: [],
        fallback: { 'meta.topic': 'static' },
        filter: { allow: ['message'], deny: ['meta.debug'] },
      },
    },
  });
  const node = overridden.nodes.get('f');
  assert.ok(node !== undefined);
  assert.deepEqual(node.reads, ['meta.topic']);
  assert.deepEqual(node.writes, []);
  assert.deepEqual(node.fallback, { 'meta.topic': 'static' });
  assert.deepEqual(node.filter, { allow: ['message'], deny: ['meta.debug'] });
});

test('reads resolve from the value and a static fallback patches only the input', async () => {
  const definition = fastDefinition(
    'reads',
    {
      start: {
        kind: 'forager',
        config: { connection: 'c', prompt: '{{message}}|{{meta.topic}}' },
        reads: ['message', 'meta.topic'],
        fallback: { 'meta.topic': 'fallback-topic' },
      },
      next: {
        kind: 'forager',
        config: { connection: 'c', prompt: 'next' },
        reads: [],
        writes: [],
      },
    },
    [{ id: 'e1', from: 'start', to: 'next' }],
  );
  const scriptedRun = scripted((nodeId, input) => {
    if (nodeId === 'start') {
      assert.deepEqual(input['meta'], { topic: 'fallback-topic' });
    } else {
      assert.equal(input['meta'], undefined, 'the fallback is not written back');
    }
    return { message: 'reply' };
  });
  const runtime = runtimeWith(definition, scriptedRun.executor);

  await runtime.admit('start', { message: 'hello' });
  await runtime.settle();

  assert.deepEqual(scriptedRun.inputs.map((call) => call.nodeId), ['start', 'next']);
  assert.deepEqual(scriptedRun.inputs[1]?.input, { message: 'reply' });
});

test('a missing declared read drops the input unless fallback supplies it', async () => {
  const log = createMemoryLog();
  const withoutFallback = fastDefinition('no-fallback', {
    start: {
      kind: 'forager',
      config: { connection: 'c', prompt: 'p' },
      reads: ['meta.topic'],
    },
  });
  const runtime = runtimeWith(withoutFallback, recorder().executor, log.sink);
  await runtime.admit('start', text('hello'));
  await runtime.settle();
  const failed = log.entries.find((entry) => entry.event === 'node.failed');
  assert.ok(failed !== undefined);
  assert.match(failed.error ?? '', /meta\.topic/);
  assert.equal(runtime.snapshot().nodes['start']?.active, undefined);
  assert.equal(runtime.snapshot().rest, true);

  const withFallback = fastDefinition('fallback', {
    start: {
      kind: 'forager',
      config: { connection: 'c', prompt: 'p' },
      reads: ['meta.topic'],
      fallback: { 'meta.topic': { nested: true } },
    },
  });
  const called = recorder();
  const fallbackRuntime = runtimeWith(withFallback, called.executor);
  await fallbackRuntime.admit('start', text('hello'));
  await fallbackRuntime.settle();
  assert.deepEqual(called.calls[0]?.input, {
    message: 'hello',
    meta: { topic: { nested: true } },
  });
});

test('a fallback may declare a prompt placeholder without a read list entry', async () => {
  const definition = fastDefinition('fallback-placeholder', {
    start: {
      kind: 'forager',
      config: { connection: 'c', prompt: 'topic={{meta.topic}}' },
      fallback: { 'meta.topic': 'static-topic' },
    },
  });
  const runtime = runtimeOf(definition, recorder().executor);
  await runtime.admit('start', text('hello'));
  await runtime.settle();
});

test('writes requires every declared path after filtering; null counts as present', async () => {
  const log = createMemoryLog();
  const missing = fastDefinition('missing-write', {
    start: {
      kind: 'forager',
      config: { connection: 'c', prompt: 'p' },
      writes: ['meta.note'],
    },
  });
  const startRun = scripted(() => ({ message: 'ok' }));
  const runtime = runtimeWith(missing, startRun.executor, log.sink);
  await runtime.admit('start', text('seed'));
  await runtime.settle();
  const failed = log.entries.find((entry) => entry.event === 'node.failed');
  assert.ok(failed !== undefined);
  assert.match(failed.error ?? '', /meta\.note/);
  assert.equal(runtime.snapshot().nodes['start']?.lastOutput, undefined);

  const nullPresent = fastDefinition('null-write', {
    start: {
      kind: 'forager',
      config: { connection: 'c', prompt: 'p' },
      writes: ['meta.note'],
    },
  });
  const nullRuntime = runtimeWith(
    nullPresent,
    scripted(() => ({ message: 'ok', meta: { note: null } })).executor,
  );
  await nullRuntime.admit('start', text('seed'));
  await nullRuntime.settle();
  assert.deepEqual(nullRuntime.snapshot().nodes['start']?.lastOutput, {
    message: 'ok',
    meta: { note: null },
  });

  const emptyWrites = fastDefinition('empty-writes', {
    start: {
      kind: 'forager',
      config: { connection: 'c', prompt: 'p' },
      writes: [],
    },
  });
  const extraRun = scripted(() => ({ other: true }));
  const extraRuntime = runtimeWith(emptyWrites, extraRun.executor);
  await extraRuntime.admit('start', text('seed'));
  await extraRuntime.settle();
  assert.deepEqual(extraRuntime.snapshot().nodes['start']?.lastOutput, { other: true });
});

test('writes is an assertion, not an allowlist: undeclared reply fields are merged', async () => {
  const definition = fastDefinition(
    'not-allowlist',
    {
      start: { kind: 'forager', config: { connection: 'c', prompt: 'p' }, writes: ['message'] },
      next: {
        kind: 'forager',
        config: { connection: 'c', prompt: 'next' },
        reads: [],
        writes: [],
      },
    },
    [{ id: 'e1', from: 'start', to: 'next' }],
  );
  const run = scripted(() => ({ message: 'ok', extra: { kept: 1 } }));
  const runtime = runtimeWith(definition, run.executor);
  await runtime.admit('start', text('seed'));
  await runtime.settle();
  assert.deepEqual(run.inputs[1]?.input, {
    message: 'ok',
    extra: { kept: 1 },
  });
});

test('filter applies allow then deny and logs only the removed paths', async () => {
  const log = createMemoryLog();
  const definition = fastDefinition(
    'filter',
    {
      start: {
        kind: 'forager',
        config: { connection: 'c', prompt: 'p' },
        writes: [],
        filter: { allow: ['message', 'meta.topic'], deny: ['meta.debug'] },
      },
    },
  );
  const runtime = runtimeWith(
    definition,
    scripted(() => ({
      message: 'ok',
      meta: { topic: 'topic', debug: 'secret', other: 'drop' },
      extra: 'drop',
    })).executor,
    log.sink,
  );
  await runtime.admit('start', text('seed'));
  await runtime.settle();

  assert.deepEqual(runtime.snapshot().nodes['start']?.lastOutput, {
    message: 'ok',
    meta: { topic: 'topic' },
  });
  const filtered = log.entries.find((entry) => entry.event === 'value.filtered');
  assert.ok(filtered !== undefined);
  assert.deepEqual([...(filtered.paths ?? [])].sort(), ['extra', 'meta.debug', 'meta.other']);
  assert.equal(JSON.stringify(log.entries).includes('secret'), false);
});

test('an allow filter drops ancestor containers that hold no allowed field', async () => {
  const definition = fastDefinition('allow-prune', {
    start: {
      kind: 'forager',
      config: { connection: 'c', prompt: 'p' },
      writes: [],
      filter: { allow: ['message', 'meta.topic'] },
    },
  });
  const runtime = runtimeWith(
    definition,
    scripted(() => ({ message: 'ok', meta: { debug: 'x' }, scalar: 1 })).executor,
  );
  await runtime.admit('start', text('seed'));
  await runtime.settle();
  assert.deepEqual(runtime.snapshot().nodes['start']?.lastOutput, {
    message: 'ok',
  });
});

test('a deny-only filter removes a subtree and leaves the rest', async () => {
  const definition = fastDefinition('deny', {
    start: {
      kind: 'forager',
      config: { connection: 'c', prompt: 'p' },
      writes: [],
      filter: { deny: ['meta.debug'] },
    },
  });
  const runtime = runtimeWith(
    definition,
    scripted(() => ({ message: 'ok', meta: { topic: 't', debug: 'x' } })).executor,
  );
  await runtime.admit('start', text('seed'));
  await runtime.settle();
  assert.deepEqual(runtime.snapshot().nodes['start']?.lastOutput, {
    message: 'ok',
    meta: { topic: 't' },
  });
});

test('filter runs before the writes check', async () => {
  const log = createMemoryLog();
  const definition = fastDefinition('filter-writes', {
    start: {
      kind: 'forager',
      config: { connection: 'c', prompt: 'p' },
      writes: ['meta.debug'],
      filter: { deny: ['meta.debug'] },
    },
  });
  const runtime = runtimeWith(
    definition,
    scripted(() => ({ message: 'ok', meta: { debug: 'x' } })).executor,
    log.sink,
  );
  await runtime.admit('start', text('seed'));
  await runtime.settle();
  const failed = log.entries.find((entry) => entry.event === 'node.failed');
  assert.ok(failed !== undefined);
  assert.match(failed.error ?? '', /meta\.debug/);
  assert.equal(runtime.snapshot().nodes['start']?.lastOutput, undefined);
});

test('an executor result may carry an independent drop applied after the merge', async () => {
  const log = createMemoryLog();
  const definition = fastDefinition(
    'drop',
    {
      start: { kind: 'forager', config: { connection: 'c', prompt: 'p' }, writes: [] },
      next: {
        kind: 'forager',
        config: { connection: 'c', prompt: 'next' },
        reads: [],
        writes: [],
      },
    },
    [{ id: 'e1', from: 'start', to: 'next' }],
  );
  const run = scripted(() => ({
    value: { message: 'ok' },
    drop: ['meta.debug', 'meta.missing'],
  }));
  const runtime = runtimeWith(definition, run.executor, log.sink);
  await runtime.admit('start', { message: 'seed', meta: { keep: 1, debug: 'secret' } });
  await runtime.settle();

  assert.deepEqual(run.inputs[1]?.input, {
    message: 'ok',
    meta: { keep: 1 },
  });
  const missing = log.entries.find((entry) => entry.event === 'value.drop-missing');
  assert.ok(missing !== undefined);
  assert.deepEqual(missing.paths, ['meta.missing']);
});

test('drop and value on the same path is a typed drop, and an index drop is a config drop', async () => {
  const overlapLog = createMemoryLog();
  const overlap = fastDefinition('drop-overlap', {
    start: { kind: 'forager', config: { connection: 'c', prompt: 'p' }, writes: [] },
  });
  const overlapRuntime = runtimeWith(
    overlap,
    scripted(() => ({ value: { message: 'ok' }, drop: ['message'] })).executor,
    overlapLog.sink,
  );
  await overlapRuntime.admit('start', text('seed'));
  await overlapRuntime.settle();
  const overlapFailed = overlapLog.entries.find((entry) => entry.event === 'node.failed');
  assert.ok(overlapFailed !== undefined);
  assert.match(overlapFailed.error ?? '', /same path 'message'/);

  const indexLog = createMemoryLog();
  const index = fastDefinition('drop-index', {
    start: { kind: 'forager', config: { connection: 'c', prompt: 'p' }, writes: [] },
  });
  const indexRuntime = runtimeWith(
    index,
    scripted(() => ({ value: { message: 'ok' }, drop: ['items.0'] })).executor,
    indexLog.sink,
  );
  await indexRuntime.admit('start', text('seed'));
  await indexRuntime.settle();
  const indexFailed = indexLog.entries.find((entry) => entry.event === 'node.failed');
  assert.ok(indexFailed !== undefined);
  assert.match(indexFailed.error ?? '', /array indices/);
});

test('condition and counter never write lastOutput', async () => {
  const conditionDefinition = fastDefinition(
    'condition-output',
    {
      check: {
        kind: 'condition',
        config: { when: { path: 'flag', equals: true } },
      },
      yes: { kind: 'user', config: { modality: 'text', prompt: 'yes?' } },
      no: { kind: 'user', config: { modality: 'text', prompt: 'no?' } },
    },
    [
      { id: 't', from: 'check', to: 'yes', when: 'true' },
      { id: 'f', from: 'check', to: 'no', when: 'false' },
    ],
  );
  const conditionRuntime = runtimeOf(conditionDefinition, recorder().executor);
  await conditionRuntime.admit('check', { flag: true });
  await conditionRuntime.settle();
  assert.equal(conditionRuntime.snapshot().nodes['check']?.lastOutput, undefined);
  assert.ok(conditionRuntime.snapshot().nodes['yes']?.hover !== undefined);

  const counterDefinition = fastDefinition(
    'counter-output',
    {
      count: { kind: 'counter', config: { max: 1 } },
      done: { kind: 'user', config: { modality: 'text', prompt: 'done?' } },
    },
    [
      { id: 'c', from: 'count', to: 'done', when: 'continue' },
      { id: 'd', from: 'count', to: 'done', when: 'done' },
    ],
  );
  const counterRuntime = runtimeOf(counterDefinition, recorder().executor);
  await counterRuntime.admit('count', { message: 'seed' });
  await counterRuntime.settle();
  assert.equal(counterRuntime.snapshot().nodes['count']?.lastOutput, undefined);
});

test('a user answer writes lastOutput and stays bound to the hovered value', async () => {
  const definition = fastDefinition('user-output', {
    ask: { kind: 'user', config: { modality: 'text', prompt: 'Name?' } },
  });
  const runtime = runtimeOf(definition, recorder().executor);
  await runtime.admit('ask', text('seed'));
  await runtime.settle();
  const answer: Value = { message: 'Ada', extra: { n: 1 } };
  runtime.answerHover('ask', answer);
  await runtime.settle();
  assert.deepEqual(runtime.snapshot().nodes['ask']?.lastOutput, answer);
});

test('forager prompt placeholders are dot paths declared in reads or fallback', () => {
  const issuesFor = (prompt: string, extra: Record<string, unknown> = {}): string[] => {
    try {
      parseComposition({
        schemaVersion: 1,
        id: 'prompt',
        nodes: {
          start: { kind: 'forager', config: { connection: 'c', prompt }, ...extra },
        },
      });
    } catch (error) {
      assert.ok(error instanceof CompositionValidationError);
      return [...error.issues];
    }
    return [];
  };

  assert.deepEqual(issuesFor('review {{message}}'), []);
  assert.ok(issuesFor('{{input}}').some((issue) => issue.includes('must be declared')));
  assert.ok(
    issuesFor('{{meta.topic}}').some((issue) => issue.includes('must be declared')),
  );
  assert.deepEqual(
    issuesFor('{{meta.topic}}', { fallback: { 'meta.topic': 'x' } }),
    [],
  );
  assert.ok(issuesFor('{{message}').some((issue) => issue.includes('unterminated')));
  assert.ok(issuesFor('{{meta.}}').some((issue) => issue.includes('not a dot path')));
});

test('renderPrompt renders strings, scalars and JSON and rejects a missing path', () => {
  assert.equal(
    renderPrompt('{{message}}/{{meta.flag}}/{{meta.n}}/{{meta.obj}}', {
      message: 'hi',
      meta: { flag: true, n: 2, obj: { a: 1 } },
    }),
    'hi/true/2/{"a":1}',
  );
  assert.equal(renderPrompt('{{meta.null}}', { meta: { null: null } }), 'null');
  assert.throws(
    () => renderPrompt('{{meta.topic}}', { meta: {} }),
    (error: unknown) => error instanceof BeeIoError && error.code === 'missing-read',
  );
});

test('forager filter and drop never leak into the produced lastOutput', async () => {
  const definition = fastDefinition('output-filter', {
    start: {
      kind: 'forager',
      config: { connection: 'c', prompt: 'p' },
      writes: [],
      filter: { deny: ['meta.debug'] },
    },
  });
  const runtime = runtimeWith(
    definition,
    scripted(() => ({ value: { message: 'ok', meta: { debug: 'x' } }, drop: ['meta.extra'] }))
      .executor,
  );
  await runtime.admit('start', text('seed'));
  await runtime.settle();
  assert.deepEqual(runtime.snapshot().nodes['start']?.lastOutput, {
    message: 'ok',
    meta: {},
  });
});
