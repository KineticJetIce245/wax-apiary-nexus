import assert from 'node:assert/strict';
import test from 'node:test';

import { fromCompositionDefinition } from '../src/b/live-hive-codec.js';
import { runLiveCli } from '../src/cli/live-cli.js';
import type { GraphBindings } from '../src/graph/binding.js';
import { parseComposition } from '../src/runtime/index.js';
import {
  foragerComposition,
  freshBindings,
  invokeControl,
  singleJson,
  tempDir,
  tempJson,
} from './support/control-cli-fixtures.js';
import { startWaxd } from './support/control-cli-daemons.js';

test('wax live round-trips new, inspect, list, wake and unload over real HTTP', async (t) => {
  const daemon = await startWaxd(t, [], { output: 'cli-live-output' });
  const live = fromCompositionDefinition(
    parseComposition(foragerComposition('cli-live')),
    freshBindings() as GraphBindings,
  );
  const liveFile = tempJson(live);
  const project = tempDir('wax-control-cli-project-');

  const load = await invokeControl(
    runLiveCli,
    ['live', 'new', liveFile, '--project', project, '--json'],
    { daemonDir: daemon.daemonDir },
  );
  const loaded = singleJson(load);
  assert.equal(loaded['liveId'], 'cli-live');
  assert.equal((loaded['status'] as Record<string, unknown>)['rest'], true);
  assert.equal(daemon.adapter.displayNames.length, 1);

  const duplicateLoad = await invokeControl(
    runLiveCli,
    ['live', 'new', liveFile, '--project', project, '--json'],
    { daemonDir: daemon.daemonDir },
  );
  assert.equal(duplicateLoad.code, 1);
  assert.equal(duplicateLoad.stdout.length, 0);
  assert.match(duplicateLoad.stderr[0] as string, /conflict|409/);
  assert.equal(daemon.adapter.displayNames.length, 1);

  const inspected = singleJson(
    await invokeControl(runLiveCli, ['live', 'inspect', 'cli-live', '--json'], {
      daemonDir: daemon.daemonDir,
    }),
  );
  assert.equal(inspected['liveId'], 'cli-live');
  assert.equal((inspected['status'] as Record<string, unknown>)['rest'], true);
  assert.equal(
    Object.hasOwn(inspected['status'] as Record<string, unknown>, 'graphId'),
    false,
  );

  const listed = singleJson(
    await invokeControl(runLiveCli, ['live', 'list', '--json'], {
      daemonDir: daemon.daemonDir,
    }),
  );
  const lives = listed['lives'] as Record<string, unknown>[];
  assert.equal(lives[0]?.['liveId'], 'cli-live');
  assert.equal(lives[0]?.['state'], 'loaded');

  const wake = await invokeControl(
    runLiveCli,
    ['live', 'wake', 'cli-live', 'only', '--input', 'hello live', '--json'],
    { daemonDir: daemon.daemonDir },
  );
  const result = singleJson(wake);
  assert.equal(result['liveId'], 'cli-live');
  assert.equal(result['rest'], true);
  assert.equal(result['persisted'], true);
  assert.equal(Object.hasOwn(result, 'graphId'), false);
  assert.equal(
    Object.hasOwn(result['status'] as Record<string, unknown>, 'graphRevision'),
    false,
  );
  assert.match(daemon.adapter.prompts[0] as string, /hello live/);

  const unload = singleJson(
    await invokeControl(runLiveCli, ['live', 'unload', 'cli-live', '--json'], {
      daemonDir: daemon.daemonDir,
    }),
  );
  assert.equal(unload['unloaded'], true);
  assert.equal(daemon.adapter.closedNativeIds.length, 0);
});
