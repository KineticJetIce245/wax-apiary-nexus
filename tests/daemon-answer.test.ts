import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  createAnswerId,
  ensureAnswerInbox,
  listAnswerFiles,
  writeAnswerRecord,
  type AnswerRecord,
} from '../src/answer-inbox.js';
import { runCli } from '../src/cli.js';
import { apiaryForProject } from '../src/cli-shared.js';
import { runDaemon } from '../src/daemon.js';
import { HoneyStore, honeyPaths, type HoneyPaths } from '../src/honey.js';
import {
  parseComposition,
  PheromoneRuntime,
  type CompositionDefinition,
  type HoverSpec,
  type PersistedField,
  type Value,
} from '../src/runtime/index.js';
import { FakeAdapter } from './support/fake-adapter.js';

interface Capture {
  readonly stdout: string[];
  readonly stderr: string[];
  readonly deps: {
    stdout: (line: string) => void;
    stderr: (line: string) => void;
  };
}

function capture(): Capture {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    deps: { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
  };
}

function tempDirectory(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function compositionFile(contents: unknown): string {
  const path = join(tempDirectory('wax-daemon-answer-composition-'), 'composition.json');
  writeFileSync(path, JSON.stringify(contents));
  return path;
}

function baseArgs(compositionPath: string, project: string, state: string): string[] {
  return ['daemon', compositionPath, '--project', project, '--harness', 'codex', '--state-dir', state];
}

function scheduledUserComposition(options: {
  id: string;
  modality: string;
  extra?: Record<string, unknown>;
  atMs?: number;
}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: options.id,
    nodes: {
      ask: {
        kind: 'user',
        config: { modality: options.modality, prompt: 'Answer?', ...(options.extra ?? {}) },
      },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'finish {{input}}' } },
    },
    edges: [{ id: 'e1', from: 'ask', to: 'done' }],
    triggers: [
      {
        id: 'once',
        target: 'ask',
        schedule: {
          kind: 'at',
          at: new Date(options.atMs ?? Date.now() + 60 * 60 * 1000).toISOString(),
        },
      },
    ],
  };
}

interface SeededUserField {
  readonly definition: CompositionDefinition;
  readonly project: string;
  readonly state: string;
  readonly compositionPath: string;
  readonly store: HoneyStore;
  readonly paths: HoneyPaths;
  readonly field: PersistedField;
  readonly hovers: Readonly<Record<string, HoverSpec>>;
}

async function seedUserField(
  raw: Record<string, unknown>,
  triggerNodes: readonly string[],
): Promise<SeededUserField> {
  const project = tempDirectory('wax-daemon-answer-project-');
  const state = tempDirectory('wax-daemon-answer-state-');
  const compositionPath = compositionFile(raw);
  const definition = parseComposition(raw);
  const apiary = apiaryForProject(project);
  const store = HoneyStore.forComposition(state, apiary, definition.id);
  const runtime = new PheromoneRuntime(definition, {
    executeForager: {
      async execute() {
        return { kind: 'text', text: 'never' };
      },
    },
  });
  for (const node of triggerNodes) {
    runtime.trigger(node);
  }
  await runtime.pump();
  const field = runtime.exportField();
  store.save(field);

  const hovers: Record<string, HoverSpec> = {};
  for (const [id, node] of Object.entries(field.nodes)) {
    if (node.hover !== undefined) {
      hovers[id] = node.hover;
    }
  }

  return {
    definition,
    project,
    state,
    compositionPath,
    store,
    paths: store.paths,
    field,
    hovers,
  };
}

function answerRecord(
  seeded: SeededUserField,
  overrides: Partial<AnswerRecord> = {},
): AnswerRecord {
  return {
    answerId: createAnswerId(),
    compositionId: seeded.definition.id,
    nodeId: 'ask',
    hoverToken: seeded.hovers['ask']?.token ?? 'hv_missing',
    value: { kind: 'text', text: 'hello' },
    at: new Date().toISOString(),
    ...overrides,
  };
}

