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
      done: {
        kind: 'forager',
        config: { connection: 'codex', prompt: 'finish' },
        reads: [],
      },
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
      return { message: 'ok' };
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
  await runtime.admit('ask', { message: '' });
  await runtime.settle();
  assert.ok(runtime.snapshot().nodes['ask']?.hover !== undefined);
}

test('accepts a message answer and forwards the exact Value', async () => {
  const { runtime, calls } = runtimeFor({ modality: 'message' });
  await openAsk(runtime);

  const answer: Value = { message: 'hello', attachments: [] };
  runtime.answerHover('ask', answer);
  await runtime.settle();

  assert.deepEqual(calls, [answer]);
  assert.equal(runtime.snapshot().rest, true);
});

test('accepts an image attachment path without touching the filesystem', async () => {
  const { runtime, calls } = runtimeFor({ modality: 'image' });
  await openAsk(runtime);

  // The path deliberately does not exist: the runtime validates shape only.
  const answer: Value = { attachments: [{ path: '/wax-3c2-missing/photo.png', mediaType: 'image/png' }] };
  runtime.answerHover('ask', answer);
  await runtime.settle();

  assert.deepEqual(calls, [answer]);
  assert.equal(runtime.snapshot().rest, true);
});

test('accepts a file attachment path', async () => {
  const { runtime, calls } = runtimeFor({ modality: 'file' });
  await openAsk(runtime);

  const answer: Value = { attachments: [{ path: '/wax-3c2-missing/report.pdf' }] };
  runtime.answerHover('ask', answer);
  await runtime.settle();

  assert.deepEqual(calls, [answer]);
  assert.equal(runtime.snapshot().rest, true);
});

test('rejects an answer whose Value fields do not match the user modality', async () => {
  const text = runtimeFor({ modality: 'text' });
  await openAsk(text.runtime);
  assert.throws(
    () => text.runtime.answerHover('ask', { choice: 'no' }),
    /expects a string field 'message'/,
  );

  const image = runtimeFor({ modality: 'image' });
  await openAsk(image.runtime);
  assert.throws(
    () => image.runtime.answerHover('ask', { message: 'no', attachments: [] }),
    /expects 1 attachment/,
  );

  const file = runtimeFor({ modality: 'file' });
  await openAsk(file.runtime);
  assert.throws(
    () => file.runtime.answerHover('ask', { choice: 'no' }),
    /attachments must be an array/,
  );
});

test('rejects empty and multi-entry attachment answers', async () => {
  for (const modality of ['image', 'file'] as const) {
    const { runtime } = runtimeFor({ modality });
    await openAsk(runtime);

    assert.throws(
      () => runtime.answerHover('ask', { attachments: [] }),
      /expects 1 attachment/,
    );
    assert.throws(
      () =>
        runtime.answerHover('ask', { attachments: [
            { path: '/one' },
            { path: '/two' },
          ] }),
      /expects 1 attachment/,
    );
  }
});

test('an image attachment is inferred from mediaType or extension', async () => {
  const image = runtimeFor({ modality: 'image' });
  await openAsk(image.runtime);
  assert.throws(
    () =>
      image.runtime.answerHover('ask', { attachments: [{ path: '/report.pdf' }] }),
    /expects one image attachment/,
  );
  const answer: Value = { attachments: [{ path: '/photo.png' }] };
  image.runtime.answerHover('ask', answer);
  await image.runtime.settle();
  assert.deepEqual(image.calls, [answer]);

  // The file modality accepts any local path; the kind is not a tag.
  const file = runtimeFor({ modality: 'file' });
  await openAsk(file.runtime);
  const fileAnswer: Value = { attachments: [{ path: '/photo.png' }] };
  file.runtime.answerHover('ask', fileAnswer);
  await file.runtime.settle();
  assert.deepEqual(file.calls, [fileAnswer]);
});

test('a message answer needs a string message; attachments are optional', async () => {
  const { runtime } = runtimeFor({ modality: 'message' });
  await openAsk(runtime);

  assert.throws(
    () => runtime.answerHover('ask', { attachments: [] }),
    /expects a string field 'message'/,
  );
  runtime.answerHover('ask', {
    message: 'hello',
    attachments: [{ path: '/report.pdf' }],
  });
  await runtime.settle();
  assert.equal(runtime.snapshot().rest, true);
});

test('rejects an attachment without a usable path or mediaType', async () => {
  const { runtime } = runtimeFor({ modality: 'image' });
  await openAsk(runtime);

  assert.throws(
    () =>
      runtime.answerHover('ask', { attachments: [{ path: '   ' }] }),
    /attachment must be/,
  );
  assert.throws(
    () =>
      runtime.answerHover('ask', { attachments: [
          { path: '/photo.png', mediaType: 5 as unknown as string },
        ] }),
    /attachment must be/,
  );
});
