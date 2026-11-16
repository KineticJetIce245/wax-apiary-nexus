import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';

import { runCli } from '../src/cli/cli.js';
import { CliUsageError } from '../src/cli/cli-shared.js';
import {
  runGraphCli,
  runSessionCli,
  runTriggerCli,
  type ControlCliDependencies,
} from '../src/cli/control-cli.js';
import {
  parseWaxdArgs,
  runWaxdCli,
  type WaxdStartedInfo,
} from '../src/cli/waxd-cli.js';
import { ControlClient, discoverDaemon } from '../src/control/client.js';
import type { HarnessKind } from '../src/session/connection.js';
import { FakeAdapter, type FakeAdapterOptions } from './support/fake-adapter.js';
import {
  TrackingFakeAdapter,
  foragerComposition,
  parkedComposition,
  userForagerComposition,
  freshBindings,
  tempDir,
  tempJson,
  tempRaw,
  manifestFixture,
  writeManifestVariant,
  invokeControl,
  singleJson,
  asRecord,
  assertUsage,
  assertNoSecret,
  freePort,
  type Invocation,
} from './support/control-cli-fixtures.js';
import { startWaxd, startMultiWaxd } from './support/control-cli-daemons.js';


test('graph commands round-trip load, status, list, trigger, unload and sweep over real HTTP', async (t) => {
  const daemon = await startWaxd(t);
  const composition = tempJson(foragerComposition('cli-graph'));
  const bindings = tempJson(freshBindings());
  const project = tempDir('wax-control-cli-project-');

  const load = await invokeControl(
    runGraphCli,
    ['graph', 'load', composition, '--project', project, '--bindings', bindings, '--json'],
    { daemonDir: daemon.daemonDir },
  );
  const loaded = singleJson(load);
  assert.equal(loaded['graphId'], 'cli-graph');
  assert.equal(loaded['rest'], true);
  assert.equal(loaded['hovered'], false);
  assert.equal(daemon.adapter.displayNames.length, 1);

  // A duplicate load is a 409 from the server, not a second session.
  const duplicateLoad = await invokeControl(
    runGraphCli,
    ['graph', 'load', composition, '--project', project, '--bindings', bindings, '--json'],
    { daemonDir: daemon.daemonDir },
  );
  assert.equal(duplicateLoad.code, 1);
  assert.equal(duplicateLoad.stdout.length, 0);
  assert.equal(duplicateLoad.stderr.length, 1);
  assert.match(duplicateLoad.stderr[0] as string, /conflict|409/);
  assert.equal(daemon.adapter.displayNames.length, 1);

  const status = singleJson(
    await invokeControl(runGraphCli, ['graph', 'status', 'cli-graph', '--json'], {
      daemonDir: daemon.daemonDir,
    }),
  );
  assert.equal(status['graphId'], 'cli-graph');
  assert.equal(status['rest'], true);

  const humanList = await invokeControl(runGraphCli, ['graph', 'list'], {
    daemonDir: daemon.daemonDir,
  });
  assert.equal(humanList.code, 0);
  assert.equal(humanList.stderr.length, 0);
  assert.equal(humanList.stdout.length, 1);
  assert.match(
    humanList.stdout[0] as string,
    /^cli-graph rest=true hovered=false nodes=1 refCount=[0-9]+$/,
  );

  const trigger = await invokeControl(
    runTriggerCli,
    ['trigger', 'cli-graph', 'only', '--input', 'hello graph', '--json'],
    { daemonDir: daemon.daemonDir },
  );
  const result = singleJson(trigger);
  assert.equal(result['graphId'], 'cli-graph');
  assert.equal(result['rest'], true);
  assert.equal(result['hovered'], false);
  assert.ok((result['pumps'] as number) >= 1);
  assert.equal(result['persisted'], true);
  const resultStatus = asRecord(result['status']);
  assert.equal(resultStatus['rest'], true);
  assert.equal(asRecord((resultStatus['nodes'] as unknown[])[0])['queue'], 0);
  assert.equal(daemon.adapter.prompts.length, 1);
  assert.match(daemon.adapter.prompts[0] as string, /hello graph/);

  const unload = singleJson(
    await invokeControl(runGraphCli, ['graph', 'unload', 'cli-graph', '--json'], {
      daemonDir: daemon.daemonDir,
    }),
  );
  assert.equal(unload['graphId'], 'cli-graph');
  assert.equal(unload['unloaded'], true);
  // Unload retains the session: no native close happens here.
  assert.equal(daemon.adapter.closedNativeIds.length, 0);

  const emptyList = singleJson(
    await invokeControl(runGraphCli, ['graph', 'list', '--json'], {
      daemonDir: daemon.daemonDir,
    }),
  );
  assert.deepEqual(emptyList['status'], []);

  const humanSweep = await invokeControl(runGraphCli, ['graph', 'sweep'], {
    daemonDir: daemon.daemonDir,
  });
  assert.equal(humanSweep.code, 0);
  assert.equal(humanSweep.stderr.length, 0);
  assert.equal(humanSweep.stdout.length, 1);
  assert.equal(humanSweep.stdout[0], 'unloaded=0 skipped=0 failed=0');

  const sweep = singleJson(
    await invokeControl(runGraphCli, ['graph', 'sweep', '--json'], {
      daemonDir: daemon.daemonDir,
    }),
  );
  assert.deepEqual(sweep['unloaded'], []);
  assert.deepEqual(sweep['skipped'], []);
  assert.deepEqual(sweep['failed'], []);
});

