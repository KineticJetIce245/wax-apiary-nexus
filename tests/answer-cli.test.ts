import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import test from 'node:test';

import {
  listAnswerFiles,
  readAnswerRecord,
  type AnswerRecord,
} from '../src/input/answer-inbox.js';
import { parseAnswerArgs, runAnswerCli } from '../src/cli/answer-cli.js';
import { apiaryForProject } from '../src/cli/cli-shared.js';
import { parseUserAnswer, runCli } from '../src/cli/cli.js';
import { HoneyStore } from '../src/storage/honey.js';
import {
  parseComposition,
  PheromoneRuntime,
  type HoverSpec,
  type Value,
} from '../src/runtime/index.js';

function tempDirectory(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function compositionFile(contents: unknown): string {
  const path = join(tempDirectory('wax-answer-composition-'), 'composition.json');
  writeFileSync(path, JSON.stringify(contents));
  return path;
}

function oneUserComposition(options: {
  id: string;
  modality: string;
  extra?: Record<string, unknown>;
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
  };
}

interface SeededAnswer {
  readonly compositionPath: string;
  readonly project: string;
  readonly state: string;
  readonly fieldText: string;
  readonly hovers: Readonly<Record<string, HoverSpec>>;
  readonly store: HoneyStore;
}

async function seedOpenHovers(
  raw: Record<string, unknown>,
  options: { trigger?: readonly string[]; apiary?: string } = {},
): Promise<SeededAnswer> {
  const project = tempDirectory('wax-answer-project-');
  const state = tempDirectory('wax-answer-state-');
  const compositionPath = compositionFile(raw);
  const definition = parseComposition(raw);
  const apiary = options.apiary ?? apiaryForProject(project);
  const store = HoneyStore.forComposition(state, apiary, definition.id);
  const runtime = new PheromoneRuntime(definition, {
    executeForager: {
      async execute() {
        return { kind: 'text', text: 'never' };
      },
    },
  });
  for (const node of options.trigger ?? ['ask']) {
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
    compositionPath,
    project,
    state,
    fieldText: readFileSync(store.paths.field, 'utf8'),
    hovers,
    store,
  };
}

function answerArgs(
  seeded: Pick<SeededAnswer, 'compositionPath' | 'project' | 'state'>,
  node: string,
  source: readonly string[],
  extra: readonly string[] = [],
): string[] {
  return [
    'answer',
    seeded.compositionPath,
    '--project',
    seeded.project,
    '--node',
    node,
    '--state-dir',
    seeded.state,
    ...source,
    ...extra,
  ];
}

async function invoke(
  args: readonly string[],
): Promise<{ code: number; stdout: string[]; stderr: string[] }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCli(args, {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });
  return { code, stdout, stderr };
}

function onlyAnswer(seeded: SeededAnswer): AnswerRecord {
  const files = listAnswerFiles(seeded.store.paths.answers);
  assert.equal(files.length, 1, 'exactly one answer file was queued');
  return readAnswerRecord(files[0] as string);
}

test('parses wax answer arguments and defaults the state directory', () => {
  const parsed = parseAnswerArgs([
    'answer',
    'composition.json',
    '--project',
    'C:/work',
    '--node',
    'ask',
    '--text',
    'hello',
  ]);

  assert.equal(parsed.compositionPath, 'composition.json');
  assert.equal(parsed.projectDirectory, 'C:/work');
  assert.equal(parsed.nodeId, 'ask');
  assert.equal(parsed.stateDir, '~/.wax');
  assert.equal(parsed.apiary, undefined);
  assert.equal(parsed.token, undefined);
  assert.deepEqual(parsed.source, { kind: 'text', text: 'hello' });
});

