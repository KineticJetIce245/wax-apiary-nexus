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
  deferred,
  withTimeout,
} from './support/control-cli-fixtures.js';
import { startWaxd, startMultiWaxd } from './support/control-cli-daemons.js';

test('wax session list/close work over real HTTP and never print a token', async (t) => {
  const daemon = await startWaxd(t);
  const token = readFileSync(daemon.started.tokenPath, 'utf8').trim();
  const sessionsPath = join(daemon.daemonDir, 'sessions.json');
  const bindings = tempJson(freshBindings());
  const project = tempDir('wax-control-cli-session-project-');
  const composition = tempJson(foragerComposition('session-cli'));

  const load = await invokeControl(
    runGraphCli,
    ['graph', 'load', composition, '--project', project, '--bindings', bindings, '--json'],
    { daemonDir: daemon.daemonDir },
  );
  assert.equal(load.code, 0, load.stderr.join(' | '));

  const listed = await invokeControl(runSessionCli, ['session', 'list', '--json'], {
    daemonDir: daemon.daemonDir,
  });
  const listBody = singleJson(listed);
  const summaries = listBody['sessions'] as Record<string, unknown>[];
  assert.equal(summaries.length, 1);
  const summary = summaries[0];
  assert.ok(summary !== undefined);
  assert.deepEqual(Object.keys(summary).sort(), [
    'bound',
    'busy',
    'harness',
    'projectId',
    'sessionId',
  ]);
  assert.equal(summary['harness'], 'codex');
  assert.equal(summary['busy'], false);
  assert.equal(summary['bound'], true);
  const sessionId = summary['sessionId'];
  assert.equal(typeof sessionId, 'string');
  const listedText = listed.stdout.join('\n');
  assert.equal(listedText.includes('native-'), false);
  assert.equal(listedText.includes('projectDirectory'), false);
  assert.equal(listedText.includes(project), false);
  assertNoSecret(listed.stdout, token);

  const humanList = await invokeControl(runSessionCli, ['session', 'list'], {
    daemonDir: daemon.daemonDir,
  });
  assert.equal(humanList.code, 0, humanList.stderr.join(' | '));
  assert.equal(humanList.stdout.length, 1);
  assert.equal(
    humanList.stdout[0],
    `${String(sessionId)} harness=codex project=${String(summary['projectId'])} ` +
      'busy=no bound=yes',
  );

  // A session bound to a loaded graph cannot be closed.
  const boundClose = await invokeControl(
    runSessionCli,
    ['session', 'close', sessionId as string, '--json'],
    { daemonDir: daemon.daemonDir },
  );
  assert.equal(boundClose.code, 1);
  assert.equal(boundClose.stdout.length, 0);
  assert.equal(boundClose.stderr.length, 1);
  assert.match(boundClose.stderr[0] as string, /409|conflict/);
  assertNoSecret(boundClose.stderr, token);

  const unload = await invokeControl(
    runGraphCli,
    ['graph', 'unload', 'session-cli', '--json'],
    { daemonDir: daemon.daemonDir },
  );
  assert.equal(unload.code, 0, unload.stderr.join(' | '));
  // The unload retains the session; the list still shows it, now unbound.
  assert.equal(daemon.adapter.closedNativeIds.length, 0);
  const afterUnload = await invokeControl(runSessionCli, ['session', 'list', '--json'], {
    daemonDir: daemon.daemonDir,
  });
  const afterUnloadBody = singleJson(afterUnload);
  const afterUnloadSessions = afterUnloadBody['sessions'] as Record<string, unknown>[];
  assert.equal(afterUnloadSessions.length, 1);
  assert.equal(afterUnloadSessions[0]?.['sessionId'], sessionId);
  assert.equal(afterUnloadSessions[0]?.['bound'], false);

  const closed = await invokeControl(
    runSessionCli,
    ['session', 'close', sessionId as string, '--json'],
    { daemonDir: daemon.daemonDir },
  );
  assert.equal(closed.code, 0, closed.stderr.join(' | '));
  assert.deepEqual(singleJson(closed), { closed: true });
  assert.equal(daemon.adapter.closedNativeIds.length, 1);
  assert.deepEqual(JSON.parse(readFileSync(sessionsPath, 'utf8')), []);
  const empty = await invokeControl(runSessionCli, ['session', 'list', '--json'], {
    daemonDir: daemon.daemonDir,
  });
  assert.deepEqual(singleJson(empty)['sessions'], []);

  // Closing an unknown/already closed session exits 1.
  const again = await invokeControl(
    runSessionCli,
    ['session', 'close', sessionId as string],
    { daemonDir: daemon.daemonDir },
  );
  assert.equal(again.code, 1);
  assert.equal(again.stdout.length, 0);
  assert.equal(again.stderr.length, 1);
  assert.match(again.stderr[0] as string, /unknown or already closed/);
  assertNoSecret(again.stderr, token);

  // A human close prints one line and still removes the session.
  const compositionB = tempJson(foragerComposition('session-cli-b'));
  await invokeControl(
    runGraphCli,
    ['graph', 'load', compositionB, '--project', project, '--bindings', bindings, '--json'],
    { daemonDir: daemon.daemonDir },
  );
  const unloadB = await invokeControl(
    runGraphCli,
    ['graph', 'unload', 'session-cli-b', '--json'],
    { daemonDir: daemon.daemonDir },
  );
  assert.equal(unloadB.code, 0, unloadB.stderr.join(' | '));
  const listB = singleJson(
    await invokeControl(runSessionCli, ['session', 'list', '--json'], {
      daemonDir: daemon.daemonDir,
    }),
  );
  const sessionB = (listB['sessions'] as Record<string, unknown>[])[0]?.['sessionId'];
  assert.equal(typeof sessionB, 'string');
  const humanClose = await invokeControl(
    runSessionCli,
    ['session', 'close', sessionB as string],
    { daemonDir: daemon.daemonDir },
  );
  assert.equal(humanClose.code, 0, humanClose.stderr.join(' | '));
  assert.equal(humanClose.stdout.length, 1);
  assert.equal(humanClose.stdout[0], `closed ${String(sessionB)}`);
  assert.equal(daemon.adapter.closedNativeIds.length, 2);
  assert.deepEqual(JSON.parse(readFileSync(sessionsPath, 'utf8')), []);

  // Local usage errors exit 2 before discovery or any HTTP request.
  const usageCases: (readonly string[])[] = [
    ['session'],
    ['session', 'close'],
    ['session', 'close', 'a', 'b'],
    ['session', 'list', 'extra'],
    ['session', 'bogus'],
    ['session', 'close', 'bad\u0000id'],
    ['session', 'close', 'x'.repeat(513)],
    ['session', 'list', '--json', '--json'],
    ['session', 'list', '--wat'],
  ];
  for (const argv of usageCases) {
    const invocation = await invokeControl(runSessionCli, argv, {
      daemonDir: daemon.daemonDir,
    });
    assert.equal(invocation.code, 2, argv.join(' '));
    assert.equal(invocation.stdout.length, 0);
    assert.equal(invocation.stderr.length, 1);
  }
});

