import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CompositionValidationError,
  parseComposition,
} from '../src/runtime/index.js';

function composition(userConfig: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: 'modalities',
    nodes: {
      ask: {
        kind: 'user',
        config: { modality: 'text', prompt: 'Answer?', ...userConfig },
      },
    },
    edges: [],
  };
}

function issuesOf(input: unknown): string[] {
  try {
    parseComposition(input);
  } catch (error) {
    assert.ok(error instanceof CompositionValidationError);
    return [...error.issues];
  }
  assert.fail('expected the composition to be rejected');
}

test('parses the message, image and file user modalities', () => {
  for (const modality of ['message', 'image', 'file']) {
    const parsed = parseComposition(composition({ modality }));
    const node = parsed.nodes.get('ask');
    assert.ok(node !== undefined);
    assert.equal(node.kind, 'user');
    if (node.kind !== 'user') {
      continue;
    }
    assert.equal(node.config.modality, modality);
    assert.equal(node.config.prompt, 'Answer?');
    assert.equal(node.config.choices, undefined);
  }
});

test('keeps text, choice and yes-no working', () => {
  const text = parseComposition(composition());
  const textNode = text.nodes.get('ask');
  assert.ok(textNode?.kind === 'user');
  assert.equal(textNode.config.modality, 'text');

  const choice = parseComposition(
    composition({ modality: 'choice', choices: ['approve', 'reject'] }),
  );
  const choiceNode = choice.nodes.get('ask');
  assert.ok(choiceNode?.kind === 'user');
  assert.deepEqual(choiceNode.config.choices, ['approve', 'reject']);

  const yesNo = parseComposition(composition({ modality: 'yes-no' }));
  const yesNoNode = yesNo.nodes.get('ask');
  assert.ok(yesNoNode?.kind === 'user');
  assert.equal(yesNoNode.config.modality, 'yes-no');
});

test('rejects choices on the message, image and file modalities', () => {
  for (const modality of ['message', 'image', 'file']) {
    const issues = issuesOf(composition({ modality, choices: ['a'] }));
    assert.ok(
      issues.some((issue) => issue.includes('only allowed in choice mode')),
      `choices must be rejected for '${modality}'`,
    );
  }
});

test('rejects an unknown modality and malformed user config', () => {
  const unknown = issuesOf(composition({ modality: 'audio' }));
  assert.ok(
    unknown.some((issue) =>
      issue.includes("expected 'text', 'choice', 'yes-no', 'message', 'image' or 'file'"),
    ),
  );

  const emptyPrompt = issuesOf(composition({ modality: 'image', prompt: '   ' }));
  assert.ok(emptyPrompt.some((issue) => issue.includes('prompt: expected a non-empty string')));

  const unknownField = issuesOf(composition({ modality: 'file', accept: ['png'] }));
  assert.ok(unknownField.some((issue) => issue.includes("unknown field 'accept'")));

  const missingChoices = issuesOf(composition({ modality: 'choice' }));
  assert.ok(missingChoices.some((issue) => issue.includes('choice mode needs')));
});
