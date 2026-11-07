import assert from 'node:assert/strict';
import test from 'node:test';

import type { ForagerNode, NodeExecutor, Value } from '../src/runtime/index.js';
import {
  NotAForagerNodeError,
  RoutingExecutorDisposedError,
  RoutingForagerExecutor,
  UnknownForagerRouteError,
} from '../src/session/routing-executor.js';

function foragerNode(id: string): ForagerNode {
  return {
    id,
    kind: 'forager',
    config: { connection: 'codex', prompt: `run ${id}` },
    minIntervalMs: 1000,
  };
}

function text(value: string): Value {
  return { kind: 'text', text: value };
}

interface Call {
  readonly nodeId: string;
  readonly input: Value;
}

class RecordingExecutor implements NodeExecutor {
  readonly calls: Call[] = [];
  private readonly respond: (node: ForagerNode, input: Value) => Value | Promise<Value>;

  constructor(respond?: (node: ForagerNode, input: Value) => Value | Promise<Value>) {
    this.respond = respond ?? ((_node, input) => input);
  }

  async execute(node: ForagerNode, input: Value): Promise<Value> {
    this.calls.push({ nodeId: node.id, input });
    return this.respond(node, input);
  }
}

test('routes each node id to its own child without crossing inputs or outputs', async () => {
  const childA = new RecordingExecutor((node, input) =>
    text(`A:${node.id}:${(input as { text: string }).text}`),
  );
  const childB = new RecordingExecutor((node, input) =>
    text(`B:${node.id}:${(input as { text: string }).text}`),
  );
  const routing = new RoutingForagerExecutor({
    executors: new Map([
      ['a', childA],
      ['b', childB],
    ]),
  });

  const outA1 = await routing.execute(foragerNode('a'), text('one'));
  const outB = await routing.execute(foragerNode('b'), text('two'));
  const outA2 = await routing.execute(foragerNode('a'), text('three'));

  assert.deepEqual(outA1, text('A:a:one'));
  assert.deepEqual(outB, text('B:b:two'));
  assert.deepEqual(outA2, text('A:a:three'));
  assert.deepEqual(
    childA.calls.map((call) => call.input),
    [text('one'), text('three')],
  );
  assert.deepEqual(childB.calls.map((call) => call.input), [text('two')]);
  assert.deepEqual(
    childA.calls.map((call) => call.nodeId),
    ['a', 'a'],
  );
  assert.deepEqual(
    childB.calls.map((call) => call.nodeId),
    ['b'],
  );
});

test('propagates a child failure unchanged and does not retry it', async () => {
  const boom = new Error('branch exploded');
  let calls = 0;
  const failing: NodeExecutor = {
    async execute() {
      calls += 1;
      throw boom;
    },
  };
  const sibling = new RecordingExecutor();
  const routing = new RoutingForagerExecutor({
    executors: new Map([
      ['broken', failing],
      ['sibling', sibling],
    ]),
  });

  await assert.rejects(routing.execute(foragerNode('broken'), text('x')), (error: unknown) => {
    assert.equal(error, boom);
    return true;
  });
  assert.equal(calls, 1, 'routing must not replay a failed child');
  assert.equal(sibling.calls.length, 0);
});

test('rejects a node id that has no child and names it', async () => {
  const child = new RecordingExecutor();
  const routing = new RoutingForagerExecutor({ executors: new Map([['a', child]]) });

  await assert.rejects(
    routing.execute(foragerNode('ghost'), text('x')),
    (error: unknown) => {
      assert.ok(error instanceof UnknownForagerRouteError);
      assert.equal(error.nodeId, 'ghost');
      assert.match(error.message, /ghost/);
      return true;
    },
  );
  assert.equal(child.calls.length, 0);
});

test('lastOutput follows successful calls and survives a later failure', async () => {
  let fail = false;
  const child: NodeExecutor = {
    async execute(_node, input) {
      if (fail) {
        throw new Error('later failure');
      }
      return input;
    },
  };
  const routing = new RoutingForagerExecutor({ executors: new Map([['a', child]]) });
  assert.equal(routing.lastOutput, undefined);

  const first = await routing.execute(foragerNode('a'), text('one'));
  assert.deepEqual(routing.lastOutput, first);

  fail = true;
  await assert.rejects(routing.execute(foragerNode('a'), text('two')), /later failure/);
  assert.deepEqual(routing.lastOutput, text('one'));
});

test('dispose is idempotent, releases children once, and refuses new work', async () => {
  const childA = new RecordingExecutor();
  const childB = new RecordingExecutor();
  const plainChild = new RecordingExecutor();
  let disposedA = 0;
  let disposedB = 0;
  Object.assign(childA, {
    dispose: () => {
      disposedA += 1;
    },
  });
  Object.assign(childB, {
    dispose: () => {
      disposedB += 1;
    },
  });
  const routing = new RoutingForagerExecutor({
    executors: new Map([
      ['a', childA],
      ['b', childB],
      ['plain', plainChild],
    ]),
  });

  routing.dispose();
  routing.dispose();

  assert.equal(disposedA, 1);
  assert.equal(disposedB, 1);
  await assert.rejects(
    routing.execute(foragerNode('a'), text('after dispose')),
    (error: unknown) => {
      assert.ok(error instanceof RoutingExecutorDisposedError);
      return true;
    },
  );
  assert.equal(childA.calls.length, 0);
});

test('rejects a non-forager node with its id and kind', async () => {
  const child = new RecordingExecutor();
  const routing = new RoutingForagerExecutor({ executors: new Map([['w', child]]) });
  const worker = {
    id: 'w',
    kind: 'worker',
    config: { command: 'echo', args: [], cwd: '.', timeoutMs: 1000 },
    minIntervalMs: 1000,
  } as unknown as ForagerNode;

  await assert.rejects(routing.execute(worker, text('x')), (error: unknown) => {
    assert.ok(error instanceof NotAForagerNodeError);
    assert.equal(error.nodeId, 'w');
    assert.equal(error.kind, 'worker');
    assert.match(error.message, /not a forager/);
    return true;
  });
  assert.equal(child.calls.length, 0);
});
