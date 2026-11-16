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
} from './support/control-cli-fixtures.js';
import { startWaxd, startMultiWaxd } from './support/control-cli-daemons.js';


test('trigger usage errors exit 2 and a failed trigger is attempted exactly once', async (t) => {
  const noArguments = await invokeControl(runTriggerCli, ['trigger']);
  assert.equal(noArguments.code, 2);
  assert.equal(noArguments.stdout.length, 0);
  assert.equal(noArguments.stderr.length, 1);

  const oneArgument = await invokeControl(runTriggerCli, ['trigger', 'only']);
  assert.equal(oneArgument.code, 2);
  assert.equal(oneArgument.stdout.length, 0);
  assert.equal(oneArgument.stderr.length, 1);

  const daemon = await startWaxd(t);
  const composition = tempJson(foragerComposition('trigger-graph'));
  const bindings = tempJson(freshBindings());
  const project = tempDir('wax-control-cli-trigger-project-');
  const load = await invokeControl(
    runGraphCli,
    ['graph', 'load', composition, '--project', project, '--bindings', bindings, '--json'],
    { daemonDir: daemon.daemonDir },
  );
  assert.equal(load.code, 0);

  let calls = 0;
  const countingFetch: typeof fetch = (input, init) => {
    calls += 1;
    return globalThis.fetch(input, init);
  };
  const failed = await invokeControl(
    runTriggerCli,
    ['trigger', 'trigger-graph', 'missing-node', '--json'],
    { daemonDir: daemon.daemonDir, fetchImpl: countingFetch },
  );
  assert.equal(failed.code, 1);
  assert.equal(failed.stdout.length, 0);
  assert.equal(failed.stderr.length, 1);
  assert.equal(calls, 1);

  const triggered = await invokeControl(
    runTriggerCli,
    ['trigger', 'trigger-graph', 'only', '--input', 'once', '--json'],
    { daemonDir: daemon.daemonDir },
  );
  assert.equal(triggered.code, 0);
  assert.equal(daemon.adapter.prompts.length, 1);
});

test('graph load --manifest keeps its own project id, relative paths and idle ttl', async (t) => {
  const daemon = await startWaxd(t);
  const fixture = manifestFixture({
    graphId: 'manifest-graph',
    projectId: 'manifest-project-not-the-basename',
    idleTtlMs: 1_234,
  });

  const load = await invokeControl(
    runGraphCli,
    ['graph', 'load', '--manifest', fixture.manifestPath, '--json'],
    { daemonDir: daemon.daemonDir },
  );
  const loaded = singleJson(load);
  assert.equal(loaded['graphId'], 'manifest-graph');
  assert.equal(loaded['rest'], true);
  assert.equal(asRecord(loaded['residency'])['idleTtlMs'], 1_234);

  // The server received the manifest's project id, not a basename of the dir.
  const sessionsPath = join(daemon.daemonDir, 'sessions.json');
  const sessions = JSON.parse(
    readFileSync(sessionsPath, 'utf8'),
  ) as Array<Record<string, unknown>>;
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.['projectId'], 'manifest-project-not-the-basename');
  assert.equal(sessions[0]?.['projectDirectory'], resolve(fixture.project));

  // A second load is the existing 409 conflict, not a second session.
  const duplicate = await invokeControl(
    runGraphCli,
    ['graph', 'load', '--manifest', fixture.manifestPath, '--json'],
    { daemonDir: daemon.daemonDir },
  );
  assert.equal(duplicate.code, 1);
  assert.equal(duplicate.stdout.length, 0);
  assert.equal(duplicate.stderr.length, 1);
  assert.match(duplicate.stderr[0] as string, /conflict|409/);
  assert.equal(daemon.adapter.displayNames.length, 1);
});

