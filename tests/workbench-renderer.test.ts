import assert from 'node:assert/strict';
import test from 'node:test';

import { createRenderState, renderTaggedEvent } from '../src/workbench-renderer.js';
import type { TaggedWorkspaceEvent } from '../src/workbench.js';

function output(connection: string, executionId: string, text: string): TaggedWorkspaceEvent {
  return {
    connection,
    event: { type: 'execution/output', executionId, channel: 'assistant', text },
  };
}

function tool(connection: string, executionId: string): TaggedWorkspaceEvent {
  return {
    connection,
    event: {
      type: 'execution/tool',
      executionId,
      toolCallId: 'tool-1',
      title: 'run: test',
      status: 'inProgress',
    },
  };
}

function state(connection: string, executionId: string): TaggedWorkspaceEvent {
  return {
    connection,
    event: { type: 'execution/state', executionId, state: 'completed' },
  };
}

test('relabels when interleaved chunks switch between executions', () => {
  const render = createRenderState();
  let text = '';
  const write = (chunk: string) => {
    text += chunk;
  };
  renderTaggedEvent(output('dsh', 'aaaaaaaa-1', 'A1'), render, write);
  renderTaggedEvent(output('codex', 'bbbbbbbb-2', 'B1'), render, write);
  renderTaggedEvent(output('dsh', 'aaaaaaaa-1', 'A2'), render, write);

  assert.match(text, /\[dsh:aaaaaaaa\] A1/);
  assert.match(text, /\[codex:bbbbbbbb\] B1/);
  assert.match(text, /\[dsh:aaaaaaaa\] A2/);
  assert.doesNotMatch(text, /B1A2/);
});

test('keeps chunks of the same execution in one labelled run', () => {
  const render = createRenderState();
  let text = '';
  renderTaggedEvent(output('dsh', 'aaaaaaaa-1', 'he'), render, (chunk) => {
    text += chunk;
  });
  renderTaggedEvent(output('dsh', 'aaaaaaaa-1', 'llo'), render, (chunk) => {
    text += chunk;
  });
  assert.equal(text, '\n[dsh:aaaaaaaa] hello');
});

test('relabels after a tool or state event interrupts the stream', () => {
  const render = createRenderState();
  let text = '';
  const write = (chunk: string) => {
    text += chunk;
  };
  renderTaggedEvent(output('dsh', 'aaaaaaaa-1', 'before'), render, write);
  renderTaggedEvent(tool('dsh', 'aaaaaaaa-1'), render, write);
  renderTaggedEvent(output('dsh', 'aaaaaaaa-1', 'after'), render, write);
  assert.match(text, /before\n\[dsh\] tool run: test inProgress\n/);
  assert.match(text, /\[dsh:aaaaaaaa\] after/);

  renderTaggedEvent(state('dsh', 'aaaaaaaa-1'), render, write);
  renderTaggedEvent(output('dsh', 'aaaaaaaa-1', 'again'), render, write);
  assert.match(text, /\[dsh:aaaaaaaa\] again/);
});
