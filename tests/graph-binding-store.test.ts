import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  GraphBindingStore,
  GraphBindingStoreError,
  type ResolvedGraphBinding,
} from '../src/graph/binding-store.js';

const FIXED_NOW = '2026-11-06T22:00:00.000Z';

function storePath(): string {
  return join(
    mkdtempSync(join(tmpdir(), 'wax-m5b-binding-store-')),
    'graph-bindings.json',
  );
}

function binding(
  overrides: Partial<ResolvedGraphBinding> = {},
): ResolvedGraphBinding {
  return {
    graphId: 'graph',
    nodeId: 'node',
    sessionId: 'session-1',
    harness: 'dsh-acp',
    projectId: 'project-1',
    updatedAt: FIXED_NOW,
    ...overrides,
  };
}

function writeFile(filePath: string, contents: string): void {
  writeFileSync(filePath, contents, 'utf8');
}

test('a missing file is an empty store and is not created on construction', () => {
  const file = storePath();
  const store = new GraphBindingStore(file);

  assert.deepEqual(store.snapshot(), []);
  assert.equal(store.get('graph', 'node'), undefined);
  assert.equal(existsSync(file), false);
});

test('set/get/remove/removeForSession and snapshot copies do not alias the store', () => {
  const store = new GraphBindingStore(storePath(), { now: () => FIXED_NOW });

  store.set(binding());
  store.set(binding({ graphId: 'other', sessionId: 'session-2' }));

  assert.deepEqual(
    store.snapshot().map((record) => [record.graphId, record.nodeId, record.sessionId]),
    [
      ['graph', 'node', 'session-1'],
      ['other', 'node', 'session-2'],
    ],
  );

  const got = store.get('graph', 'node');
  assert.ok(got !== undefined);
  assert.equal(got.sessionId, 'session-1');
  // A returned record is a copy: mutating it cannot rewrite the store.
  (got as { sessionId: string }).sessionId = 'mutated';
  assert.equal(store.get('graph', 'node')?.sessionId, 'session-1');

  const snapshot = store.snapshot();
  (snapshot as ResolvedGraphBinding[])[0] = binding({ sessionId: 'replaced' });
  assert.equal(store.snapshot().length, 2);
  const first = store.snapshot()[0];
  assert.ok(first !== undefined);
  (first as { harness: string }).harness = 'mutated-harness';
  assert.equal(store.get('graph', 'node')?.harness, 'dsh-acp');

  store.remove('graph', 'node');
  assert.equal(store.get('graph', 'node'), undefined);
  assert.deepEqual(
    store.snapshot().map((record) => record.sessionId),
    ['session-2'],
  );

  assert.equal(store.removeForSession('session-2'), 1);
  assert.deepEqual(store.snapshot(), []);
  assert.equal(store.removeForSession('session-2'), 0);
  // Removing an absent key is a no-op, not an error.
  assert.doesNotThrow(() => store.remove('graph', 'node'));
});

test('writes the documented schema atomically and leaves no temp file', () => {
  const file = storePath();
  const store = new GraphBindingStore(file, { now: () => FIXED_NOW });

  store.set(binding({ graphId: 'g1', nodeId: 'n1' }));

  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {
    schemaVersion: 1,
    bindings: {
      g1: {
        n1: {
          sessionId: 'session-1',
          harness: 'dsh-acp',
          projectId: 'project-1',
          updatedAt: FIXED_NOW,
        },
      },
    },
  });
  assert.deepEqual(
    readdirSync(dirname(file)).filter((name) => name.includes('.tmp-')),
    [],
  );

  store.remove('g1', 'n1');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).bindings, {});
  assert.deepEqual(
    readdirSync(dirname(file)).filter((name) => name.includes('.tmp-')),
    [],
  );
});

test('consecutive sets keep every record and stamp updatedAt from the injected clock', () => {
  const times = [
    '2026-11-06T22:00:01.000Z',
    '2026-11-06T22:00:02.000Z',
  ];
  let index = 0;
  const file = storePath();
  const store = new GraphBindingStore(file, {
    now: () => times[index++] ?? 'unexpected-extra-call',
  });

  store.set(binding({ nodeId: 'one', updatedAt: 'caller-value-is-ignored' }));
  store.set(binding({ nodeId: 'two' }));

  assert.equal(store.get('graph', 'one')?.updatedAt, times[0]);
  assert.equal(store.get('graph', 'two')?.updatedAt, times[1]);
  assert.deepEqual(
    store.snapshot().map((record) => record.nodeId),
    ['one', 'two'],
  );

  // A second process (a fresh instance) sees both records.
  const reloaded = new GraphBindingStore(file);
  assert.deepEqual(reloaded.snapshot(), store.snapshot());
});

test('corrupt JSON, wrong schema and invalid records are typed errors', () => {
  const invalidDocuments = [
    '{',
    JSON.stringify([]),
    JSON.stringify({ schemaVersion: 2, bindings: {} }),
    JSON.stringify({ schemaVersion: 1 }),
    JSON.stringify({ schemaVersion: 1, bindings: [] }),
    JSON.stringify({ schemaVersion: 1, bindings: { graph: [] } }),
    JSON.stringify({
      schemaVersion: 1,
      bindings: {
        graph: {
          node: { sessionId: 1, harness: 'h', projectId: 'p', updatedAt: 't' },
        },
      },
    }),
    JSON.stringify({
      schemaVersion: 1,
      bindings: {
        graph: {
          node: {
            sessionId: 's',
            harness: '',
            projectId: 'p',
            updatedAt: 't',
          },
        },
      },
    }),
  ];

  for (const contents of invalidDocuments) {
    const file = storePath();
    writeFile(file, contents);
    assert.throws(
      () => new GraphBindingStore(file),
      (error: unknown) => {
        assert.ok(error instanceof GraphBindingStoreError);
        assert.match(error.message, /Graph binding store/);
        return true;
      },
      contents,
    );
  }
});

test('graph and node ids that look like prototype keys stay plain JSON keys', () => {
  const file = storePath();
  const store = new GraphBindingStore(file, { now: () => FIXED_NOW });
  const originalConstructor = Object.prototype.constructor;

  store.set(
    binding({ graphId: '__proto__', nodeId: 'constructor', sessionId: 'proto-session' }),
  );

  assert.equal(store.get('__proto__', 'constructor')?.sessionId, 'proto-session');
  const reloaded = new GraphBindingStore(file);
  assert.equal(reloaded.get('__proto__', 'constructor')?.sessionId, 'proto-session');
  assert.equal(Object.prototype.constructor, originalConstructor);
});
