import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { ApprovalRequest } from '../src/adapters/harness.js';
import { ForagerExecutionError, WorkspaceForagerExecutor, type ApprovalHandler } from '../src/session/forager.js';
import { createKernel } from '../src/project/kernel.js';
import { parseComposition, type ForagerNode, type Value } from '../src/runtime/index.js';
import { Workspace } from '../src/session/workspace.js';
import { FakeAdapter, type FakeAdapterOptions, type FakeTerminal } from './support/fake-adapter.js';

function foragerNode(prompt = 'do {{input}}'): ForagerNode {
  const definition = parseComposition({
    schemaVersion: 1,
    id: 'bridge',
    nodes: {
      start: { kind: 'forager', config: { connection: 'codex', prompt } },
    },
    edges: [],
  });
  const node = definition.nodes.get('start');
  if (node === undefined || node.kind !== 'forager') {
    throw new Error('bad fixture');
  }
  return node;
}

interface Bridge {
  readonly adapter: FakeAdapter;
  readonly workspace: Workspace;
  readonly executor: WorkspaceForagerExecutor;
}

async function setup(options: FakeAdapterOptions, onApproval?: ApprovalHandler): Promise<Bridge> {
  const adapter = new FakeAdapter(options);
  await adapter.start();
  const workspace = new Workspace(adapter);
  const project = createKernel().registerProject(mkdtempSync(join(tmpdir(), 'wax-forager-')));
  const conversation = await workspace.createConversation(project);
  const executor = new WorkspaceForagerExecutor({
    workspace,
    conversation,
    ...(onApproval === undefined ? {} : { onApproval }),
  });
  return { adapter, workspace, executor };
}

test('completed execution returns the assistant text and renders the prompt', async (t) => {
  const bridge = await setup({ output: 'HELLO' });
  t.after(async () => {
    bridge.executor.dispose();
    await bridge.workspace.stop();
  });

  const value = await bridge.executor.execute(foragerNode(), { kind: 'text', text: 'hi' });

  assert.deepEqual(value, { kind: 'text', text: 'HELLO' });
  assert.deepEqual(bridge.adapter.prompts, ['do hi']);
  assert.deepEqual(bridge.adapter.submittedAttachments, [[]]);
  assert.deepEqual(bridge.executor.lastOutput, { kind: 'text', text: 'HELLO' });
});

test('renders a structured input as JSON and forwards no nested attachments', async (t) => {
  const bridge = await setup({ output: 'SAW' });
  t.after(async () => {
    bridge.executor.dispose();
    await bridge.workspace.stop();
  });

  const input: Value = {
    kind: 'structured',
    value: {
      branch: { kind: 'text', text: 'A' },
      nested: {
        kind: 'message',
        text: 'm',
        attachments: [{ kind: 'file', path: '/tmp/notes.md' }],
      },
      n: 2,
    },
  };
  await bridge.executor.execute(foragerNode(), input);

  assert.deepEqual(bridge.adapter.prompts, [`do ${JSON.stringify(input.value)}`]);
  assert.deepEqual(bridge.adapter.submittedAttachments, [[]]);
});

test('forwards an image attachment with an inferred mime type', async (t) => {
  const bridge = await setup({ output: 'SAW' });
  t.after(async () => {
    bridge.executor.dispose();
    await bridge.workspace.stop();
  });

  await bridge.executor.execute(foragerNode(), {
    kind: 'attachments',
    attachments: [{ kind: 'image', path: 'C:/tmp/photo.PNG' }],
  });

  assert.deepEqual(bridge.adapter.prompts, ['do ']);
  assert.deepEqual(bridge.adapter.submittedAttachments, [
    [{ kind: 'image', path: 'C:/tmp/photo.PNG', mimeType: 'image/png' }],
  ]);
});

test('forwards file attachments from a message and skips unusable entries', async (t) => {
  const bridge = await setup({ output: 'SAW' });
  t.after(async () => {
    bridge.executor.dispose();
    await bridge.workspace.stop();
  });

  await bridge.executor.execute(foragerNode(), {
    kind: 'message',
    text: 'please review',
    attachments: [
      { kind: 'file', path: '/tmp/notes.md' },
      { kind: 'image', path: '/tmp/diagram.jpeg' },
      { kind: 'audio', path: '/tmp/recording.mp3' },
      { kind: 'file' },
      { kind: 'file', path: '   ' },
    ],
  });

  assert.deepEqual(bridge.adapter.prompts, ['do please review']);
  assert.deepEqual(bridge.adapter.submittedAttachments, [
    [
      { kind: 'file', path: '/tmp/notes.md', mimeType: 'text/markdown' },
      { kind: 'image', path: '/tmp/diagram.jpeg', mimeType: 'image/jpeg' },
    ],
  ]);
});

test('submits no attachments when the input carries none', async (t) => {
  const bridge = await setup({ output: 'TEXT' });
  t.after(async () => {
    bridge.executor.dispose();
    await bridge.workspace.stop();
  });

  await bridge.executor.execute(foragerNode(), { kind: 'text', text: 'plain' });

  assert.deepEqual(bridge.adapter.prompts, ['do plain']);
  assert.deepEqual(bridge.adapter.submittedAttachments, [[]]);
});