test('wax session sweep closes orphan idle sessions over real HTTP', async (t) => {
  const daemon = await startWaxd(t, ['--session-ttl-ms', '20']);
  const token = readFileSync(daemon.started.tokenPath, 'utf8').trim();
  const sessionsPath = join(daemon.daemonDir, 'sessions.json');
  const bindings = tempJson(freshBindings());
  const project = tempDir('wax-control-cli-sweep-project-');
  const composition = tempJson(foragerComposition('sweep-cli'));

  const load = await invokeControl(
    runGraphCli,
    ['graph', 'load', composition, '--project', project, '--bindings', bindings, '--json'],
    { daemonDir: daemon.daemonDir },
  );
  assert.equal(load.code, 0, load.stderr.join(' | '));

  const listed = singleJson(
    await invokeControl(runSessionCli, ['session', 'list', '--json'], {
      daemonDir: daemon.daemonDir,
    }),
  );
  const summaries = listed['sessions'] as Record<string, unknown>[];
  const sessionId = summaries[0]?.['sessionId'];
  assert.equal(typeof sessionId, 'string');

  // Bound to a loaded graph: the sweep reports it as skipped, never closes it.
  const boundSweep = await invokeControl(runSessionCli, ['session', 'sweep', '--json'], {
    daemonDir: daemon.daemonDir,
  });
  assert.equal(boundSweep.code, 0, boundSweep.stderr.join(' | '));
  const boundReport = singleJson(boundSweep);
  assert.deepEqual(boundReport['closed'], []);
  assert.deepEqual(boundReport['skipped'], [sessionId]);
  assert.deepEqual(boundReport['failed'], []);

  const unload = await invokeControl(
    runGraphCli,
    ['graph', 'unload', 'sweep-cli', '--json'],
    { daemonDir: daemon.daemonDir },
  );
  assert.equal(unload.code, 0, unload.stderr.join(' | '));

  // The session is now an orphan; let the 20ms TTL expire.
  await new Promise((resolve) => setTimeout(resolve, 60));
  const sweep = await invokeControl(runSessionCli, ['session', 'sweep', '--json'], {
    daemonDir: daemon.daemonDir,
  });
  assert.equal(sweep.code, 0, sweep.stderr.join(' | '));
  assert.deepEqual(singleJson(sweep), {
    closed: [sessionId],
    skipped: [],
    failed: [],
  });
  assert.deepEqual(daemon.adapter.closedNativeIds, ['native-1']);
  assert.deepEqual(JSON.parse(readFileSync(sessionsPath, 'utf8')), []);
  assertNoSecret(sweep.stdout, token);

  // An empty sweep prints one count line; nothing is echoed beyond ids.
  const human = await invokeControl(runSessionCli, ['session', 'sweep'], {
    daemonDir: daemon.daemonDir,
  });
  assert.equal(human.code, 0, human.stderr.join(' | '));
  assert.deepEqual(human.stdout, ['session sweep closed=0 skipped=0 failed=0']);
  assert.equal(human.stdout[0]?.includes('native-'), false);
  assertNoSecret(human.stdout, token);

  // Local usage errors exit 2 before discovery or any HTTP request.
  for (const argv of [['session', 'sweep', 'extra'], ['session', 'sweep', '--wat']]) {
    const invocation = await invokeControl(runSessionCli, argv, {
      daemonDir: daemon.daemonDir,
    });
    assert.equal(invocation.code, 2, argv.join(' '));
    assert.equal(invocation.stdout.length, 0);
  }
});