test('wax graph output reads real HTTP output, renders human values and exits 1 when unknown', async (t) => {
  const outputText = 'GRAPH_OUTPUT_7c1d';
  const daemon = await startWaxd(t, [], { output: outputText });
  const composition = tempJson(foragerComposition('output-graph'));
  const bindings = tempJson(freshBindings());
  const project = tempDir('wax-control-cli-output-project-');

  const load = await invokeControl(
    runGraphCli,
    ['graph', 'load', composition, '--project', project, '--bindings', bindings, '--json'],
    { daemonDir: daemon.daemonDir },
  );
  assert.equal(load.code, 0, `stderr: ${load.stderr.join(' | ')}`);

  // Loaded but not yet executed: one JSON object with an empty list, not 404.
  const empty = singleJson(
    await invokeControl(runGraphCli, ['graph', 'output', 'output-graph', '--json'], {
      daemonDir: daemon.daemonDir,
    }),
  );
  assert.deepEqual(empty, { graphId: 'output-graph', outputs: [] });
  assert.deepEqual(Object.keys(empty), ['graphId', 'outputs']);

  const trigger = await invokeControl(
    runTriggerCli,
    ['trigger', 'output-graph', 'only', '--input', 'hello output', '--json'],
    { daemonDir: daemon.daemonDir },
  );
  assert.equal(trigger.code, 0, `stderr: ${trigger.stderr.join(' | ')}`);

  const outputInvocation = await invokeControl(
    runGraphCli,
    ['graph', 'output', 'output-graph', '--json'],
    { daemonDir: daemon.daemonDir },
  );
  const outputJson = singleJson(outputInvocation);
  assert.deepEqual(outputJson, {
    graphId: 'output-graph',
    outputs: [{ nodeId: 'only', value: { kind: 'text', text: outputText } }],
  });

  const human = await invokeControl(runGraphCli, ['graph', 'output', 'output-graph'], {
    daemonDir: daemon.daemonDir,
  });
  assert.equal(human.code, 0);
  assert.deepEqual(human.stderr, []);
  assert.deepEqual(human.stdout, [`only: ${outputText}`]);

  const token = readFileSync(daemon.started.tokenPath, 'utf8').trim();
  assertNoSecret([...human.stdout, ...human.stderr, ...outputInvocation.stdout], token);

  // Structured values use stable compact JSON. Discovery still talks to the
  // real daemon; only the control response is injected so the CLI's non-text
  // rendering path is exercised without inventing a structured forager.
  const structured = await invokeControl(runGraphCli, ['graph', 'output', 'output-graph'], {
    daemonDir: daemon.daemonDir,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          ok: true,
          graphId: 'output-graph',
          outputs: [
            { nodeId: 'only', value: { kind: 'structured', value: { b: 2, a: 1 } } },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  });
  assert.equal(structured.code, 0);
  assert.deepEqual(structured.stdout, [
    'only: {"kind":"structured","value":{"b":2,"a":1}}',
  ]);

  const unknown = await invokeControl(runGraphCli, ['graph', 'output', 'missing'], {
    daemonDir: daemon.daemonDir,
  });
  assert.equal(unknown.code, 1);
  assert.deepEqual(unknown.stdout, []);
  assert.equal(unknown.stderr.length, 1);
  assert.match(unknown.stderr[0] as string, /graph 'missing' is not loaded/);

  for (const argv of [
    ['graph', 'output'],
    ['graph', 'output', 'a', 'b'],
    ['graph', 'output', 'a', '--bogus'],
  ]) {
    const usage = await invokeControl(runGraphCli, argv, { daemonDir: daemon.daemonDir });
    assert.equal(usage.code, 2, `expected usage exit for ${argv.join(' ')}`);
    assert.deepEqual(usage.stdout, []);
  }
});

test('one waxd process serves multiple graphs for its single harness', async (t) => {
  const daemon = await startWaxd(t);
  const bindings = tempJson(freshBindings());
  const project = tempDir('wax-control-cli-multi-project-');

  for (const id of ['graph-a', 'graph-b']) {
    const composition = tempJson(foragerComposition(id));
    const load = await invokeControl(
      runGraphCli,
      ['graph', 'load', composition, '--project', project, '--bindings', bindings, '--json'],
      { daemonDir: daemon.daemonDir },
    );
    assert.equal(load.code, 0, load.stderr.join(' | '));
  }

  const list = singleJson(
    await invokeControl(runGraphCli, ['graph', 'list', '--json'], {
      daemonDir: daemon.daemonDir,
    }),
  );
  const ids = (list['status'] as unknown[])
    .map((status) => asRecord(status)['graphId'] as string)
    .sort();
  assert.deepEqual(ids, ['graph-a', 'graph-b']);
  assert.equal(daemon.adapter.displayNames.length, 2);

  for (const id of ['graph-a', 'graph-b']) {
    const unload = await invokeControl(
      runGraphCli,
      ['graph', 'unload', id, '--json'],
      { daemonDir: daemon.daemonDir },
    );
    assert.equal(unload.code, 0, unload.stderr.join(' | '));
  }
  assert.equal(daemon.adapter.closedNativeIds.length, 0);

  const empty = singleJson(
    await invokeControl(runGraphCli, ['graph', 'list', '--json'], {
      daemonDir: daemon.daemonDir,
    }),
  );
  assert.deepEqual(empty['status'], []);
});

test('every --json command writes exactly one parseable JSON object', async (t) => {
  const daemon = await startWaxd(t);
  const token = readFileSync(daemon.started.tokenPath, 'utf8').trim();
  const composition = tempJson(foragerComposition('json-graph'));
  const bindings = tempJson(freshBindings());
  const project = tempDir('wax-control-cli-json-project-');
  const invocations: Invocation[] = [];

  invocations.push(
    await invokeControl(
      runGraphCli,
      ['graph', 'load', composition, '--project', project, '--bindings', bindings, '--json'],
      { daemonDir: daemon.daemonDir },
    ),
  );
  invocations.push(
    await invokeControl(runGraphCli, ['graph', 'status', 'json-graph', '--json'], {
      daemonDir: daemon.daemonDir,
    }),
  );
  invocations.push(
    await invokeControl(runGraphCli, ['graph', 'list', '--json'], {
      daemonDir: daemon.daemonDir,
    }),
  );
  invocations.push(
    await invokeControl(
      runTriggerCli,
      ['trigger', 'json-graph', 'only', '--input', 'json', '--json'],
      { daemonDir: daemon.daemonDir },
    ),
  );
  invocations.push(
    await invokeControl(runGraphCli, ['graph', 'sweep', '--json'], {
      daemonDir: daemon.daemonDir,
    }),
  );
  invocations.push(
    await invokeControl(runSessionCli, ['session', 'sweep', '--json'], {
      daemonDir: daemon.daemonDir,
    }),
  );
  invocations.push(
    await invokeControl(runGraphCli, ['graph', 'unload', 'json-graph', '--json'], {
      daemonDir: daemon.daemonDir,
    }),
  );

  for (const invocation of invocations) {
    assert.equal(invocation.code, 0, invocation.stderr.join(' | '));
    assert.equal(invocation.stderr.length, 0);
    const parsed = singleJson(invocation);
    assert.equal(typeof parsed, 'object');
    assertNoSecret(invocation.stdout, token);
    assertNoSecret(invocation.stderr, token);
  }

  const listJson = asRecord(JSON.parse(invocations[2]?.stdout[0] as string));
  assert.ok(Array.isArray(listJson['status']));
});

test('graph load rejects bad local input before any session is created', async (t) => {
  const daemon = await startWaxd(t);
  const composition = tempJson(foragerComposition('local-validation'));
  const bindings = tempJson(freshBindings());
  const project = tempDir('wax-control-cli-validate-project-');
  const missingComposition = join(tempDir('wax-control-cli-missing-'), 'missing.json');
  const badComposition = tempRaw('{"nodes": {"only": "PROMPT_SECRET_BAD_JSON"');
  const badBindings = tempRaw('{"only": "BINDINGS_SECRET_BAD_JSON"');
  const arrayBindings = tempJson([]);

  const usageCases: (readonly string[])[] = [
    ['load', badComposition, '--project', project, '--bindings', bindings, '--json'],
    ['load', composition, '--bindings', bindings, '--json'],
    ['load', composition, '--project', project, '--bindings', badBindings, '--json'],
    ['load', composition, '--project', project, '--bindings', arrayBindings, '--json'],
    [
      'load',
      composition,
      '--project',
      project,
      '--bindings',
      bindings,
      '--idle-ttl-ms',
      '-1',
      '--json',
    ],
  ];

  for (const args of usageCases) {
    const invocation = await invokeControl(runGraphCli, ['graph', ...args], {
      daemonDir: daemon.daemonDir,
    });
    assert.equal(invocation.code, 2, invocation.stderr.join(' | '));
    assert.equal(invocation.stdout.length, 0);
    assert.equal(invocation.stderr.length, 1);
    assertNoSecret(invocation.stderr, 'PROMPT_SECRET_BAD_JSON');
    assertNoSecret(invocation.stderr, 'BINDINGS_SECRET_BAD_JSON');
  }

  const ioFailure = await invokeControl(
    runGraphCli,
    ['graph', 'load', missingComposition, '--project', project, '--bindings', bindings, '--json'],
    { daemonDir: daemon.daemonDir },
  );
  assert.equal(ioFailure.code, 1);
  assert.equal(ioFailure.stdout.length, 0);
  assert.equal(ioFailure.stderr.length, 1);

  // None of the rejected commands reached /graphs/load.
  assert.equal(daemon.adapter.displayNames.length, 0);

  // The same daemon still accepts a valid load.
  const valid = await invokeControl(
    runGraphCli,
    ['graph', 'load', composition, '--project', project, '--bindings', bindings, '--json'],
    { daemonDir: daemon.daemonDir },
  );
  assert.equal(valid.code, 0);
  assert.equal(daemon.adapter.displayNames.length, 1);
});

test('unknown status/unload exit 1 and waxd unloads a hover-only graph', async (t) => {
  const daemon = await startWaxd(t);

  const missingStatus = await invokeControl(
    runGraphCli,
    ['graph', 'status', 'missing', '--json'],
    { daemonDir: daemon.daemonDir },
  );
  assert.equal(missingStatus.code, 1);
  assert.equal(missingStatus.stdout.length, 0);
  assert.equal(missingStatus.stderr.length, 1);
  assert.match(missingStatus.stderr[0] as string, /not loaded/);

  const missingUnload = await invokeControl(
    runGraphCli,
    ['graph', 'unload', 'missing', '--json'],
    { daemonDir: daemon.daemonDir },
  );
  assert.equal(missingUnload.code, 1);
  assert.equal(missingUnload.stdout.length, 0);
  assert.equal(missingUnload.stderr.length, 1);

  const composition = tempJson(parkedComposition('parked'));
  const bindings = tempJson(freshBindings());
  const project = tempDir('wax-control-cli-parked-project-');
  const load = await invokeControl(
    runGraphCli,
    ['graph', 'load', composition, '--project', project, '--bindings', bindings, '--json'],
    { daemonDir: daemon.daemonDir },
  );
  assert.equal(load.code, 0);

  const trigger = await invokeControl(
    runTriggerCli,
    ['trigger', 'parked', 'ask', '--input', 'waiting', '--json'],
    { daemonDir: daemon.daemonDir },
  );
  const result = singleJson(trigger);
  assert.equal(result['rest'], false);
  assert.equal(result['hovered'], true);

  // waxd enables hover-only unload; the parked hover is flushed to Honey and
  // the graph is reclaimed without waiting for an answer.
  const unload = await invokeControl(
    runGraphCli,
    ['graph', 'unload', 'parked', '--json'],
    { daemonDir: daemon.daemonDir },
  );
  const unloaded = singleJson(unload);
  assert.equal(unloaded['graphId'], 'parked');
  assert.equal(unloaded['unloaded'], true);
  // A hover-only unload retains the session too.
  assert.deepEqual(daemon.adapter.closedNativeIds.length, 0);

  const list = singleJson(
    await invokeControl(runGraphCli, ['graph', 'list', '--json'], {
      daemonDir: daemon.daemonDir,
    }),
  );
  assert.equal((list['status'] as unknown[]).length, 0);
});
