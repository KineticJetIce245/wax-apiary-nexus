import assert from 'node:assert/strict';
import test from 'node:test';

import { LiveHiveHost } from '../src/daemon/graph-host.js';
import { parseComposition, type CompositionDefinition } from '../src/runtime/index.js';
import { makeEnv, text, waitUntil } from './support/graph-host-fixtures.js';

/** A user-only graph parks at a hover without any native execution. */
function userOnlyDefinition(id: string): CompositionDefinition {
  return parseComposition({
    schemaVersion: 1,
    id,
    nodes: {
      ask: { kind: 'user', config: { modality: 'text', prompt: 'Answer?' } },
    },
    edges: [],
  });
}

test(
  'an ephemeral graph stays loaded while hovered and is released at silent end',
  async (t) => {
    const env = makeEnv();
    const host = new LiveHiveHost({
      registry: env.registry,
      now: () => 1_000,
    });
    t.after(async () => {
      await host.dispose();
      await env.workspace.stop();
    });

    await host.loadGraph({
      definition: userOnlyDefinition('ephemeral-driver'),
      bindings: {},
      project: env.project,
      idleTtlMs: 0,
      ephemeral: true,
    });
    await host.trigger('ephemeral-driver', 'ask', text('waiting'));

    // The hover is a real field state: the ephemeral graph stays loaded and
    // observable, never dropped at a release cap. It is not listed as a
    // LiveHive while it lives.
    await waitUntil(
      () => host.statusOf('ephemeral-driver')?.hovered === true,
      'the ephemeral graph to park on its hover',
    );
    const held = host.statusOf('ephemeral-driver');
    assert.ok(held !== undefined);
    assert.equal(held.rest, false);
    assert.equal(held.hovered, true);
    assert.equal(host.status().length, 0, 'an ephemeral graph is not listed as a LiveHive');

    // Answering completes the field; the Rest transition releases the graph
    // without a polling driver.
    await host.answer('ephemeral-driver', 'ask', text('done'));
    await waitUntil(
      () => host.statusOf('ephemeral-driver') === undefined,
      'the ephemeral graph to unload after silent end',
    );
  },
);
