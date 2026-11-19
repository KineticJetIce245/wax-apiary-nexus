import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runDispatchCli } from '../src/cli/dispatch-cli.js';
import { runLiveCli } from '../src/cli/live-cli.js';
import { runTemplateCli } from '../src/cli/template-cli.js';
import { runAnswerCli, runWakeCli } from '../src/cli/wake-cli.js';
import type { LiveHive } from '../src/b/types.js';
import { GraphBindingStore } from '../src/graph/binding-store.js';
import { startServer, makeEnv } from './support/control-server-fixtures.js';
import { simpleLiveHive, simpleTemplate } from './support/b-object-fixtures.js';

function writer(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line) => lines.push(line) };
}

test('wax live/template/dispatch use one daemon endpoint', async (t) => {
  const env = makeEnv({ output: 'cli-output' });
  const running = await startServer(env, {
    liveProject: env.project,
    bindingStore: new GraphBindingStore(join(env.daemonDir, 'graph-bindings.json')),
  });
  t.after(async () => {
    await running.server.stop();
    await env.workspace.stop();
  });
  const draft = await env.registry.create(env.project, { harness: 'codex' });
  const review = await env.registry.create(env.project, { harness: 'codex' });
  const done = await env.registry.create(env.project, { harness: 'codex' });
  const live: LiveHive = {
    ...simpleLiveHive(),
    bindings: {
      draft: draft.sessionId,
      review: review.sessionId,
      done: done.sessionId,
    },
  };
  const directory = mkdtempSync(join(tmpdir(), 'wax-cli-live-'));
  const liveFile = join(directory, 'live.json');
  writeFileSync(liveFile, JSON.stringify(live), 'utf8');

  const newOut = writer();
  const newErr = writer();
  assert.equal(
    await runLiveCli(
      ['live', 'new', liveFile, '--daemon-dir', env.daemonDir, '--json'],
      { stdout: newOut.write, stderr: newErr.write },
    ),
    0,
    newErr.lines.join('\n'),
  );
  assert.equal((JSON.parse(newOut.lines[0] ?? '{}') as Record<string, unknown>)['liveId'], 'demo');

  const liveListOut = writer();
  assert.equal(
    await runLiveCli(
      ['live', 'list', '--daemon-dir', env.daemonDir, '--json'],
      { stdout: liveListOut.write, stderr: writer().write },
    ),
    0,
  );
  assert.equal(
    ((JSON.parse(liveListOut.lines[0] ?? '{}') as Record<string, unknown>)['lives'] as Record<string, unknown>[])[0]?.['state'],
    'loaded',
  );

  const saveOut = writer();
  assert.equal(
    await runLiveCli(
      ['live', 'save', 'demo', '--daemon-dir', env.daemonDir, '--json'],
      { stdout: saveOut.write, stderr: writer().write },
    ),
    0,
  );
  assert.equal(
    (JSON.parse(saveOut.lines[0] ?? '{}') as Record<string, unknown>)['graphId'],
    'demo',
  );

  const unloadOut = writer();
  assert.equal(
    await runLiveCli(
      ['live', 'unload', 'demo', '--daemon-dir', env.daemonDir, '--json'],
      { stdout: unloadOut.write, stderr: writer().write },
    ),
    0,
  );
  assert.equal(
    (JSON.parse(unloadOut.lines[0] ?? '{}') as Record<string, unknown>)['unloaded'],
    true,
  );

  const loadOut = writer();
  assert.equal(
    await runLiveCli(
      ['live', 'load', 'demo', '--daemon-dir', env.daemonDir, '--json'],
      { stdout: loadOut.write, stderr: writer().write },
    ),
    0,
  );
  assert.equal(
    (JSON.parse(loadOut.lines[0] ?? '{}') as Record<string, unknown>)['liveId'],
    'demo',
  );

  const migratedFile = join(directory, 'migrated.json');
  const migratedLive: LiveHive = {
    ...live,
    liveId: 'demo',
    bees: {
      ...live.bees,
      draft: {
        ...live.bees['draft']!,
        config: {
          ...live.bees['draft']!.config,
          prompt: 'draft migrated {{input}}',
        },
      },
    },
  };
  writeFileSync(migratedFile, JSON.stringify(migratedLive), 'utf8');
  const migrateOut = writer();
  assert.equal(
    await runLiveCli(
      ['live', 'migrate', 'demo', migratedFile, '--daemon-dir', env.daemonDir, '--json'],
      { stdout: migrateOut.write, stderr: writer().write },
    ),
    0,
  );
  assert.equal(
    (JSON.parse(migrateOut.lines[0] ?? '{}') as Record<string, unknown>)['liveId'],
    'demo',
  );

  const wakeOut = writer();
  assert.equal(
    await runLiveCli(
      ['live', 'wake', 'demo', 'draft', '--input', 'hello', '--daemon-dir', env.daemonDir, '--json'],
      { stdout: wakeOut.write, stderr: writer().write },
    ),
    0,
  );
  assert.equal(
    (JSON.parse(wakeOut.lines[0] ?? '{}') as Record<string, unknown>)['graphId'],
    'demo',
  );

  const topWakeOut = writer();
  assert.equal(
    await runWakeCli(
      ['wake', 'demo', 'draft', '--input', 'again', '--daemon-dir', env.daemonDir, '--json'],
      { stdout: topWakeOut.write, stderr: writer().write },
    ),
    0,
  );
  assert.equal(
    (JSON.parse(topWakeOut.lines[0] ?? '{}') as Record<string, unknown>)['graphId'],
    'demo',
  );

  const templateFile = join(directory, 'template.json');
  const template = simpleTemplate();
  const cliTemplate = {
    ...template,
    defaults: {
      draft: { harness: 'codex' },
      review: { harness: 'codex' },
      done: { harness: 'codex' },
    },
  };
  writeFileSync(templateFile, JSON.stringify(cliTemplate), 'utf8');
  const composeOut = writer();
  assert.equal(
    await runTemplateCli(
      ['template', 'compose', templateFile, '--daemon-dir', env.daemonDir, '--json'],
      { stdout: composeOut.write, stderr: writer().write },
    ),
    0,
  );
  assert.equal(
    (JSON.parse(composeOut.lines[0] ?? '{}') as Record<string, unknown>)['templateId'],
    'starter',
  );

  const listOut = writer();
  assert.equal(
    await runTemplateCli(
      ['template', 'list', '--daemon-dir', env.daemonDir, '--json'],
      { stdout: listOut.write, stderr: writer().write },
    ),
    0,
  );
  assert.equal(
    ((JSON.parse(listOut.lines[0] ?? '{}') as Record<string, unknown>)['templates'] as unknown[]).length,
    1,
  );

  const instantiateOut = writer();
  const instantiateErr = writer();
  assert.equal(
    await runLiveCli(
      ['live', 'instantiate', 'starter', 'instantiated', '--daemon-dir', env.daemonDir, '--json'],
      { stdout: instantiateOut.write, stderr: instantiateErr.write },
    ),
    0,
    instantiateErr.lines.join('\n'),
  );
  assert.equal(
    (JSON.parse(instantiateOut.lines[0] ?? '{}') as Record<string, unknown>)['liveId'],
    'instantiated',
  );

  const dispatchOut = writer();
  assert.equal(
    await runDispatchCli(
      ['dispatch', '--input', 'summarize', '--daemon-dir', env.daemonDir, '--json'],
      { stdout: dispatchOut.write, stderr: writer().write },
    ),
    0,
  );
  assert.equal(
    (JSON.parse(dispatchOut.lines[0] ?? '{}') as Record<string, unknown>)['output'],
    'cli-output',
  );
});

