import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { HarnessAdapter } from '../../src/adapters/harness.js';
import { createDefaultAdapter, type AdapterRequest } from '../../src/cli/cli-shared.js';
import { runWaxdCli, type WaxdStartedInfo } from '../../src/cli/waxd-cli.js';
import type { Project } from '../../src/project/kernel.js';
import { fromCompositionDefinition } from '../../src/b/live-hive-codec.js';
import type { GraphBindings } from '../../src/graph/binding.js';
import { parseComposition } from '../../src/runtime/index.js';
import { waitForRest } from '../support/control-server-http.js';

const LIVE_ID = 'm19g2-spread-gather';
const CODEX_PROMPT =
  'Pick a random integer from 1000 through 9999. ' +
  'Do not use tools. Reply with only the integer.';
const DSH_PROMPT =
  'Pick a random integer from 100 through 999. ' +
  'Do not use tools. Reply with only the integer.';
/** A 4-digit reply belongs to Codex; the package carries no harness label. */
const CODEX_MATCH =
  'const text = String(value.message).trim();' +
  ' const number = Number(text);' +
  ' return /^\\d{4}$/.test(text) && number >= 1000 && number <= 9999;';
/** A 3-digit reply belongs to DSH. */
const DSH_MATCH =
  'const text = String(value.message).trim();' +
  ' const number = Number(text);' +
  ' return /^\\d{3}$/.test(text) && number >= 100 && number <= 999;';

const dshRoot = process.env.DSH_ROOT;
const builtDshCli =
  dshRoot === undefined ? undefined : join(dshRoot, 'apps', 'cli', 'lib', 'bin.js');
const codexExe = process.env.CODEX_EXE;
const hasKey =
  process.env.OPENCODE_API_KEY !== undefined &&
  process.env.OPENCODE_API_KEY.trim() !== '';

const missing: string[] = [];
if (!hasKey) {
  missing.push('OPENCODE_API_KEY');
}
if (dshRoot === undefined || builtDshCli === undefined || !existsSync(builtDshCli)) {
  missing.push('DSH_ROOT with a built apps/cli/lib/bin.js');
}
if (codexExe === undefined || !existsSync(codexExe)) {
  missing.push('CODEX_EXE');
}

const integrationOptions = {
  skip:
    missing.length > 0
      ? `Real M19 spread/gather waxd test needs ${missing.join(', ')}`
      : false,
  timeout: 600_000,
};

interface HttpResult {
  readonly status: number;
  readonly body: Record<string, any>;
}

type LiveRequest = (
  info: WaxdStartedInfo,
  token: string,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
) => Promise<HttpResult>;