test('queues text, message, choice, boolean, image and file answers', async () => {
  const attachment = join(tempDirectory('wax-answer-attachment-'), 'photo.png');
  writeFileSync(attachment, 'fake-png');

  const cases: readonly {
    modality: string;
    extra?: Record<string, unknown>;
    source: readonly string[];
    expected: Value;
  }[] = [
    {
      modality: 'text',
      source: ['--text', 'hello'],
      expected: { kind: 'text', text: 'hello' },
    },
    {
      modality: 'message',
      source: ['--text', 'hello'],
      expected: { kind: 'message', text: 'hello', attachments: [] },
    },
    {
      modality: 'choice',
      extra: { choices: ['red', 'green'] },
      source: ['--choice', 'green'],
      expected: { kind: 'choice', choice: 'green' },
    },
    {
      modality: 'yes-no',
      source: ['--yes'],
      expected: { kind: 'boolean', value: true },
    },
    {
      modality: 'yes-no',
      source: ['--no'],
      expected: { kind: 'boolean', value: false },
    },
    {
      modality: 'image',
      source: ['--image', attachment],
      expected: {
        kind: 'attachments',
        attachments: [{ kind: 'image', path: resolve(attachment) }],
      },
    },
    {
      modality: 'file',
      source: ['--file', attachment],
      expected: {
        kind: 'attachments',
        attachments: [{ kind: 'file', path: resolve(attachment) }],
      },
    },
  ];

  for (const [index, item] of cases.entries()) {
    const raw = oneUserComposition({
      id: `answer-${String(index)}-${item.modality}`,
      modality: item.modality,
      ...(item.extra === undefined ? {} : { extra: item.extra }),
    });
    const seeded = await seedOpenHovers(raw);
    const result = await invoke(answerArgs(seeded, 'ask', item.source));

    assert.equal(result.code, 0, `${item.modality}: ${result.stderr.join('\n')}`);
    assert.equal(result.stderr.length, 0);
    assert.ok(result.stdout.some((line) => line.startsWith('answer queued ')));

    const answer = onlyAnswer(seeded);
    assert.equal(answer.compositionId, raw['id']);
    assert.equal(answer.nodeId, 'ask');
    assert.equal(answer.hoverToken, seeded.hovers['ask']?.token);
    assert.match(answer.answerId, /^ans_/);
    assert.ok(Number.isFinite(Date.parse(answer.at)));
    assert.deepEqual(answer.value, item.expected);
    if (item.modality === 'image' || item.modality === 'file') {
      assert.equal(answer.value.kind, 'attachments');
      if (answer.value.kind === 'attachments') {
        const saved = answer.value.attachments[0];
        assert.ok(saved?.path !== undefined && isAbsolute(saved.path));
        assert.equal(saved.path, resolve(attachment));
      }
    }

    // Single writer: wax answer reads the field but never rewrites it.
    assert.equal(readFileSync(seeded.store.paths.field, 'utf8'), seeded.fieldText);
  }
});

test('a choice answer reuses the interactive label/index parsing', () => {
  const raw = oneUserComposition({
    id: 'answer-choice-index',
    modality: 'choice',
    extra: { choices: ['red', 'green'] },
  });
  // The CLI itself needs an async seed, so this test only checks the shared
  // parser directly; the queue path for a label is covered above.
  const node = parseComposition(raw).nodes.get('ask');
  assert.ok(node !== undefined && node.kind === 'user');
  assert.deepEqual(parseUserAnswer(node, '2'), { kind: 'choice', choice: 'green' });
});

test('multiple open hovers require a token, and the matching hover is queued', async () => {
  const raw = {
    schemaVersion: 1,
    id: 'answer-two-hovers',
    nodes: {
      first: { kind: 'user', config: { modality: 'text', prompt: 'First?' } },
      second: { kind: 'user', config: { modality: 'text', prompt: 'Second?' } },
    },
    edges: [],
  };
  const seeded = await seedOpenHovers(raw, { trigger: ['first', 'second'] });
  const token = seeded.hovers['second']?.token;
  assert.ok(token !== undefined);

  const withoutToken = await invoke(answerArgs(seeded, 'second', ['--text', 'hello']));
  assert.equal(withoutToken.code, 2);
  assert.match(withoutToken.stderr.join('\n'), /multiple open user hovers/);
  assert.deepEqual(listAnswerFiles(seeded.store.paths.answers), []);

  const forWrongNode = await invoke(
    answerArgs(seeded, 'first', ['--text', 'hello'], ['--token', token]),
  );
  assert.equal(forWrongNode.code, 2);
  assert.match(forWrongNode.stderr.join('\n'), /belongs to node 'second'/);

  const withToken = await invoke(
    answerArgs(seeded, 'second', ['--text', 'hello'], ['--token', token]),
  );
  assert.equal(withToken.code, 0, withToken.stderr.join('\n'));
  const answer = onlyAnswer(seeded);
  assert.equal(answer.nodeId, 'second');
  assert.equal(answer.hoverToken, token);
});

test('rejects an unknown token and a node that is not a user node', async () => {
  const seeded = await seedOpenHovers(
    oneUserComposition({ id: 'answer-token', modality: 'text' }),
  );

  const wrongToken = await invoke(
    answerArgs(seeded, 'ask', ['--text', 'hello'], ['--token', 'hv_missing']),
  );
  assert.equal(wrongToken.code, 2);
  assert.match(wrongToken.stderr.join('\n'), /no open user hover with token/);

  const notUser = await invoke(answerArgs(seeded, 'done', ['--text', 'hello']));
  assert.equal(notUser.code, 2);
  assert.match(notUser.stderr.join('\n'), /not a user node/);
  assert.deepEqual(listAnswerFiles(seeded.store.paths.answers), []);
});

test('a missing field or a field with no hover is a usage error', async () => {
  const raw = oneUserComposition({ id: 'answer-no-hover', modality: 'text' });
  const project = tempDirectory('wax-answer-project-');
  const state = tempDirectory('wax-answer-state-');
  const compositionPath = compositionFile(raw);

  const missing = await invoke([
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
  ]);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr.join('\n'), /no Honey field/);

  const definition = parseComposition(raw);
  const store = HoneyStore.forComposition(state, apiaryForProject(project), definition.id);
  store.save(new PheromoneRuntime(definition, {
    executeForager: {
      async execute() {
        return { kind: 'text', text: 'never' };
      },
    },
  }).exportField());

  const noHover = await invoke([
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
  ]);
  assert.equal(noHover.code, 2);
  assert.match(noHover.stderr.join('\n'), /no open user hover/);
  assert.deepEqual(listAnswerFiles(store.paths.answers), []);
});