test('top-level wax wake/answer resolves a user hover', async (t) => {
  const env = makeEnv();
  const running = await startServer(env, { liveProject: env.project });
  t.after(async () => {
    await running.server.stop();
    await env.workspace.stop();
  });
  const directory = mkdtempSync(join(tmpdir(), 'wax-cli-answer-'));
  const liveFile = join(directory, 'ask.json');
  writeFileSync(
    liveFile,
    JSON.stringify({
      schemaVersion: 1,
      liveId: 'ask',
      bees: {
        ask: { kind: 'user', config: { modality: 'text', prompt: '?' }, outgoing: [] },
      },
      beelines: {},
      bindings: {},
    }),
    'utf8',
  );
  assert.equal(
    await runLiveCli(
      ['live', 'new', liveFile, '--daemon-dir', env.daemonDir],
      { stdout: writer().write, stderr: writer().write },
    ),
    0,
  );
  assert.equal(
    await runWakeCli(
      ['wake', 'ask', 'ask', '--input', 'open', '--daemon-dir', env.daemonDir],
      { stdout: writer().write, stderr: writer().write },
    ),
    0,
  );
  assert.equal(
    await runAnswerCli(
      ['answer', 'ask', 'ask', '--input', 'answer', '--daemon-dir', env.daemonDir],
      { stdout: writer().write, stderr: writer().write },
    ),
    0,
  );
});

test('wax live rejects bad usage and unknown live ids without retrying', async (t) => {
  const env = makeEnv();
  const running = await startServer(env, { liveProject: env.project });
  t.after(async () => {
    await running.server.stop();
    await env.workspace.stop();
  });
  const err = writer();
  assert.equal(
    await runLiveCli(['live', 'wake', 'demo'], { stdout: writer().write, stderr: err.write }),
    2,
  );
  assert.match(err.lines.join('\n'), /usage: wax live/);

  const unknownErr = writer();
  assert.equal(
    await runLiveCli(
      ['live', 'inspect', 'missing', '--daemon-dir', env.daemonDir],
      { stdout: writer().write, stderr: unknownErr.write },
    ),
    1,
  );
  assert.match(unknownErr.lines.join('\n'), /code=not-found/);

  const dispatchErr = writer();
  assert.equal(
    await runDispatchCli(
      ['dispatch', '--daemon-dir', env.daemonDir],
      { stdout: writer().write, stderr: dispatchErr.write },
    ),
    2,
  );
  assert.match(dispatchErr.lines.join('\n'), /usage: wax dispatch/);
});