test('graph load --manifest rejects conflicting flags and bad manifests before any session', async (t) => {
  const daemon = await startWaxd(t);
  const fixture = manifestFixture();
  const bindings = tempJson(freshBindings());
  const base = fixture.manifest;

  const usageCases: (readonly string[])[] = [
    // --manifest is mutually exclusive with a positional composition file.
    ['graph', 'load', fixture.composition, '--manifest', fixture.manifestPath, '--json'],
    // The manifest owns project, bindings and idle ttl.
    ['graph', 'load', '--manifest', fixture.manifestPath, '--project', fixture.project, '--json'],
    ['graph', 'load', '--manifest', fixture.manifestPath, '--bindings', bindings, '--json'],
    [
      'graph',
      'load',
      '--manifest',
      fixture.manifestPath,
      '--idle-ttl-ms',
      '5',
      '--json',
    ],
    // Explicit harness must agree with the manifest.
    [
      'graph',
      'load',
      '--manifest',
      fixture.manifestPath,
      '--harness',
      'dsh',
      '--json',
    ],
  ];

  for (const args of usageCases) {
    const invocation = await invokeControl(runGraphCli, args, {
      daemonDir: daemon.daemonDir,
    });
    assert.equal(
      daemon.adapter.displayNames.length,
      0,
      `rejected load created a session: ${args.join(' ')}`,
    );
    assert.equal(invocation.code, 2, invocation.stderr.join(' | '));
    assert.equal(invocation.stdout.length, 0);
    assert.equal(invocation.stderr.length, 1);
  }

  const badManifests = [
    writeManifestVariant(fixture.root, 'bad-version.wax.json', {
      ...base,
      schemaVersion: 2,
    }),
    writeManifestVariant(fixture.root, 'unknown-field.wax.json', {
      ...base,
      typoField: true,
    }),
    writeManifestVariant(fixture.root, 'missing-composition.wax.json', {
      ...base,
      composition: 'missing.json',
    }),
    writeManifestVariant(fixture.root, 'bad-idle.wax.json', {
      ...base,
      idleTtlMs: -5,
    }),
    writeManifestVariant(fixture.root, 'broken.wax.json', '{"schemaVersion": 1,'),
    join(fixture.root, 'absent.wax.json'),
  ];

  for (const manifestPath of badManifests) {
    const invocation = await invokeControl(
      runGraphCli,
      ['graph', 'load', '--manifest', manifestPath, '--json'],
      { daemonDir: daemon.daemonDir },
    );
    assert.equal(
      daemon.adapter.displayNames.length,
      0,
      `bad manifest created a session: ${manifestPath}`,
    );
    assert.equal(invocation.code, 2, invocation.stderr.join(' | '));
    assert.equal(invocation.stdout.length, 0);
    assert.equal(invocation.stderr.length, 1);
  }

  // None of the rejected commands reached /graphs/load.
  assert.equal(daemon.adapter.displayNames.length, 0);
  assert.equal(existsSync(join(daemon.daemonDir, 'sessions.json')), false);

  // The same daemon still accepts a valid manifest load.
  const valid = await invokeControl(
    runGraphCli,
    ['graph', 'load', '--manifest', fixture.manifestPath, '--json'],
    { daemonDir: daemon.daemonDir },
  );
  assert.equal(valid.code, 0, valid.stderr.join(' | '));
  assert.equal(daemon.adapter.displayNames.length, 1);
});

test('graph load --manifest accepts a matching --harness and stays on that daemon', async (t) => {
  const daemon = await startMultiWaxd(t);
  const fixture = manifestFixture({ graphId: 'manifest-codex', harness: 'codex' });

  const load = await invokeControl(
    runGraphCli,
    [
      'graph',
      'load',
      '--manifest',
      fixture.manifestPath,
      '--harness',
      'codex',
      '--json',
    ],
    { daemonDir: daemon.daemonDir },
  );
  assert.equal(singleJson(load)['graphId'], 'manifest-codex');
  assert.equal(daemon.adapters.get('codex')?.displayNames.length, 1);
  assert.equal(daemon.adapters.get('dsh')?.displayNames.length, 0);

  const mismatch = await invokeControl(
    runGraphCli,
    [
      'graph',
      'load',
      '--manifest',
      fixture.manifestPath,
      '--harness',
      'dsh',
      '--json',
    ],
    { daemonDir: daemon.daemonDir },
  );
  assert.equal(mismatch.code, 2);
  assert.equal(mismatch.stdout.length, 0);
  assert.equal(mismatch.stderr.length, 1);
  assert.match(mismatch.stderr[0] as string, /harness/);
  assert.equal(daemon.adapters.get('codex')?.displayNames.length, 1);
  assert.equal(daemon.adapters.get('dsh')?.displayNames.length, 0);
});