interface RunObservation {
  readonly codex: string;
  readonly dsh: string;
  readonly package: Record<string, unknown>;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let settle: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, resolve: (value: T) => settle?.(value) };
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function request(
  info: WaxdStartedInfo,
  token: string,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<HttpResult> {
  const response = await fetch(`${info.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(240_000),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, any>,
  };
}

function graphDefinition(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: LIVE_ID,
    nodes: {
      start: {
        kind: 'spread',
        config: { strategy: 'clone', targets: ['codex', 'dsh'] },
      },
      codex: {
        kind: 'forager',
        config: { connection: 'codex', prompt: CODEX_PROMPT },
      },
      dsh: {
        kind: 'forager',
        config: { connection: 'dsh', prompt: DSH_PROMPT },
      },
      join: {
        kind: 'gather',
        config: {
          strategy: 'assemble',
          types: {
            codex: { match: { code: CODEX_MATCH }, count: 1, reads: ['message'] },
            dsh: { match: { code: DSH_MATCH }, count: 1, reads: ['message'] },
          },
        },
      },
    },
    edges: [
      { id: 'codex-join', from: 'codex', to: 'join' },
      { id: 'dsh-join', from: 'dsh', to: 'join' },
    ],
  };
}

function spreadGatherLive(): Record<string, unknown> {
  const bindings: GraphBindings = {
    codex: { kind: 'fresh', harness: 'codex' },
    dsh: { kind: 'fresh', harness: 'dsh' },
  };
  return fromCompositionDefinition(
    parseComposition(graphDefinition()),
    bindings,
  ) as unknown as Record<string, unknown>;
}

function textOf(value: unknown): string {
  if (typeof value !== 'object' || value === null) {
    return '';
  }
  const record = value as Record<string, unknown>;
  return typeof record['message'] === 'string' ? record['message'] : '';
}

function outputValue(body: Record<string, any>, nodeId: string): unknown {
  const entries = body['outputs'] as Record<string, unknown>[] | undefined;
  return entries?.find((entry) => entry['nodeId'] === nodeId)?.['value'];
}

function messageOf(value: unknown): string {
  return textOf(value).trim();
}

function catalogState(body: Record<string, any>, liveId: string): unknown {
  const lives = body['lives'] as Record<string, unknown>[] | undefined;
  return lives?.find((entry) => entry['liveId'] === liveId)?.['state'];
}

function assertNumericReply(
  label: string,
  text: string,
  digits: number,
  min: number,
  max: number,
): void {
  assert.match(text, new RegExp(`^\\d{${String(digits)}}$`), `${label}: ${JSON.stringify(text)}`);
  const number = Number(text);
  assert.ok(
    number >= min && number <= max,
    `${label}: ${text} is outside ${String(min)}..${String(max)}`,
  );
}

/** The package entries are message strings; trim model whitespace only. */
function assertPackage(
  value: unknown,
  expected: { readonly codex: string; readonly dsh: string },
  label: string,
): Record<string, unknown> {
  assert.ok(
    typeof value === 'object' && value !== null && !Array.isArray(value),
    `${label}: gather package is not an object: ${JSON.stringify(value)}`,
  );
  const packageValue = value as Record<string, unknown>;
  assert.deepEqual(Object.keys(packageValue).sort(), ['codex', 'dsh']);
  for (const type of ['codex', 'dsh'] as const) {
    const entries = packageValue[type];
    assert.ok(Array.isArray(entries), `${label}: package.${type} is not an array`);
    assert.equal(entries.length, 1, `${label}: package.${type} length`);
    const entry = entries[0];
    assert.equal(typeof entry, 'string', `${label}: package.${type}[0] is not a string`);
    assert.equal(
      String(entry).trim(),
      expected[type],
      `${label}: package.${type} does not match the forager output`,
    );
  }
  return packageValue;
}

function promptsFor(
  promptsByHarness: Map<string, string[]>,
  harness: string,
): readonly string[] {
  const prompts = promptsByHarness.get(harness);
  assert.ok(prompts !== undefined, `no adapter was created for ${harness}`);
  return prompts;
}

function assertPromptRouting(
  promptsByHarness: Map<string, string[]>,
  expectedCount: number,
): void {
  const codexPrompts = promptsFor(promptsByHarness, 'codex');
  const dshPrompts = promptsFor(promptsByHarness, 'dsh');
  assert.equal(codexPrompts.length, expectedCount, 'codex prompt count');
  assert.equal(dshPrompts.length, expectedCount, 'dsh prompt count');
  const codexPrompt = codexPrompts[expectedCount - 1] ?? '';
  const dshPrompt = dshPrompts[expectedCount - 1] ?? '';
  assert.match(codexPrompt, /1000 through 9999/);
  assert.match(dshPrompt, /100 through 999/);
  assert.doesNotMatch(codexPrompt, /100 through 999/);
  assert.doesNotMatch(dshPrompt, /1000 through 9999/);
}

/** Triggers the spread, waits for Rest, and asserts the replies and package. */
async function observeRun(
  requestLive: LiveRequest,
  info: WaxdStartedInfo,
  token: string,
  input: string,
  label: string,
): Promise<RunObservation> {
  const triggered = await requestLive(info, token, 'POST', '/lives/trigger', {
    liveId: LIVE_ID,
    beeId: 'start',
    input,
  });
  assert.equal(triggered.status, 202, `${label}: ${JSON.stringify(triggered.body)}`);
  const rest = await waitForRest(info.url, token, LIVE_ID, 300_000);
  assert.equal(rest.body?.['status']?.['rest'], true, `${label}: field is not at Rest`);
  const body = rest.body as Record<string, any>;
  const codex = messageOf(outputValue(body, 'codex'));
  const dsh = messageOf(outputValue(body, 'dsh'));
  assertNumericReply(`${label} codex`, codex, 4, 1000, 9999);
  assertNumericReply(`${label} dsh`, dsh, 3, 100, 999);
  const packageValue = assertPackage(
    outputValue(body, 'join'),
    { codex, dsh },
    label,
  );
  return { codex, dsh, package: packageValue };
}

interface DaemonHarness {
  readonly info: WaxdStartedInfo;
  readonly project: Project;
  readonly controller: AbortController;
  readonly run: Promise<number>;
  readonly stdout: string[];
  readonly stderr: string[];
  readonly daemonDir: string;
  readonly promptsByHarness: Map<string, string[]>;
}

/** Records every prompt an adapter actually receives, per harness. */
function trackingAdapterFactory(
  promptsByHarness: Map<string, string[]>,
): (adapterRequest: AdapterRequest) => Promise<HarnessAdapter> {
  return async (adapterRequest) => {
    const adapter = await createDefaultAdapter(adapterRequest);
    const prompts: string[] = [];
    promptsByHarness.set(adapterRequest.harness, prompts);
    const submit = adapter.submit.bind(adapter);
    return new Proxy(adapter, {
      get(target, property, receiver) {
        if (property === 'submit') {
          return (...args: Parameters<HarnessAdapter['submit']>) => {
            prompts.push(args[2]);
            return submit(...args);
          };
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
  };
}

function waxdArgs(
  stateRoot: string,
  daemonDir: string,
  dshCheckout: string,
  codexBinary: string,
): string[] {
  return [
    '--harnesses', 'codex,dsh',
    '--state-root', stateRoot,
    '--daemon-dir', daemonDir,
    '--apiary', 'apiary',
    '--port', '0',
    '--session-ttl-ms', '0',
    '--session-sweep-interval-ms', '0',
    '--codex-exe', codexBinary,
    '--dsh-root', dshCheckout,
  ];
}

async function startHarness(): Promise<DaemonHarness> {
  if (dshRoot === undefined || codexExe === undefined) {
    throw new Error('integration environment is missing');
  }
  const stateRoot = mkdtempSync(join(tmpdir(), 'wax-m19g2-state-'));
  const daemonDir = join(stateRoot, 'waxd');
  const project: Project = {
    id: 'project-m19g2',
    directory: mkdtempSync(join(tmpdir(), 'wax-m19g2-project-')),
  };
  const controller = new AbortController();
  const started = deferred<WaxdStartedInfo>();
  const stdout: string[] = [];
  const stderr: string[] = [];
  const promptsByHarness = new Map<string, string[]>();
  const run = runWaxdCli(waxdArgs(stateRoot, daemonDir, dshRoot, codexExe), {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
    signal: controller.signal,
    installSignalHandlers: false,
    createAdapter: trackingAdapterFactory(promptsByHarness),
    onStarted: (info) => started.resolve(info),
  });
  run.catch(() => undefined);
  let info: WaxdStartedInfo;
  try {
    info = await withTimeout(started.promise, 180_000, 'real waxd startup');
  } catch (error) {
    controller.abort();
    await run.catch(() => undefined);
    throw error;
  }
  return { info, project, controller, run, stdout, stderr, daemonDir, promptsByHarness };
}

async function stopHarness(
  harness: DaemonHarness,
  t: { diagnostic: (message: string) => void },
  mainError: unknown,
): Promise<void> {
  harness.controller.abort();
  const code = await harness.run.catch(() => 1);
  if (mainError !== undefined) {
    t.diagnostic(
      `cleanup after failure: exit=${String(code)} stderr=${JSON.stringify(harness.stderr)}`,
    );
    return;
  }
  assert.equal(harness.stderr.length, 0, harness.stderr.join(' | '));
  assert.equal(code, 0);
  assert.equal(existsSync(join(harness.daemonDir, 'token')), false);
  assert.equal(existsSync(join(harness.daemonDir, 'server.json')), false);
  assert.equal(
    harness.stdout.filter((line) => line.startsWith('waxd listening ')).length,
    1,
  );
}

async function loadLive(
  requestLive: LiveRequest,
  info: WaxdStartedInfo,
  token: string,
  project: Project,
): Promise<void> {
  const loaded = await requestLive(info, token, 'POST', '/lives', {
    live: spreadGatherLive(),
    project,
  });
  assert.equal(loaded.status, 200, JSON.stringify(loaded.body));
  assert.equal(loaded.body['liveId'], LIVE_ID);
  const catalog = await requestLive(info, token, 'GET', '/lives');
  assert.equal(catalogState(catalog.body, LIVE_ID), 'loaded');
}

async function unloadLive(
  requestLive: LiveRequest,
  info: WaxdStartedInfo,
  token: string,
): Promise<void> {
  const unloaded = await requestLive(info, token, 'POST', '/lives/unload', {
    liveId: LIVE_ID,
  });
  assert.equal(unloaded.status, 200, JSON.stringify(unloaded.body));
  assert.equal(unloaded.body['unloaded'], true);
  const catalog = await requestLive(info, token, 'GET', '/lives');
  assert.equal(catalogState(catalog.body, LIVE_ID), 'unloaded');
}

async function reloadLive(
  requestLive: LiveRequest,
  info: WaxdStartedInfo,
  token: string,
  project: Project,
): Promise<void> {
  const reloaded = await requestLive(info, token, 'POST', '/lives/load', {
    liveId: LIVE_ID,
    project,
  });
  assert.equal(reloaded.status, 200, JSON.stringify(reloaded.body));
  assert.equal(reloaded.body['liveId'], LIVE_ID);
  const catalog = await requestLive(info, token, 'GET', '/lives');
  assert.equal(catalogState(catalog.body, LIVE_ID), 'loaded');
}

async function assertTwoSessions(
  requestLive: LiveRequest,
  info: WaxdStartedInfo,
  token: string,
  project: Project,
): Promise<void> {
  // Session records are persisted after the native sessions are created; the
  // field can already be at Rest while /sessions is still catching up.
  let summaries: Record<string, unknown>[] = [];
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const sessions = await requestLive(info, token, 'GET', '/sessions');
    assert.equal(sessions.status, 200);
    summaries = sessions.body['sessions'] as Record<string, unknown>[];
    const harnesses = summaries.map((session) => session['harness']).sort();
    if (summaries.length === 2 && harnesses[0] === 'codex' && harnesses[1] === 'dsh') {
      break;
    }
    if (attempt < 49) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  assert.deepEqual(
    summaries.map((session) => session['harness']).sort(),
    ['codex', 'dsh'],
    `expected codex+dsh sessions, got ${JSON.stringify(summaries)}`,
  );
  assert.equal(
    summaries.length,
    2,
    `expected exactly two sessions, got ${JSON.stringify(summaries)}`,
  );
  assert.equal(
    summaries.every((session) => session['projectId'] === project.id),
    true,
    `sessions do not all belong to project '${project.id}': ${JSON.stringify(summaries)}`,
  );
}

test(
  'real waxd spreads into Codex+DSH and gathers one assemble package',
  integrationOptions,
  async (t) => {
    const harness = await startHarness();
    const { info, project, promptsByHarness } = harness;
    let mainError: unknown;
    try {
      const token = readFileSync(info.tokenPath, 'utf8').trim();
      assert.deepEqual(info.harnesses, ['codex', 'dsh']);
      t.diagnostic(
        'topology: start(spread clone) -> codex/dsh foragers -> join(gather assemble, 1 per type)',
      );

      const health = await request(info, token, 'GET', '/health');
      assert.equal(health.status, 200);
      assert.deepEqual(health.body['harnesses'], ['codex', 'dsh']);

      await loadLive(request, info, token, project);
      const first = await observeRun(request, info, token, 'go', 'first run');
      assertPromptRouting(promptsByHarness, 1);
      t.diagnostic(
        `first run: codex=${first.codex} (1000..9999), dsh=${first.dsh} (100..999), ` +
          `package=${JSON.stringify(first.package)}`,
      );
      await assertTwoSessions(request, info, token, project);

      await unloadLive(request, info, token);
      await reloadLive(request, info, token, project);
      const second = await observeRun(request, info, token, 'again', 'second run');
      assertPromptRouting(promptsByHarness, 2);
      t.diagnostic(
        `second run: codex=${second.codex} (1000..9999), dsh=${second.dsh} (100..999), ` +
          `package=${JSON.stringify(second.package)}`,
      );
    } catch (error) {
      mainError = error;
      throw error;
    } finally {
      await stopHarness(harness, t, mainError);
    }
  },
);
