import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseComposition,
  PheromoneRuntime,
  type NodeExecutor,
  type Value,
} from '../src/runtime/index.js';

const START = Date.parse('2026-02-01T00:00:00.000Z');

function answerComposition(
  modality: Record<string, unknown>,
): ReturnType<typeof parseComposition> {
  return parseComposition({
    schemaVersion: 1,
    id: 'answers',
    nodes: {
      ask: { kind: 'user', config: { prompt: 'Answer?', ...modality } },
      done: { kind: 'forager', config: { connection: 'codex', prompt: 'finish {{input}}' } },
    },
    edges: [{ id: 'e1', from: 'ask', to: 'done' }],
  });
}

interface Harness {
  readonly runtime: PheromoneRuntime;
  readonly calls: Value[];
}

function runtimeFor(modality: Record<string, unknown>): Harness {
  const calls: Value[] = [];
  const executor: NodeExecutor = {
    async execute(_node, input) {
      calls.push(input);
      return { kind: 'text', text: 'ok' };
    },
  };
  return {
    runtime: new PheromoneRuntime(answerComposition(modality), {
      executeForager: executor,
      now: () => START,
    }),
    calls,
  };
}

async function openAsk(runtime: PheromoneRuntime): Promise<void> {
  runtime.trigger('ask');
  await runtime.pump();
  assert.ok(runtime.snapshot().nodes['ask']?.hover !== undefined);
}

test('accepts a message answer and forwards the exact Value', async () => {
  const { runtime, calls } = runtimeFor({ modality: 'message' });
  await openAsk(runtime);

  const answer: Value = { kind: 'message', text: 'hello', attachments: [] };
  runtime.answerHover('ask', answer);
  await runtime.pump();

  assert.deepEqual(calls, [answer]);
  assert.equal(runtime.snapshot().rest, true);
});

test('accepts an image attachment path without touching the filesystem', async () => {
  const { runtime, calls } = runtimeFor({ modality: 'image' });
  await openAsk(runtime);

  // The path deliberately does not exist: the runtime validates shape only.
  const answer: Value = {
    kind: 'attachments',
    attachments: [{ kind: 'image', path: '/wax-3c2-missing/photo.png', mediaType: 'image/png' }],
  };
  runtime.answerHover('ask', answer);
  await runtime.pump();

  assert.deepEqual(calls, [answer]);
  assert.equal(runtime.snapshot().rest, true);
});

test('accepts a file attachment path', async () => {
  const { runtime, calls } = runtimeFor({ modality: 'file' });
  await openAsk(runtime);

  const answer: Value = {
    kind: 'attachments',
    attachments: [{ kind: 'file', path: '/wax-3c2-missing/report.pdf' }],
  };
  runtime.answerHover('ask', answer);
  await runtime.pump();

  assert.deepEqual(calls, [answer]);
  assert.equal(runtime.snapshot().rest, true);
});

test('rejects a value whose kind does not match the user modality', async () => {
  const message = runtimeFor({ modality: 'message' });
  await openAsk(message.runtime);
  assert.throws(
    () => message.runtime.answerHover('ask', { kind: 'text', text: 'no' }),
    /expects a message value, got 'text'/,
  );

  const image = runtimeFor({ modality: 'image' });
  await openAsk(image.runtime);
  assert.throws(
    () => image.runtime.answerHover('ask', { kind: 'message', text: 'no', attachments: [] }),
    /expects an attachments value, got 'message'/,
  );

  const file = runtimeFor({ modality: 'file' });
  await openAsk(file.runtime);
  assert.throws(
    () => file.runtime.answerHover('ask', { kind: 'choice', choice: 'no' }),
    /expects an attachments value, got 'choice'/,
  );
});

test('rejects empty and multi-entry attachment answers', async () => {
  for (const modality of ['image', 'file'] as const) {
    const { runtime } = runtimeFor({ modality });
    await openAsk(runtime);

    assert.throws(
      () => runtime.answerHover('ask', { kind: 'attachments', attachments: [] }),
      /expects exactly one/,
    );
    assert.throws(
      () =>
        runtime.answerHover('ask', {
          kind: 'attachments',
          attachments: [
            { kind: modality, path: '/one' },
            { kind: modality, path: '/two' },
          ],
        }),
      /expects exactly one/,
    );
  }
});

test('rejects an attachment whose kind does not match the modality', async () => {
  const image = runtimeFor({ modality: 'image' });
  await openAsk(image.runtime);
  assert.throws(
    () =>
      image.runtime.answerHover('ask', {
        kind: 'attachments',
        attachments: [{ kind: 'file', path: '/report.pdf' }],
      }),
    /expects an image attachment, got 'file'/,
  );

  const file = runtimeFor({ modality: 'file' });
  await openAsk(file.runtime);
  assert.throws(
    () =>
      file.runtime.answerHover('ask', {
        kind: 'attachments',
        attachments: [{ kind: 'image', path: '/photo.png' }],
      }),
    /expects a file attachment, got 'image'/,
  );
});

test('rejects a message without text or with attachments', async () => {
  const { runtime } = runtimeFor({ modality: 'message' });
  await openAsk(runtime);

  assert.throws(
    () => runtime.answerHover('ask', { kind: 'message', attachments: [] }),
    /must carry text/,
  );
  assert.throws(
    () =>
      runtime.answerHover('ask', {
        kind: 'message',
        text: 'hello',
        attachments: [{ kind: 'file', path: '/report.pdf' }],
      }),
    /empty attachments array/,
  );
});

test('rejects an attachment without a usable path or mediaType', async () => {
  const { runtime } = runtimeFor({ modality: 'image' });
  await openAsk(runtime);

  assert.throws(
    () =>
      runtime.answerHover('ask', {
        kind: 'attachments',
        attachments: [{ kind: 'image', path: '   ' }],
      }),
    /non-empty path/,
  );
  assert.throws(
    () =>
      runtime.answerHover('ask', {
        kind: 'attachments',
        attachments: [
          { kind: 'image', path: '/photo.png', mediaType: 5 as unknown as string },
        ],
      }),
    /mediaType must be a string/,
  );
});
