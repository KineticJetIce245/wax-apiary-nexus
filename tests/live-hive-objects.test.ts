import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  bindBee,
  bindingsOf,
  LiveHiveStore,
  LiveHiveStoreError,
  unbindBee,
} from '../src/b/live-hive.js';
import {
  HiveTemplateStore,
  HiveTemplateStoreError,
} from '../src/b/hive-template.js';
import type { LiveHive } from '../src/b/types.js';
import { simpleLiveHive, simpleTemplate } from './support/b-object-fixtures.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'wax-b-objects-'));
}

test('live.json round-trips beeId/beelineId keys, bindings, outgoing and branch', () => {
  const directory = tempDir();
  const path = join(directory, 'live.json');
  const live = simpleLiveHive();
  const store = new LiveHiveStore(path);

  store.save(live);
  const loaded = store.load();

  assert.deepEqual(loaded, live);
  assert.deepEqual(Object.keys(loaded.bees), ['draft', 'review', 'done']);
  assert.deepEqual(Object.keys(loaded.beelines), ['l1', 'l2']);
  assert.deepEqual(loaded.bindings, { draft: 's1', review: 's2' });
  assert.deepEqual(loaded.bees['draft']?.outgoing, ['l1']);
  assert.equal(loaded.bees['draft']?.roleLabel, 'planner');
  assert.equal(loaded.bees['draft']?.sessionMode, 'fresh_once');
  assert.equal(loaded.beelines['l2']?.branch, 'continue');
  assert.deepEqual(store.list(), [live]);

  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  assert.deepEqual(Object.keys(raw['bees'] as object), ['draft', 'review', 'done']);
  assert.deepEqual(Object.keys(raw['bindings'] as object), ['draft', 'review']);
});

test('live.json save overwrites atomically and leaves no temp file', () => {
  const directory = tempDir();
  const path = join(directory, 'live.json');
  const store = new LiveHiveStore(path);
  store.save(simpleLiveHive());
  const changed: LiveHive = { ...simpleLiveHive(), liveId: 'second' };
  store.save(changed);

  assert.equal(store.load().liveId, 'second');
  assert.deepEqual(
    readdirSync(directory).filter((name) => name.startsWith('live.json.tmp-')),
    [],
  );
  assert.equal(store.exists(), true);
});

test('live.json rejects missing, corrupt and structurally invalid files', () => {
  const directory = tempDir();
  const path = join(directory, 'live.json');
  const store = new LiveHiveStore(path);

  assert.equal(store.exists(), false);
  assert.deepEqual(store.list(), []);
  assert.throws(() => store.load(), LiveHiveStoreError);

  writeFileSync(path, '{not json', 'utf8');
  assert.throws(() => store.load(), LiveHiveStoreError);

  const invalid = simpleLiveHive() as unknown as Record<string, unknown>;
  (invalid['bees'] as Record<string, unknown>)['draft'] = {
    kind: 'forager',
    config: {},
    outgoing: ['missing'],
  };
  writeFileSync(path, JSON.stringify(invalid), 'utf8');
  assert.throws(() => store.load(), LiveHiveStoreError);
});

test('live.json validates outgoing, beeline endpoints and binding keys before write', () => {
  const directory = tempDir();
  const path = join(directory, 'live.json');
  const store = new LiveHiveStore(path);
  const live = simpleLiveHive();

  const missingOutgoing: LiveHive = {
    ...live,
    bees: {
      ...live.bees,
      draft: { ...live.bees['draft']!, outgoing: [] },
    },
  };
  assert.throws(() => store.save(missingOutgoing), /missing beeline/);

  const wrongSource: LiveHive = {
    ...live,
    beelines: {
      ...live.beelines,
      l1: { fromBee: 'review', toBee: 'review' },
    },
  };
  assert.throws(() => store.save(wrongSource), /starts elsewhere/);

  const unknownBinding: LiveHive = {
    ...live,
    bindings: { ...live.bindings, ghost: 's3' },
  };
  assert.throws(() => store.save(unknownBinding), /unknown bee/);
  assert.equal(store.exists(), false);
});

test('BeeBinding helpers derive from live.bindings and never mutate the input', () => {
  const live = simpleLiveHive();
  const bound = bindBee(live, 'done', 's3');
  assert.deepEqual(bound.bindings, { draft: 's1', review: 's2', done: 's3' });
  assert.deepEqual(live.bindings, { draft: 's1', review: 's2' });
  assert.deepEqual(bindingsOf(bound), [
    { beeId: 'draft', sessionId: 's1' },
    { beeId: 'review', sessionId: 's2' },
    { beeId: 'done', sessionId: 's3' },
  ]);

  const unbound = unbindBee(bound, 'review');
  assert.deepEqual(unbound.bindings, { draft: 's1', done: 's3' });
  assert.deepEqual(bound.bindings, { draft: 's1', review: 's2', done: 's3' });
  assert.equal(unbindBee(bound, 'ghost'), bound);
  assert.throws(() => bindBee(live, 'ghost', 's3'), /unknown bee/);
});

test('HiveTemplateStore round-trips defaults and lists sorted template files', () => {
  const directory = join(tempDir(), 'templates');
  const store = new HiveTemplateStore(directory);
  const template = simpleTemplate();
  const second = { ...template, templateId: 'z-last', defaults: { done: { model: 'm' } } };

  store.save(template);
  store.save(second);
  assert.deepEqual(store.load('starter'), template);
  assert.deepEqual(
    store.list().map((entry) => entry.templateId),
    ['starter', 'z-last'],
  );
  assert.deepEqual(store.list()[0]?.defaults['draft'], {
    harness: 'codex',
    model: 'gpt-5',
    reasoning: 'high',
  });
  assert.equal(store.list()[0]?.hive.bees['draft']?.roleLabel, 'planner');
  assert.deepEqual(readdirSync(directory).sort(), ['starter.json', 'z-last.json']);
});

test('HiveTemplateStore rejects unsafe ids, corrupt files and unknown defaults', () => {
  const directory = join(tempDir(), 'templates');
  const store = new HiveTemplateStore(directory);
  const template = simpleTemplate();

  assert.throws(
    () => store.save({ ...template, templateId: '../escape' }),
    HiveTemplateStoreError,
  );
  store.save(template);
  writeFileSync(join(directory, 'broken.json'), '{', 'utf8');
  assert.throws(() => store.load('broken'), HiveTemplateStoreError);
  assert.throws(() => store.list(), HiveTemplateStoreError);

  const unknownDefault = {
    ...template,
    defaults: { ghost: { harness: 'codex' } },
  };
  assert.throws(() => store.save(unknownDefault), /unknown bee/);
  assert.throws(() => store.load('ghost'), HiveTemplateStoreError);
});