test('trigger --graph lazily loads a manifest graph and triggers it over real HTTP', async (t) => {
  const daemon = await startWaxd(t);
  const fixture = manifestFixture({
    graphId: 'trigger-manifest-graph',
    projectId: 'trigger-manifest-project',
  });

  const trigger = await invokeControl(
    runTriggerCli,
    [
      'trigger',
      'trigger-manifest-graph',
      'only',
      '--graph',
      fixture.manifestPath,
      '--input',
      'from manifest',
      '--json',
    ],
    { daemonDir: daemon.daemonDir },
  );
  const result = singleJson(trigger);
  assert.equal(result['graphId'], 'trigger-manifest-graph');
  assert.equal(result['rest'], true);
  assert.equal(result['persisted'], true);
  assert.equal(daemon.adapter.displayNames.length, 1);
  assert.equal(daemon.adapter.prompts.length, 1);
  assert.match(daemon.adapter.prompts[0] as string, /from manifest/);

  // The manifest's project identity and directory reached the daemon.
  const sessions = JSON.parse(
    readFileSync(join(daemon.daemonDir, 'sessions.json'), 'utf8'),
  ) as Array<Record<string, unknown>>;
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.['projectId'], 'trigger-manifest-project');
  assert.equal(sessions[0]?.['projectDirectory'], resolve(fixture.project));

  const status = singleJson(
    await invokeControl(
      runGraphCli,
      ['graph', 'status', 'trigger-manifest-graph', '--json'],
      { daemonDir: daemon.daemonDir },
    ),
  );
  assert.equal(status['rest'], true);
});

test('trigger --graph rejects empty, blank, control and oversized paths as usage', async (t) => {
  const daemon = await startWaxd(t);
  const usageCases: (readonly string[])[] = [
    ['trigger', 'graph', 'only', '--graph', '', '--json'],
    ['trigger', 'graph', 'only', '--graph', '   ', '--json'],
    ['trigger', 'graph', 'only', '--graph', 'bad\u0000path', '--json'],
    ['trigger', 'graph', 'only', '--graph', 'bad\u0001path', '--json'],
    ['trigger', 'graph', 'only', '--graph', 'x'.repeat(4_097), '--json'],
  ];

  for (const argv of usageCases) {
    const invocation = await invokeControl(runTriggerCli, argv, {
      daemonDir: daemon.daemonDir,
    });
    assert.equal(invocation.code, 2, argv.join(' '));
    assert.equal(invocation.stdout.length, 0);
    assert.equal(invocation.stderr.length, 1);
    assert.match(invocation.stderr[0] as string, /--graph/);
  }

  // Local validation runs before discovery and before any HTTP request.
  assert.equal(daemon.adapter.displayNames.length, 0);
  assert.equal(daemon.adapter.prompts.length, 0);
});

test('trigger --graph with an unreadable manifest exits 1 without a session', async (t) => {
  const daemon = await startWaxd(t);
  const missing = join(
    tempDir('wax-control-cli-missing-manifest-'),
    'absent.wax.json',
  );

  const invocation = await invokeControl(
    runTriggerCli,
    ['trigger', 'graph', 'only', '--graph', missing, '--json'],
    { daemonDir: daemon.daemonDir },
  );
  assert.equal(invocation.code, 1);
  assert.equal(invocation.stdout.length, 0);
  assert.equal(invocation.stderr.length, 1);
  assert.match(invocation.stderr[0] as string, /400|rejected/);
  assert.equal(daemon.adapter.displayNames.length, 0);
  assert.equal(daemon.adapter.prompts.length, 0);
});

