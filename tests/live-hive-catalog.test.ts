import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';

import {
  LiveHiveCatalog,
  LiveHiveCatalogError,
} from '../src/daemon/live-hive-catalog.js';

function tempCatalogPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'wax-m9b-catalog-')), 'live-catalog.json');
}

function clock(start = '2026-11-13T22:00:00.000Z'): {
  readonly now: () => string;
  set(value: string): void;
} {
  let current = start;
  return {
    now: () => current,
    set: (value: string) => {
      current = value;
    },
  };
}

test('a missing file starts empty and is not created by reading', () => {
  const path = tempCatalogPath();
  const catalog = new LiveHiveCatalog(path);

  assert.deepEqual(catalog.list(), []);
  assert.equal(catalog.get('missing'), undefined);
  assert.equal(existsSync(path), false);
});

test('marks update memory and save round-trips identity, state and times', () => {
  const path = tempCatalogPath();
  const time = clock();
  const catalog = new LiveHiveCatalog(path, { now: time.now });

  catalog.markLoaded('demo');
  assert.deepEqual(catalog.get('demo'), {
    liveId: 'demo',
    state: 'loaded',
    loadedAt: '2026-11-13T22:00:00.000Z',
    lastAccessAt: '2026-11-13T22:00:00.000Z',
  });

  time.set('2026-11-13T22:05:00.000Z');
  catalog.markAccessed('demo');
  catalog.markAccessed('unknown'); // no-op, never invents an identity
  assert.equal(catalog.list().length, 1);
  assert.equal(catalog.get('demo')?.lastAccessAt, '2026-11-13T22:05:00.000Z');

  // Marks are memory-only until save().
  assert.equal(existsSync(path), false);
  catalog.save();
  assert.equal(existsSync(path), true);

  const stored = JSON.parse(readFileSync(path, 'utf8')) as {
    schemaVersion?: unknown;
    entries?: readonly Record<string, unknown>[];
  };
  assert.equal(stored.schemaVersion, 1);
  assert.deepEqual(stored.entries, [
    {
      liveId: 'demo',
      state: 'loaded',
      loadedAt: '2026-11-13T22:00:00.000Z',
      lastAccessAt: '2026-11-13T22:05:00.000Z',
    },
  ]);

  time.set('2026-11-13T23:00:00.000Z');
  catalog.markUnloaded('demo', 'unload');
  catalog.save();

  const reloaded = new LiveHiveCatalog(path, { now: time.now });
  assert.deepEqual(reloaded.get('demo'), {
    liveId: 'demo',
    state: 'unloaded',
    loadedAt: '2026-11-13T22:00:00.000Z',
    lastAccessAt: '2026-11-13T23:00:00.000Z',
    lastUnloadReason: 'unload',
  });
});

test('unload retains an identity that was never loaded', () => {
  const path = tempCatalogPath();
  const catalog = new LiveHiveCatalog(path, { now: clock().now });

  catalog.markUnloaded('never-loaded', 'dispose');
  catalog.save();

  assert.deepEqual(catalog.get('never-loaded'), {
    liveId: 'never-loaded',
    state: 'unloaded',
    lastAccessAt: '2026-11-13T22:00:00.000Z',
    lastUnloadReason: 'dispose',
  });
});

test('recoverLoadedEntries clears stale loaded state without erasing identity', () => {
  const path = tempCatalogPath();
  const time = clock();
  const catalog = new LiveHiveCatalog(path, { now: time.now });
  catalog.markLoaded('busy');
  catalog.markLoaded('history');
  catalog.markUnloaded('history', 'unload');
  catalog.save();

  time.set('2026-11-13T22:10:00.000Z');
  const restarted = new LiveHiveCatalog(path, { now: time.now });
  assert.equal(restarted.recoverLoadedEntries(), 1);
  assert.deepEqual(restarted.get('busy'), {
    liveId: 'busy',
    state: 'unloaded',
    loadedAt: '2026-11-13T22:00:00.000Z',
    lastAccessAt: '2026-11-13T22:10:00.000Z',
  });
  assert.equal(restarted.get('history')?.lastUnloadReason, 'unload');

  // Idempotent: a second start with no stale entry writes nothing new.
  assert.equal(restarted.recoverLoadedEntries(), 0);
  const reread = new LiveHiveCatalog(path, { now: time.now });
  assert.equal(reread.get('busy')?.state, 'unloaded');
  assert.equal(reread.get('busy')?.lastUnloadReason, undefined);
});

test('save leaves no temporary file behind', () => {
  const path = tempCatalogPath();
  const catalog = new LiveHiveCatalog(path, { now: clock().now });

  catalog.markLoaded('one');
  catalog.save();
  catalog.markLoaded('two');
  catalog.save();

  const directory = dirname(path);
  assert.deepEqual(
    readdirSync(directory).filter((name) => name.includes(basename(path))),
    [basename(path)],
  );
  const raw = readFileSync(path, 'utf8');
  assert.equal(raw.endsWith('\n'), true);
  const parsed = JSON.parse(raw) as { entries?: readonly { liveId?: string }[] };
  assert.deepEqual(
    parsed.entries?.map((entry) => entry.liveId),
    ['one', 'two'],
  );
});

test('a corrupt or unsupported file fails construction', () => {
  const path = tempCatalogPath();
  writeFileSync(path, '{"schemaVersion":1,"entries":[{"liveId":"x","state":"bogus"}]}');
  assert.throws(
    () => new LiveHiveCatalog(path),
    (error: unknown) => {
      assert.ok(error instanceof LiveHiveCatalogError);
      return true;
    },
  );

  writeFileSync(path, 'not json');
  assert.throws(() => new LiveHiveCatalog(path), LiveHiveCatalogError);

  writeFileSync(path, '{"schemaVersion":2,"entries":[]}');
  assert.throws(() => new LiveHiveCatalog(path), LiveHiveCatalogError);

  writeFileSync(
    path,
    '{"schemaVersion":1,"entries":[{"liveId":"dup","state":"loaded"},{"liveId":"dup","state":"unloaded"}]}',
  );
  assert.throws(() => new LiveHiveCatalog(path), /Duplicate live-hive catalog id/);
});

test('list and get return snapshots that cannot mutate the catalog', () => {
  const path = tempCatalogPath();
  const catalog = new LiveHiveCatalog(path, { now: clock().now });
  catalog.markLoaded('demo');

  const entry = catalog.get('demo');
  assert.ok(entry !== undefined);
  Reflect.set(entry, 'state', 'unloaded');
  const list = catalog.list() as { liveId: string; state: string }[];
  list[0]!.state = 'unloaded';
  list.push({ liveId: 'injected', state: 'loaded' });

  assert.equal(catalog.get('demo')?.state, 'loaded');
  assert.equal(catalog.list().length, 1);
});