test('refuses a field written for another graph revision', async () => {
  const raw = oneUserComposition({ id: 'answer-revision', modality: 'text' });
  const seeded = await seedOpenHovers(raw);
  const changed = {
    ...raw,
    nodes: {
      ...(raw['nodes'] as Record<string, unknown>),
      ask: { kind: 'user', config: { modality: 'text', prompt: 'Changed?' } },
    },
  };
  writeFileSync(seeded.compositionPath, JSON.stringify(changed));

  const result = await invoke(answerArgs(seeded, 'ask', ['--text', 'hello']));
  assert.equal(result.code, 2);
  assert.match(result.stderr.join('\n'), /graph revision/);
  assert.deepEqual(listAnswerFiles(seeded.store.paths.answers), []);
});

test('an explicit apiary selects the same Honey location the daemon uses', async () => {
  const raw = oneUserComposition({ id: 'answer-apiary', modality: 'text' });
  const seeded = await seedOpenHovers(raw, { apiary: 'demo' });

  const result = await invoke(
    answerArgs(seeded, 'ask', ['--text', 'hello'], ['--apiary', 'demo']),
  );
  assert.equal(result.code, 0, result.stderr.join('\n'));
  assert.equal(onlyAnswer(seeded).nodeId, 'ask');
});

test('rejects answer sources that do not match the user modality', async () => {
  const text = await seedOpenHovers(oneUserComposition({ id: 'answer-mismatch-text', modality: 'text' }));
  const yesOnText = await invoke(answerArgs(text, 'ask', ['--yes']));
  assert.equal(yesOnText.code, 2);
  assert.match(yesOnText.stderr.join('\n'), /--yes does not match/);

  const yesNo = await seedOpenHovers(
    oneUserComposition({ id: 'answer-mismatch-yesno', modality: 'yes-no' }),
  );
  const textOnYesNo = await invoke(answerArgs(yesNo, 'ask', ['--text', 'hello']));
  assert.equal(textOnYesNo.code, 2);
  assert.match(textOnYesNo.stderr.join('\n'), /--text does not match/);

  const message = await seedOpenHovers(
    oneUserComposition({ id: 'answer-empty-message', modality: 'message' }),
  );
  const emptyMessage = await invoke(answerArgs(message, 'ask', ['--text', '   ']));
  assert.equal(emptyMessage.code, 2);
  assert.match(emptyMessage.stderr.join('\n'), /non-empty message/);

  const choice = await seedOpenHovers(
    oneUserComposition({
      id: 'answer-bad-choice',
      modality: 'choice',
      extra: { choices: ['red', 'green'] },
    }),
  );
  const badChoice = await invoke(answerArgs(choice, 'ask', ['--choice', 'blue']));
  assert.equal(badChoice.code, 2);
  assert.match(badChoice.stderr.join('\n'), /expected one of/);
});

test('rejects missing or non-regular attachment paths without queueing a file', async () => {
  const seeded = await seedOpenHovers(
    oneUserComposition({ id: 'answer-attachment', modality: 'image' }),
  );
  const missing = await invoke(
    answerArgs(seeded, 'ask', ['--image', join(tempDirectory('wax-missing-'), 'nope.png')]),
  );
  assert.equal(missing.code, 2);
  assert.match(missing.stderr.join('\n'), /does not exist/);

  const directory = tempDirectory('wax-answer-directory-');
  const notFile = await invoke(answerArgs(seeded, 'ask', ['--image', directory]));
  assert.equal(notFile.code, 2);
  assert.match(notFile.stderr.join('\n'), /not a regular file/);
  assert.deepEqual(listAnswerFiles(seeded.store.paths.answers), []);
});

test('rejects invalid argument combinations', async () => {
  const seeded = await seedOpenHovers(
    oneUserComposition({ id: 'answer-args', modality: 'text' }),
  );

  const noSource = await invoke([
    'answer',
    seeded.compositionPath,
    '--project',
    seeded.project,
    '--node',
    'ask',
    '--state-dir',
    seeded.state,
  ]);
  assert.equal(noSource.code, 2);
  assert.match(noSource.stderr.join('\n'), /exactly one answer source/);

  const twoSources = await invoke(
    answerArgs(seeded, 'ask', ['--text', 'a', '--choice', 'b']),
  );
  assert.equal(twoSources.code, 2);
  assert.match(twoSources.stderr.join('\n'), /exactly one answer source/);

  const unknown = await invoke(answerArgs(seeded, 'ask', ['--bogus']));
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr.join('\n'), /unknown option/);

  const duplicate = await invoke(
    answerArgs(seeded, 'ask', ['--text', 'a', '--text', 'b']),
  );
  assert.equal(duplicate.code, 2);
  assert.match(duplicate.stderr.join('\n'), /more than once/);

  const missingProject = await runAnswerCli(
    ['answer', seeded.compositionPath, '--node', 'ask', '--text', 'a'],
    { stdout: () => undefined, stderr: () => undefined },
  );
  assert.equal(missingProject, 2);
});