test('graph answer answers an open hover over real HTTP and rejects bad local input', async (t) => {
  const daemon = await startWaxd(t);
  const composition = tempJson({
    schemaVersion: 1,
    id: 'answer-cli',
    nodes: {
      ask: { kind: 'user', config: { modality: 'text', prompt: 'Approve?' } },
    },
    edges: [],
  });
  const bindings = tempJson({});
  const project = tempDir('wax-control-cli-answer-project-');
  const load = await invokeControl(
    runGraphCli,
    ['graph', 'load', composition, '--project', project, '--bindings', bindings, '--json'],
    { daemonDir: daemon.daemonDir },
  );
  assert.equal(load.code, 0, load.stderr.join(' | '));

  const trigger = await invokeControl(
    runTriggerCli,
    ['trigger', 'answer-cli', 'ask', '--input', 'waiting', '--json'],
    { daemonDir: daemon.daemonDir },
  );
  assert.equal(singleJson(trigger)['hovered'], true);

  const answered = await invokeControl(
    runGraphCli,
    ['graph', 'answer', 'answer-cli', 'ask', '--input', 'done', '--json'],
    { daemonDir: daemon.daemonDir },
  );
  const result = singleJson(answered);
  assert.equal(result['graphId'], 'answer-cli');
  assert.equal(result['rest'], true);
  assert.equal(result['hovered'], false);
  assert.equal(result['persisted'], true);

  // Human output is a single summary line, not a JSON object.
  await invokeControl(
    runTriggerCli,
    ['trigger', 'answer-cli', 'ask', '--input', 'waiting again', '--json'],
    { daemonDir: daemon.daemonDir },
  );
  const human = await invokeControl(
    runGraphCli,
    ['graph', 'answer', 'answer-cli', 'ask', '--input', 'done again'],
    { daemonDir: daemon.daemonDir },
  );
  assert.equal(human.code, 0, human.stderr.join(' | '));
  assert.equal(human.stdout.length, 1);
  assert.match(
    human.stdout[0] as string,
    /^answer answer-cli rest=true hovered=false pumps=[0-9]+ persisted=true$/,
  );

  // A wrong token is a server 409; the token is never echoed.
  await invokeControl(
    runTriggerCli,
    ['trigger', 'answer-cli', 'ask', '--input', 'third', '--json'],
    { daemonDir: daemon.daemonDir },
  );
  const wrongToken = await invokeControl(
    runGraphCli,
    ['graph', 'answer', 'answer-cli', 'ask', '--token', 'hv_bogus', '--json'],
    { daemonDir: daemon.daemonDir },
  );
  assert.equal(wrongToken.code, 1);
  assert.equal(wrongToken.stdout.length, 0);
  assert.equal(wrongToken.stderr.length, 1);
  assert.match(wrongToken.stderr[0] as string, /409|conflict|hover/);
  assertNoSecret(wrongToken.stderr, 'hv_bogus');

  // The refused answer did not consume the hover.
  const recovered = singleJson(
    await invokeControl(
      runGraphCli,
      ['graph', 'answer', 'answer-cli', 'ask', '--input', 'recovered', '--json'],
      { daemonDir: daemon.daemonDir },
    ),
  );
  assert.equal(recovered['rest'], true);

  const usageCases: (readonly string[])[] = [
    ['graph', 'answer'],
    ['graph', 'answer', 'answer-cli'],
    ['graph', 'answer', 'answer-cli', 'ask', '--token', ''],
    ['graph', 'answer', 'answer-cli', 'ask', '--token', '   '],
    ['graph', 'answer', 'answer-cli', 'ask', '--token', 'bad\u0000token'],
    ['graph', 'answer', 'answer-cli', 'ask', '--token', 'x'.repeat(4_097)],
    ['graph', 'answer', 'answer-cli', 'ask', '--graph', ''],
    ['graph', 'answer', 'answer-cli', 'ask', '--graph', '   '],
    ['graph', 'answer', 'answer-cli', 'ask', '--graph', 'bad\u0000path'],
    ['graph', 'answer', 'answer-cli', 'ask', '--graph', 'x'.repeat(4_097)],
  ];
  for (const argv of usageCases) {
    const invocation = await invokeControl(runGraphCli, argv, {
      daemonDir: daemon.daemonDir,
    });
    assert.equal(invocation.code, 2, argv.join(' '));
    assert.equal(invocation.stdout.length, 0);
    assert.equal(invocation.stderr.length, 1);
  }

  // The user-only graph never creates a session or submits a prompt.
  assert.equal(daemon.adapter.displayNames.length, 0);
  assert.equal(daemon.adapter.prompts.length, 0);
});

