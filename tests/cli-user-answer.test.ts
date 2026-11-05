import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import test from 'node:test';

import { parseUserAnswer, runCli, type CliDependencies } from '../src/cli.js';
import type { AttachmentDraft } from '../src/content.js';
import { parseComposition, type UserNode, type Value } from '../src/runtime/index.js';
import { FakeAdapter } from './support/fake-adapter.js';

function userNode(modality: string, extra: Record<string, unknown> = {}): UserNode {
  const parsed = parseComposition({
    schemaVersion: 1,
    id: 'cli-answer',
    nodes: {
      ask: { kind: 'user', config: { modality, prompt: 'Answer?', ...extra } },
    },
    edges: [],
  });
  const node = parsed.nodes.get('ask');
  assert.ok(node !== undefined && node.kind === 'user');
  return node;
}

function tempFile(name: string, contents = 'x'): string {
  const directory = mkdtempSync(join(tmpdir(), 'wax-cli-answer-'));
  const path = join(directory, name);
  writeFileSync(path, contents);
  return path;
}

function composition(modality: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: `cli-${modality}`,
    nodes: {
      ask: { kind: 'user', config: { modality, prompt: 'Answer?' } },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'finish {{input}}' } },
    },
    edges: [{ id: 'e1', from: 'ask', to: 'done' }],
  };
}

function compositionFile(contents: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), 'wax-cli-answer-composition-'));
  const path = join(directory, 'composition.json');
  writeFileSync(path, JSON.stringify(contents));
  return path;
}

function runArgs(compositionPath: string): string[] {
  return [
    'run',
    compositionPath,
    '--project',
    mkdtempSync(join(tmpdir(), 'wax-cli-answer-project-')),
    '--harness',
    'codex',
    '--state-dir',
    mkdtempSync(join(tmpdir(), 'wax-cli-answer-state-')),
    '--trigger',
    'ask',
  ];
}

test('a message answer becomes a text-only message Value', () => {
  assert.deepEqual(parseUserAnswer(userNode('message'), 'hello world'), {
    kind: 'message',
    text: 'hello world',
    attachments: [],
  });
  assert.throws(
    () => parseUserAnswer(userNode('message'), '   '),
    /needs a non-empty message/,
  );
});

test('an image answer resolves one existing file to an absolute path', () => {
  const file = tempFile('photo.png');
  const value = parseUserAnswer(userNode('image'), relative(process.cwd(), file));

  assert.equal(value.kind, 'attachments');
  if (value.kind !== 'attachments') {
    return;
  }
  const attachment = value.attachments[0];
  assert.ok(attachment !== undefined);
  assert.equal(attachment.kind, 'image');
  assert.equal(attachment.path, resolve(file));
  assert.equal(isAbsolute(attachment.path ?? ''), true);
  assert.equal(attachment.mediaType, undefined, 'mediaType is not inferred in Stage 3C-2');
});

test('a file answer resolves one existing file to an absolute path', () => {
  const file = tempFile('report.bin');
  const value = parseUserAnswer(userNode('file'), file);

  assert.deepEqual(value, {
    kind: 'attachments',
    attachments: [{ kind: 'file', path: resolve(file) }],
  });
});

test('a leading ~ expands to the home directory', () => {
  const name = `.wax-3c2-missing-${String(process.pid)}-${String(Date.now())}`;
  const expected = resolve(join(homedir(), name));

  assert.throws(
    () => parseUserAnswer(userNode('image'), `~/${name}`),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /does not exist/);
      assert.ok(
        error.message.includes(expected),
        `expected the expanded path '${expected}' in '${error.message}'`,
      );
      return true;
    },
  );
});

test('rejects missing, empty and non-regular attachment paths', () => {
  const directory = mkdtempSync(join(tmpdir(), 'wax-cli-answer-directory-'));

  assert.throws(
    () => parseUserAnswer(userNode('file'), join(directory, 'missing.pdf')),
    /does not exist/,
  );
  assert.throws(
    () => parseUserAnswer(userNode('image'), directory),
    /not a regular file/,
  );
  assert.throws(
    () => parseUserAnswer(userNode('image'), '   '),
    /expects a local image path/,
  );
});

test('injected answer handlers accept message, image and file values', async () => {
  const cases: readonly {
    modality: string;
    value: Value;
    prompt: string;
    attachments: readonly AttachmentDraft[];
  }[] = [
    {
      modality: 'message',
      value: { kind: 'message', text: 'hello', attachments: [] },
      prompt: 'finish hello',
      attachments: [],
    },
    {
      modality: 'image',
      value: {
        kind: 'attachments',
        attachments: [{ kind: 'image', path: '/injected/photo.png' }],
      },
      prompt: 'finish ',
      attachments: [
        { kind: 'image', path: '/injected/photo.png', mimeType: 'image/png' },
      ],
    },
    {
      modality: 'file',
      value: {
        kind: 'attachments',
        attachments: [{ kind: 'file', path: '/injected/report.pdf' }],
      },
      prompt: 'finish ',
      attachments: [
        { kind: 'file', path: '/injected/report.pdf', mimeType: 'application/pdf' },
      ],
    },
  ];

  for (const item of cases) {
    const adapter = new FakeAdapter({ output: 'OK' });
    const stdout: string[] = [];
    const stderr: string[] = [];
    const seen: string[] = [];
    const deps: CliDependencies = {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      createAdapter: async () => adapter,
      askUser: async (node) => {
        seen.push(node.config.modality);
        return item.value;
      },
    };

    const code = await runCli(
      runArgs(compositionFile(composition(item.modality))),
      deps,
    );

    assert.equal(code, 0, `${item.modality}: ${stderr.join('\n')}`);
    assert.deepEqual(seen, [item.modality]);
    assert.deepEqual(adapter.prompts, [item.prompt]);
    assert.deepEqual(adapter.submittedAttachments, [item.attachments]);
    assert.ok(stdout.includes('rest         true'));
  }
});

test('a non-interactive stdin still refuses an image answer', async () => {
  const adapter = new FakeAdapter();
  const stderr: string[] = [];
  const deps: CliDependencies = {
    stdout: () => undefined,
    stderr: (line) => stderr.push(line),
    createAdapter: async () => adapter,
  };

  const code = await runCli(
    runArgs(compositionFile(composition('image'))),
    deps,
  );

  assert.equal(code, 1);
  assert.match(stderr.join('\n'), /stdin is not interactive/);
  assert.deepEqual(adapter.prompts, [], 'the downstream forager never ran');
});