test('wax session list returns all sessions from one endpoint and --harness only filters', async (t) => {
  const daemon = await startMultiWaxd(t);
  const project = tempDir('wax-control-cli-session-filter-project-');
  const codexComposition = tempJson(foragerComposition('session-codex'));
  const dshComposition = tempJson(foragerComposition('session-dsh'));

  const loads = [
    await invokeControl(
      runGraphCli,
      [
        'graph',
        'load',
        codexComposition,
        '--project',
        project,
        '--bindings',
        tempJson({ only: { kind: 'fresh', harness: 'codex' } }),
        '--json',
      ],
      { daemonDir: daemon.daemonDir },
    ),
    await invokeControl(
      runGraphCli,
      [
        'graph',
        'load',
        dshComposition,
        '--project',
        project,
        '--bindings',
        tempJson({ only: { kind: 'fresh', harness: 'dsh' } }),
        '--json',
      ],
      { daemonDir: daemon.daemonDir },
    ),
  ];
  for (const load of loads) {
    assert.equal(load.code, 0, load.stderr.join(' | '));
  }

  const all = singleJson(
    await invokeControl(runSessionCli, ['session', 'list', '--json'], {
      daemonDir: daemon.daemonDir,
    }),
  );
  const allSessions = all['sessions'] as Record<string, unknown>[];
  assert.deepEqual(
    allSessions.map((session) => session['harness']).sort(),
    ['codex', 'dsh'],
  );

  const codex = singleJson(
    await invokeControl(
      runSessionCli,
      ['session', 'list', '--harness', 'codex', '--json'],
      { daemonDir: daemon.daemonDir },
    ),
  );
  const codexSessions = codex['sessions'] as Record<string, unknown>[];
  assert.equal(codexSessions.length, 1);
  assert.equal(codexSessions[0]?.['harness'], 'codex');

  const dsh = singleJson(
    await invokeControl(
      runSessionCli,
      ['session', 'list', '--harness', 'dsh', '--json'],
      { daemonDir: daemon.daemonDir },
    ),
  );
  const dshSessions = dsh['sessions'] as Record<string, unknown>[];
  assert.equal(dshSessions.length, 1);
  assert.equal(dshSessions[0]?.['harness'], 'dsh');

  const invalidHarness = await invokeControl(
    runSessionCli,
    ['session', 'list', '--harness', 'claude', '--json'],
    { daemonDir: daemon.daemonDir },
  );
  assert.equal(invalidHarness.code, 2);
  assert.match(invalidHarness.stderr[0] as string, /--harness must be/);
});