test('graph answer --graph restores a waxd hover-only unload and forwards a real token', async (t) => {
  const daemon = await startWaxd(t);
  const fixture = manifestFixture({
    graphId: 'answer-manifest',
    composition: userForagerComposition('answer-manifest'),
    bindings: { idle: { kind: 'fresh' } },
  });

  const load = await invokeControl(
    runGraphCli,
    ['graph', 'load', '--manifest', fixture.manifestPath, '--json'],
    { daemonDir: daemon.daemonDir },
  );
  assert.equal(load.code, 0, load.stderr.join(' | '));
  assert.equal(daemon.adapter.displayNames.length, 1);

  const trigger = await invokeControl(
    runTriggerCli,
    ['trigger', 'answer-manifest', 'ask', '--input', 'waiting', '--json'],
    { daemonDir: daemon.daemonDir },
  );
  assert.equal(singleJson(trigger)['hovered'], true);

  // waxd allows a hover-only unload, so the parked hover is flushed and the
  // fresh session is retained for the explicit session API.
  const unload = await invokeControl(
    runGraphCli,
    ['graph', 'unload', 'answer-manifest', '--json'],
    { daemonDir: daemon.daemonDir },
  );
  const unloaded = singleJson(unload);
  assert.equal(unloaded['unloaded'], true);
  assert.equal(daemon.adapter.displayNames.length, 1);
  assert.equal(daemon.adapter.closedNativeIds.length, 0);

  // Read the flushed hover token from Honey; the CLI forwards it under
  // boundary checks, and the daemon validates it against the restored hover.
  const fieldPath = join(
    daemon.stateRoot,
    'apiaries',
    'apiary',
    'compositions',
    'answer-manifest',
    'honey',
    'field.json',
  );
  const saved = JSON.parse(readFileSync(fieldPath, 'utf8')) as {
    readonly nodes: {
      readonly ask?: { readonly hover?: { readonly token?: string } };
    };
  };
  const hoverToken = saved.nodes.ask?.hover?.token;
  assert.ok(typeof hoverToken === 'string' && hoverToken.startsWith('hv_'));

  const answered = await invokeControl(
    runGraphCli,
    [
      'graph',
      'answer',
      'answer-manifest',
      'ask',
      '--input',
      'answered',
      '--token',
      hoverToken,
      '--graph',
      fixture.manifestPath,
      '--json',
    ],
    { daemonDir: daemon.daemonDir },
  );
  const result = singleJson(answered);
  assert.equal(result['graphId'], 'answer-manifest');
  assert.equal(result['rest'], true);
  assert.equal(result['hovered'], false);
  assert.equal(daemon.adapter.displayNames.length, 2);
  assert.equal(daemon.adapter.prompts.length, 0);

  const status = singleJson(
    await invokeControl(runGraphCli, ['graph', 'status', 'answer-manifest', '--json'], {
      daemonDir: daemon.daemonDir,
    }),
  );
  assert.equal(status['rest'], true);

  // Memory wins: a loaded graph is answered even when --graph is unreadable.
  await invokeControl(
    runTriggerCli,
    ['trigger', 'answer-manifest', 'ask', '--input', 'waiting again', '--json'],
    { daemonDir: daemon.daemonDir },
  );
  const memoryWins = await invokeControl(
    runGraphCli,
    [
      'graph',
      'answer',
      'answer-manifest',
      'ask',
      '--input',
      'from memory',
      '--graph',
      join(fixture.root, 'absent.wax.json'),
      '--json',
    ],
    { daemonDir: daemon.daemonDir },
  );
  assert.equal(memoryWins.code, 0, memoryWins.stderr.join(' | '));
  assert.equal(singleJson(memoryWins)['rest'], true);
  assert.equal(daemon.adapter.displayNames.length, 2);
});