interface RunningDaemon {
  readonly running: Promise<number>;
  readonly controller: AbortController;
  readonly stdout: string[];
  readonly stderr: string[];
}

function startDaemon(
  args: readonly string[],
  adapter: FakeAdapter,
  deps: Record<string, unknown> = {},
): RunningDaemon {
  const captured = capture();
  const controller = new AbortController();
  const running = runDaemon(args, {
    ...captured.deps,
    createAdapter: async () => adapter,
    signal: controller.signal,
    ...deps,
  });
  return { running, controller, stdout: captured.stdout, stderr: captured.stderr };
}

async function stopDaemon(daemon: RunningDaemon): Promise<number> {
  daemon.controller.abort();
  return daemon.running;
}

function logEntries(path: string): Record<string, unknown>[] {
  try {
    return readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

function hasLogEvent(path: string, event: string, nodeId?: string): boolean {
  return logEntries(path).some(
    (entry) => entry['event'] === event && (nodeId === undefined || entry['nodeId'] === nodeId),
  );
}

function countLogEvent(path: string, event: string): number {
  return logEntries(path).filter((entry) => entry['event'] === event).length;
}

async function waitFor(
  condition: () => boolean,
  label: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (condition()) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

function savedRest(paths: HoneyPaths): boolean | undefined {
  try {
    return (JSON.parse(readFileSync(paths.field, 'utf8')) as { rest?: boolean }).rest;
  } catch {
    return undefined;
  }
}

function noPheromoneEnqueued(paths: HoneyPaths): boolean {
  return countLogEvent(paths.log, 'pheromone.enqueued') === 0;
}

test('daemon applies text, message, choice, boolean, image and file answers', async () => {
  const attachment = join(tempDirectory('wax-daemon-answer-attachment-'), 'photo.png');
  writeFileSync(attachment, 'fake-png');
  const report = join(tempDirectory('wax-daemon-answer-report-'), 'report.pdf');
  writeFileSync(report, 'fake-pdf');

  const cases: readonly {
    modality: string;
    extra?: Record<string, unknown>;
    value: Value;
    prompt: string;
    attachment?: { readonly kind: 'image' | 'file'; readonly path: string; readonly mime: string };
  }[] = [
    {
      modality: 'text',
      value: { kind: 'text', text: 'hello' },
      prompt: 'finish hello',
    },
    {
      modality: 'message',
      value: { kind: 'message', text: 'hello', attachments: [] },
      prompt: 'finish hello',
    },
    {
      modality: 'choice',
      extra: { choices: ['red', 'green'] },
      value: { kind: 'choice', choice: 'green' },
      prompt: 'finish green',
    },
    {
      modality: 'yes-no',
      value: { kind: 'boolean', value: true },
      prompt: 'finish true',
    },
    {
      modality: 'image',
      value: {
        kind: 'attachments',
        attachments: [{ kind: 'image', path: resolve(attachment) }],
      },
      prompt: 'finish ',
      attachment: { kind: 'image', path: resolve(attachment), mime: 'image/png' },
    },
    {
      modality: 'file',
      value: {
        kind: 'attachments',
        attachments: [{ kind: 'file', path: resolve(report) }],
      },
      prompt: 'finish ',
      attachment: { kind: 'file', path: resolve(report), mime: 'application/pdf' },
    },
  ];

  for (const [index, item] of cases.entries()) {
    const raw = scheduledUserComposition({
      id: `daemon-answer-${String(index)}-${item.modality}`,
      modality: item.modality,
      ...(item.extra === undefined ? {} : { extra: item.extra }),
    });
    const seeded = await seedUserField(raw, ['ask']);
    const record = answerRecord(seeded, { value: item.value });
    const answerPath = writeAnswerRecord(seeded.paths.answers, record);
    const adapter = new FakeAdapter({ output: 'DONE' });
    const daemon = startDaemon(baseArgs(seeded.compositionPath, seeded.project, seeded.state), adapter);

    let code = -1;
    try {
      await waitFor(() => adapter.prompts.length === 1, `${item.modality} downstream prompt`);
      await waitFor(
        () => hasLogEvent(seeded.paths.log, 'node.completed', 'done'),
        `${item.modality} completed log`,
      );
      await waitFor(() => !existsSync(answerPath), `${item.modality} answer file removal`);
      await waitFor(() => savedRest(seeded.paths) === true, `${item.modality} field rest`);
    } finally {
      code = await stopDaemon(daemon);
    }

    assert.equal(code, 0, `${item.modality}: ${daemon.stderr.join('\n')}`);
    assert.deepEqual(adapter.prompts, [item.prompt]);
    assert.ok(hasLogEvent(seeded.paths.log, 'answer.applied', 'ask'));
    assert.equal(countLogEvent(seeded.paths.log, 'answer.stale'), 0);
    assert.equal(countLogEvent(seeded.paths.log, 'answer.malformed'), 0);
    assert.deepEqual(listAnswerFiles(seeded.paths.answers), []);
    if (item.attachment !== undefined) {
      const attachments = adapter.submittedAttachments[0];
      assert.ok(attachments !== undefined);
      assert.deepEqual(attachments, [
        {
          kind: item.attachment.kind,
          path: item.attachment.path,
          mimeType: item.attachment.mime,
        },
      ]);
    }

    const serializedLog = readFileSync(seeded.paths.log, 'utf8');
    assert.equal(serializedLog.includes('hello'), false, 'the answer Value is not logged');
  }
});

test('a stale answer (no hover, wrong node, wrong token, wrong composition) is dropped', async () => {
  const cases: readonly {
    readonly label: string;
    readonly trigger: readonly string[];
    readonly record: (seeded: SeededUserField) => AnswerRecord;
    readonly outcome: string;
  }[] = [
    {
      label: 'no hover',
      trigger: [],
      record: (seeded) => answerRecord(seeded, { hoverToken: 'hv_none' }),
      outcome: 'no-hover',
    },
    {
      label: 'wrong node',
      trigger: ['ask'],
      record: (seeded) => answerRecord(seeded, { nodeId: 'ghost' }),
      outcome: 'node-mismatch',
    },
    {
      label: 'wrong token',
      trigger: ['ask'],
      record: (seeded) => answerRecord(seeded, { hoverToken: 'hv_wrong' }),
      outcome: 'token-mismatch',
    },
    {
      label: 'wrong composition',
      trigger: ['ask'],
      record: (seeded) => answerRecord(seeded, { compositionId: 'other-composition' }),
      outcome: 'composition-mismatch',
    },
  ];

  for (const [index, item] of cases.entries()) {
    const raw = scheduledUserComposition({
      id: `daemon-stale-${String(index)}`,
      modality: 'text',
    });
    const seeded = await seedUserField(raw, item.trigger);
    const record = item.record(seeded);
    const answerPath = writeAnswerRecord(seeded.paths.answers, record);
    const adapter = new FakeAdapter();
    const daemon = startDaemon(baseArgs(seeded.compositionPath, seeded.project, seeded.state), adapter);

    let code = -1;
    try {
      await waitFor(
        () => hasLogEvent(seeded.paths.log, 'answer.stale'),
        `${item.label} stale log`,
      );
      await waitFor(() => !existsSync(answerPath), `${item.label} answer removal`);
    } finally {
      code = await stopDaemon(daemon);
    }

    assert.equal(code, 0, `${item.label}: ${daemon.stderr.join('\n')}`);
    assert.deepEqual(adapter.prompts, [], `${item.label}: no downstream work`);
    assert.equal(noPheromoneEnqueued(seeded.paths), true, `${item.label}: no new Pheromone`);
    assert.equal(
      countLogEvent(seeded.paths.log, 'input.queued'),
      0,
      `${item.label}: no offline queue`,
    );
    const stale = logEntries(seeded.paths.log).find(
      (entry) => entry['event'] === 'answer.stale',
    );
    assert.ok(stale !== undefined);
    assert.equal(stale['outcome'], item.outcome);
    assert.equal(stale['answerId'], record.answerId);
    assert.equal(readFileSync(seeded.paths.log, 'utf8').includes('hello'), false);
    assert.deepEqual(listAnswerFiles(seeded.paths.answers), []);
  }
});

test('malformed answer files are logged, deleted and never create a Pheromone', async () => {
  const seeded = await seedUserField(
    scheduledUserComposition({ id: 'daemon-malformed', modality: 'text' }),
    [],
  );
  ensureAnswerInbox(seeded.paths.answers);
  const broken = join(seeded.paths.answers, 'broken.json');
  writeFileSync(broken, '{ not json');
  const incomplete = join(seeded.paths.answers, 'incomplete.json');
  writeFileSync(incomplete, JSON.stringify({ answerId: 'ans_incomplete' }));

  const adapter = new FakeAdapter();
  const daemon = startDaemon(baseArgs(seeded.compositionPath, seeded.project, seeded.state), adapter);

  let code = -1;
  try {
    await waitFor(
      () => countLogEvent(seeded.paths.log, 'answer.malformed') === 2,
      'both malformed answers',
    );
    await waitFor(
      () => !existsSync(broken) && !existsSync(incomplete),
      'malformed file removal',
    );
  } finally {
    code = await stopDaemon(daemon);
  }

  assert.equal(code, 0, daemon.stderr.join('\n'));
  assert.deepEqual(adapter.prompts, []);
  assert.equal(noPheromoneEnqueued(seeded.paths), true);
  assert.equal(countLogEvent(seeded.paths.log, 'input.queued'), 0);
  assert.deepEqual(listAnswerFiles(seeded.paths.answers), []);
});

test('a readable answer with a Value that does not match the modality is malformed', async () => {
  const seeded = await seedUserField(
    scheduledUserComposition({ id: 'daemon-bad-value', modality: 'message' }),
    ['ask'],
  );
  const record = answerRecord(seeded, { value: { kind: 'text', text: 'not-a-message' } });
  const answerPath = writeAnswerRecord(seeded.paths.answers, record);

  const adapter = new FakeAdapter();
  const daemon = startDaemon(baseArgs(seeded.compositionPath, seeded.project, seeded.state), adapter);

  let code = -1;
  try {
    await waitFor(
      () => hasLogEvent(seeded.paths.log, 'answer.malformed'),
      'the malformed value log',
    );
    await waitFor(() => !existsSync(answerPath), 'the malformed value file removal');
  } finally {
    code = await stopDaemon(daemon);
  }

  assert.equal(code, 0, daemon.stderr.join('\n'));
  assert.deepEqual(adapter.prompts, []);
  assert.equal(noPheromoneEnqueued(seeded.paths), true);
  // The hover was not consumed by the rejected answer.
  const field = JSON.parse(readFileSync(seeded.paths.field, 'utf8')) as {
    nodes: Record<string, { hover?: unknown }>;
  };
  assert.ok(field.nodes['ask']?.hover !== undefined);
});

test('a duplicate answer is stale instead of applying twice', async () => {
  const seeded = await seedUserField(
    scheduledUserComposition({ id: 'daemon-duplicate', modality: 'text' }),
    ['ask'],
  );
  const token = seeded.hovers['ask']?.token;
  assert.ok(token !== undefined);
  const first = answerRecord(seeded, {
    answerId: 'ans_first',
    hoverToken: token,
    value: { kind: 'text', text: 'first' },
  });
  const second = answerRecord(seeded, {
    answerId: 'ans_second',
    hoverToken: token,
    value: { kind: 'text', text: 'second' },
  });
  const firstPath = writeAnswerRecord(seeded.paths.answers, first);
  const secondPath = writeAnswerRecord(seeded.paths.answers, second);

  const adapter = new FakeAdapter({ output: 'ONE' });
  const daemon = startDaemon(baseArgs(seeded.compositionPath, seeded.project, seeded.state), adapter);

  let code = -1;
  try {
    await waitFor(() => adapter.prompts.length === 1, 'one downstream activation');
    await waitFor(
      () => hasLogEvent(seeded.paths.log, 'answer.stale'),
      'the duplicate stale log',
    );
    await waitFor(
      () => !existsSync(firstPath) && !existsSync(secondPath),
      'both duplicate files removed',
    );
    await waitFor(() => savedRest(seeded.paths) === true, 'field rest');
  } finally {
    code = await stopDaemon(daemon);
  }

  assert.equal(code, 0, daemon.stderr.join('\n'));
  assert.equal(adapter.prompts.length, 1);
  assert.equal(countLogEvent(seeded.paths.log, 'answer.applied'), 1);
  assert.equal(countLogEvent(seeded.paths.log, 'input.queued'), 0);
  const stale = logEntries(seeded.paths.log).find(
    (entry) => entry['event'] === 'answer.stale',
  );
  assert.ok(stale !== undefined);
  assert.equal(stale['outcome'], 'no-hover');
});

test('with two open hovers the answer for the selected token applies only to that node', async () => {
  const raw = {
    schemaVersion: 1,
    id: 'daemon-two-hovers',
    nodes: {
      first: { kind: 'user', config: { modality: 'text', prompt: 'First?' } },
      second: { kind: 'user', config: { modality: 'text', prompt: 'Second?' } },
      'done-first': {
        kind: 'forager',
        config: { connection: 'codex', prompt: 'FIRST:{{input}}' },
      },
      'done-second': {
        kind: 'forager',
        config: { connection: 'codex', prompt: 'SECOND:{{input}}' },
      },
    },
    edges: [
      { id: 'e1', from: 'first', to: 'done-first' },
      { id: 'e2', from: 'second', to: 'done-second' },
    ],
    triggers: [
      {
        id: 'later',
        target: 'first',
        schedule: { kind: 'at', at: new Date(Date.now() + 60 * 60 * 1000).toISOString() },
      },
    ],
  };
  const seeded = await seedUserField(raw, ['first', 'second']);
  const token = seeded.hovers['second']?.token;
  assert.ok(token !== undefined);
  const record = answerRecord(seeded, {
    nodeId: 'second',
    hoverToken: token,
    value: { kind: 'text', text: 'hello' },
  });
  const answerPath = writeAnswerRecord(seeded.paths.answers, record);

  const adapter = new FakeAdapter({ output: 'DONE' });
  const daemon = startDaemon(baseArgs(seeded.compositionPath, seeded.project, seeded.state), adapter);

  let code = -1;
  try {
    await waitFor(() => adapter.prompts.length === 1, 'the selected hover answer');
    await waitFor(() => !existsSync(answerPath), 'the answer file removal');
  } finally {
    code = await stopDaemon(daemon);
  }

  assert.equal(code, 0, daemon.stderr.join('\n'));
  assert.deepEqual(adapter.prompts, ['SECOND:hello']);
  assert.ok(hasLogEvent(seeded.paths.log, 'answer.applied', 'second'));
  const field = JSON.parse(readFileSync(seeded.paths.field, 'utf8')) as {
    rest: boolean;
    nodes: Record<string, { hover?: { nodeId: string } }>;
  };
  assert.equal(field.rest, false, 'the first hover is still open');
  assert.equal(field.nodes['first']?.hover?.nodeId, 'first');
  assert.equal(field.nodes['second']?.hover, undefined);
});

test('a scheduled user trigger opens a hover and wax answer completes the graph', async () => {
  const raw = scheduledUserComposition({
    id: 'daemon-scheduled-user',
    modality: 'text',
    atMs: Date.now() - 60_000,
  });
  const project = tempDirectory('wax-daemon-answer-project-');
  const state = tempDirectory('wax-daemon-answer-state-');
  const compositionPath = compositionFile(raw);
  const definition = parseComposition(raw);
  const paths = honeyPaths(state, apiaryForProject(project), definition.id);
  const adapter = new FakeAdapter({ output: 'SCHEDULED-DONE' });
  const daemon = startDaemon(baseArgs(compositionPath, project, state), adapter);

  let code = -1;
  try {
    await waitFor(
      () => hasLogEvent(paths.log, 'hover.opened', 'ask'),
      'the scheduled user hover',
    );
    assert.equal(existsSync(paths.answers), true, 'the daemon creates the answer inbox');

    const stdout: string[] = [];
    const stderr: string[] = [];
    const answerCode = await runCli(
      [
        'answer',
        compositionPath,
        '--project',
        project,
        '--node',
        'ask',
        '--state-dir',
        state,
        '--text',
        'hello',
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );
    assert.equal(answerCode, 0, stderr.join('\n'));
    assert.ok(stdout.some((line) => line.startsWith('answer queued ')));

    await waitFor(() => adapter.prompts.length === 1, 'the answered graph continuation');
    await waitFor(
      () => hasLogEvent(paths.log, 'node.completed', 'done'),
      'the downstream completion',
    );
    await waitFor(() => savedRest(paths) === true, 'field rest');
  } finally {
    code = await stopDaemon(daemon);
  }

  assert.equal(code, 0, daemon.stderr.join('\n'));
  assert.deepEqual(adapter.prompts, ['finish hello']);
  assert.ok(hasLogEvent(paths.log, 'answer.applied', 'ask'));
  assert.deepEqual(listAnswerFiles(paths.answers), []);
});

test('an unprocessed answer applies after a restore, and a stale one drops', async () => {
  // The first half mirrors a daemon crash: the field already holds the hover and
  // the answer file was written but never processed.
  const applying = await seedUserField(
    scheduledUserComposition({ id: 'daemon-restart-apply', modality: 'text' }),
    ['ask'],
  );
  const applyingRecord = answerRecord(applying, { value: { kind: 'text', text: 'after-restart' } });
  const applyingPath = writeAnswerRecord(applying.paths.answers, applyingRecord);

  const applyAdapter = new FakeAdapter({ output: 'APPLIED' });
  const applyDaemon = startDaemon(
    baseArgs(applying.compositionPath, applying.project, applying.state),
    applyAdapter,
  );
  let applyCode = -1;
  try {
    await waitFor(() => applyAdapter.prompts.length === 1, 'the restored answer prompt');
    await waitFor(() => !existsSync(applyingPath), 'the restored answer removal');
  } finally {
    applyCode = await stopDaemon(applyDaemon);
  }
  assert.equal(applyCode, 0, applyDaemon.stderr.join('\n'));
  assert.deepEqual(applyAdapter.prompts, ['finish after-restart']);

  // The field has no hover, so the leftover answer has nothing to match.
  const staleSeed = await seedUserField(
    scheduledUserComposition({ id: 'daemon-restart-stale', modality: 'text' }),
    [],
  );
  const staleRecord = answerRecord(staleSeed, { hoverToken: 'hv_before-restart' });
  const stalePath = writeAnswerRecord(staleSeed.paths.answers, staleRecord);

  const staleAdapter = new FakeAdapter();
  const staleDaemon = startDaemon(
    baseArgs(staleSeed.compositionPath, staleSeed.project, staleSeed.state),
    staleAdapter,
  );
  let staleCode = -1;
  try {
    await waitFor(
      () => hasLogEvent(staleSeed.paths.log, 'answer.stale'),
      'the stale answer after restore',
    );
    await waitFor(() => !existsSync(stalePath), 'the stale answer removal');
  } finally {
    staleCode = await stopDaemon(staleDaemon);
  }
  assert.equal(staleCode, 0, staleDaemon.stderr.join('\n'));
  assert.deepEqual(staleAdapter.prompts, []);
  assert.equal(noPheromoneEnqueued(staleSeed.paths), true);
});