test('graph and trigger commands use one endpoint; --harness never selects a directory', async (t) => {
  const daemon = await startMultiWaxd(t);
  const project = tempDir('wax-control-cli-multi-cli-project-');
  const codexComposition = tempJson(foragerComposition('codex-graph'));
  const dshComposition = tempJson(foragerComposition('dsh-graph'));

  const loadCodex = await invokeControl(
    runGraphCli,
    [
      'graph',
      'load',
      codexComposition,
      '--project',
      project,
      '--bindings',
      tempJson({ only: { kind: 'fresh', harness: 'codex' } }),
      '--harness',
      'codex',
      '--json',
    ],
    { daemonDir: daemon.daemonDir },
  );
  assert.equal(singleJson(loadCodex)['graphId'], 'codex-graph');
  const loadDsh = await invokeControl(
    runGraphCli,
    [
      'graph',
      'load',
      dshComposition,
      '--project',
      project,
      '--bindings',
      tempJson({ only: { kind: 'fresh', harness: 'dsh' } }),
      '--harness',
      'dsh',
      '--json',
    ],
    { daemonDir: daemon.daemonDir },
  );
  assert.equal(singleJson(loadDsh)['graphId'], 'dsh-graph');

  // graph list ignores --harness: the daemon returns all loaded graphs.
  const allGraphs = singleJson(
    await invokeControl(runGraphCli, ['graph', 'list', '--harness', 'codex', '--json'], {
      daemonDir: daemon.daemonDir,
    }),
  );
  assert.deepEqual(
    (allGraphs['status'] as unknown[]).map((status) => asRecord(status)['graphId']).sort(),
    ['codex-graph', 'dsh-graph'],
  );

  const codexTrigger = singleJson(
    await invokeControl(
      runTriggerCli,
      ['trigger', 'codex-graph', 'only', '--input', 'to codex', '--harness', 'codex', '--json'],
      { daemonDir: daemon.daemonDir },
    ),
  );
  assert.equal(codexTrigger['graphId'], 'codex-graph');
  const dshTrigger = singleJson(
    await invokeControl(
      runTriggerCli,
      ['trigger', 'dsh-graph', 'only', '--input', 'to dsh', '--harness', 'dsh', '--json'],
      { daemonDir: daemon.daemonDir },
    ),
  );
  assert.equal(dshTrigger['graphId'], 'dsh-graph');
  assert.equal(daemon.adapters.get('codex')?.prompts.length, 1);
  assert.equal(daemon.adapters.get('dsh')?.prompts.length, 1);

  assert.equal(
    singleJson(
      await invokeControl(
        runGraphCli,
        ['graph', 'unload', 'codex-graph', '--harness', 'codex', '--json'],
        { daemonDir: daemon.daemonDir },
      ),
    )['unloaded'],
    true,
  );
  assert.equal(daemon.adapters.get('codex')?.closedNativeIds.length, 0);
  assert.equal(daemon.adapters.get('dsh')?.closedNativeIds.length, 0);
  assert.equal(
    singleJson(
      await invokeControl(
        runGraphCli,
        ['graph', 'status', 'dsh-graph', '--harness', 'dsh', '--json'],
        { daemonDir: daemon.daemonDir },
      ),
    )['graphId'],
    'dsh-graph',
  );

  assert.equal(existsSync(join(daemon.daemonDir, 'codex')), false);
  assert.equal(existsSync(join(daemon.daemonDir, 'dsh')), false);
  assert.equal(existsSync(join(daemon.daemonDir, 'token')), true);
});