test('uses a stable prompt when only attachments remain', async (t) => {
  const bridge = await setup({ output: 'OK' });
  t.after(async () => {
    bridge.executor.dispose();
    await bridge.workspace.stop();
  });

  await bridge.executor.execute(foragerNode('{{input}}'), {
    kind: 'attachments',
    attachments: [{ kind: 'image', path: '/tmp/photo.webp' }],
  });
  await bridge.executor.execute(foragerNode('{{input}}'), {
    kind: 'message',
    text: '   ',
    attachments: [{ kind: 'file', path: '/tmp/report.pdf' }],
  });

  assert.deepEqual(bridge.adapter.prompts, ['See attached input.', 'See attached input.']);
  assert.deepEqual(
    bridge.adapter.submittedAttachments.map((drafts) => drafts.map((draft) => draft.mimeType)),
    [['image/webp'], ['application/pdf']],
  );
});

test('infers mimeType from a small extension map with an octet-stream fallback', async (t) => {
  const bridge = await setup({ output: 'OK' });
  t.after(async () => {
    bridge.executor.dispose();
    await bridge.workspace.stop();
  });

  const cases: readonly (readonly [string, string])[] = [
    ['.png', 'image/png'],
    ['.jpg', 'image/jpeg'],
    ['.jpeg', 'image/jpeg'],
    ['.gif', 'image/gif'],
    ['.webp', 'image/webp'],
    ['.pdf', 'application/pdf'],
    ['.txt', 'text/plain'],
    ['.json', 'application/json'],
    ['.md', 'text/markdown'],
    ['.bin', 'application/octet-stream'],
    ['', 'application/octet-stream'],
  ];

  for (const [extension] of cases) {
    await bridge.executor.execute(foragerNode(), {
      kind: 'attachments',
      attachments: [{ kind: 'file', path: `/tmp/input${extension}` }],
    });
  }

  assert.deepEqual(
    bridge.adapter.submittedAttachments.map((drafts) => drafts[0]?.mimeType),
    cases.map(([, mimeType]) => mimeType),
  );
});

for (const state of ['failed', 'cancelled', 'unknown'] as const satisfies readonly FakeTerminal[]) {
  test(`maps a ${state} execution to a ForagerExecutionError without retrying`, async (t) => {
    const bridge = await setup({ terminal: state, error: `${state}-detail` });
    t.after(async () => {
      bridge.executor.dispose();
      await bridge.workspace.stop();
    });

    await assert.rejects(
      bridge.executor.execute(foragerNode(), { kind: 'text', text: 'x' }),
      (error: unknown) => {
        assert.ok(error instanceof ForagerExecutionError);
        assert.equal(error.state, state);
        assert.equal(error.nodeId, 'start');
        if (state !== 'cancelled') {
          assert.match(error.message, new RegExp(`${state}-detail`));
        }
        return true;
      },
    );

    assert.equal(bridge.adapter.prompts.length, 1, 'a terminal failure must not be retried');
    assert.equal(bridge.executor.lastOutput, undefined);
  });
}

test('an approval handler decides the native request (allow_once)', async (t) => {
  const seen: ApprovalRequest[] = [];
  const handler: ApprovalHandler = async (request) => {
    seen.push(request);
    return 'allow_once';
  };
  const bridge = await setup({ askApproval: true, output: 'APPROVED' }, handler);
  t.after(async () => {
    bridge.executor.dispose();
    await bridge.workspace.stop();
  });

  const value = await bridge.executor.execute(foragerNode(), { kind: 'text', text: 'go' });

  assert.deepEqual(value, { kind: 'text', text: 'APPROVED' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.summary, 'run a command');
  assert.deepEqual(
    bridge.adapter.approvals.map((decision) => decision.kind),
    ['allow_once'],
  );
});

test('without a handler the bridge rejects instead of allowing', async (t) => {
  const bridge = await setup({ askApproval: true, output: 'AFTER-REJECT' });
  t.after(async () => {
    bridge.executor.dispose();
    await bridge.workspace.stop();
  });

  await bridge.executor.execute(foragerNode(), { kind: 'text', text: 'go' });

  assert.deepEqual(
    bridge.adapter.approvals.map((decision) => decision.kind),
    ['reject_once'],
  );
});

test('a handler may cancel the approval', async (t) => {
  const bridge = await setup({ askApproval: true }, async () => 'cancelled');
  t.after(async () => {
    bridge.executor.dispose();
    await bridge.workspace.stop();
  });

  await bridge.executor.execute(foragerNode(), { kind: 'text', text: 'go' });

  assert.deepEqual(
    bridge.adapter.approvals.map((decision) => decision.kind),
    ['cancelled'],
  );
});

test('a throwing approval handler falls back to rejecting', async (t) => {
  const bridge = await setup({ askApproval: true }, async () => {
    throw new Error('ui crashed');
  });
  t.after(async () => {
    bridge.executor.dispose();
    await bridge.workspace.stop();
  });

  await bridge.executor.execute(foragerNode(), { kind: 'text', text: 'go' });

  assert.deepEqual(
    bridge.adapter.approvals.map((decision) => decision.kind),
    ['reject_once'],
  );
});

test('dispose stops approval handling but keeps the last output', async (t) => {
  const bridge = await setup({ output: 'LAST' });
  t.after(async () => {
    await bridge.workspace.stop();
  });

  await bridge.executor.execute(foragerNode(), { kind: 'text', text: 'x' });
  bridge.executor.dispose();
  bridge.executor.dispose();

  assert.deepEqual(bridge.executor.lastOutput, { kind: 'text', text: 'LAST' });
});