test('one daemon stores a mixed-harness graph in one sessions file and one Honey root', async (t) => {
  const daemon = await startMultiWaxd(t, { apiary: 'smoke' });
  const project = tempDir('wax-control-cli-honey-project-');
  const composition = tempJson({
    schemaVersion: 1,
    id: 'mixed-graph',
    nodes: {
      codex: { kind: 'forager', config: { connection: 'codex', prompt: 'codex {{input}}' } },
      dsh: { kind: 'forager', config: { connection: 'dsh', prompt: 'dsh {{input}}' } },
    },
    edges: [],
  });
  const bindings = tempJson({
    codex: { kind: 'fresh', harness: 'codex' },
    dsh: { kind: 'fresh', harness: 'dsh' },
  });

  const load = await invokeControl(
    runGraphCli,
    ['graph', 'load', composition, '--project', project, '--bindings', bindings, '--json'],
    { daemonDir: daemon.daemonDir },
  );
  assert.equal(load.code, 0, load.stderr.join(' | '));

  for (const nodeId of ['codex', 'dsh']) {
    const trigger = await invokeControl(
      runTriggerCli,
      ['trigger', 'mixed-graph', nodeId, '--input', `from ${nodeId}`, '--json'],
      { daemonDir: daemon.daemonDir },
    );
    assert.equal(trigger.code, 0, trigger.stderr.join(' | '));
  }

  assert.equal(daemon.adapters.get('codex')?.prompts.length, 1);
  assert.equal(daemon.adapters.get('dsh')?.prompts.length, 1);
  assert.match(daemon.adapters.get('codex')?.prompts[0] ?? '', /from codex/);
  assert.match(daemon.adapters.get('dsh')?.prompts[0] ?? '', /from dsh/);

  const sessions = JSON.parse(
    readFileSync(join(daemon.daemonDir, 'sessions.json'), 'utf8'),
  ) as Array<Record<string, unknown>>;
  assert.deepEqual(
    sessions.map((session) => session['harness']).sort(),
    ['codex', 'dsh'],
  );

  const fieldPath = join(
    daemon.stateRoot,
    'apiaries',
    'smoke',
    'compositions',
    'mixed-graph',
    'honey',
    'field.json',
  );
  assert.equal(existsSync(fieldPath), true);
  assert.equal(
    existsSync(
      join(daemon.stateRoot, 'codex', 'apiaries', 'smoke', 'compositions', 'mixed-graph'),
    ),
    false,
  );
  assert.equal(
    existsSync(
      join(daemon.stateRoot, 'dsh', 'apiaries', 'smoke', 'compositions', 'mixed-graph'),
    ),
    false,
  );

  // Unload retains both sessions; no native close is a graph-unload side effect.
  assert.equal(
    singleJson(
      await invokeControl(runGraphCli, ['graph', 'unload', 'mixed-graph', '--json'], {
        daemonDir: daemon.daemonDir,
      }),
    )['unloaded'],
    true,
  );
  assert.equal(daemon.adapters.get('codex')?.closedNativeIds.length, 0);
  assert.equal(daemon.adapters.get('dsh')?.closedNativeIds.length, 0);
  assert.equal(
    (
      JSON.parse(
        readFileSync(join(daemon.daemonDir, 'sessions.json'), 'utf8'),
      ) as unknown[]
    ).length,
    2,
  );
});

test('a one-entry --harnesses list keeps the single-harness root layout', async (t) => {
  const adapter = new TrackingFakeAdapter();
  const stateRoot = tempDir('wax-control-cli-single-list-state-');
  const daemonDir = join(stateRoot, 'waxd');
  const stdout: string[] = [];
  const stderr: string[] = [];
  const started = deferred<WaxdStartedInfo>();
  const controller = new AbortController();

  const run = runWaxdCli(
    [
      '--harnesses',
      'codex',
      '--state-root',
      stateRoot,
      '--daemon-dir',
      daemonDir,
      '--apiary',
      'smoke',
    ],
    {
      createAdapter: async () => adapter,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      signal: controller.signal,
      installSignalHandlers: false,
      onStarted: (info) => started.resolve(info),
    },
  );
  run.catch(() => undefined);
  t.after(async () => {
    controller.abort();
    await run.catch(() => undefined);
  });

  const info = await withTimeout(started.promise, 5_000, 'single-list waxd start');
  assert.deepEqual(info.harnesses, ['codex']);
  assert.equal(info.stateRoot, stateRoot);
  assert.equal(info.daemonDir, daemonDir);
  assert.equal(stdout.length, 5);
  assert.equal(stdout[1], 'harnesses codex');
  assert.equal(stdout[2], `state    ${stateRoot}`);
  assert.equal(stdout[3], `daemon   ${daemonDir}`);
  assert.equal(existsSync(join(daemonDir, 'token')), true);
  assert.equal(existsSync(join(daemonDir, 'codex')), false);
  assert.equal(existsSync(join(stateRoot, 'codex')), false);

  const composition = tempJson(foragerComposition('single-list-graph'));
  const bindings = tempJson(freshBindings());
  const project = tempDir('wax-control-cli-single-list-project-');
  const load = await invokeControl(
    runGraphCli,
    ['graph', 'load', composition, '--project', project, '--bindings', bindings, '--json'],
    { daemonDir },
  );
  assert.equal(singleJson(load)['graphId'], 'single-list-graph');
  const trigger = await invokeControl(
    runTriggerCli,
    ['trigger', 'single-list-graph', 'only', '--input', 'single', '--json'],
    { daemonDir },
  );
  assert.equal(singleJson(trigger)['persisted'], true);
  assert.equal(
    existsSync(
      join(
        stateRoot,
        'apiaries',
        'smoke',
        'compositions',
        'single-list-graph',
        'honey',
        'field.json',
      ),
    ),
    true,
  );
  assert.equal(
    existsSync(
      join(
        stateRoot,
        'codex',
        'apiaries',
        'smoke',
        'compositions',
        'single-list-graph',
        'honey',
        'field.json',
      ),
    ),
    false,
  );

  controller.abort();
  const code = await run;
  assert.equal(code, 0);
  assert.equal(stderr.length, 0);
  assert.equal(adapter.stopCalls, 1);
});
