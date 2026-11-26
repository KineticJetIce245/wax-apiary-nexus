import assert from 'node:assert/strict';
import test from 'node:test';

import { LiveHiveHost } from '../src/daemon/graph-host.js';
import { parseComposition, type CompositionDefinition } from '../src/runtime/index.js';
import { deferred, makeEnv, text, waitUntil } from './support/graph-host-fixtures.js';

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
  'an ephemeral graph held past the old release cap stays loaded until silent end',
  async (t) => {
    const env = makeEnv();
    const gate = deferred();
    const reachedCap = deferred();
    let sleeps = 0;
    const host = new LiveHiveHost({
      registry: env.registry,
      // Every poll is a yield, not a real 25ms wait. The 2401st poll parks on
      // the gate so the test can observe the old attempt cap being crossed.
      sleep: async () => {
        sleeps += 1;
        if (sleeps === 2_401) {
          reachedCap.resolve();
          await gate.promise;
        }
      },
    });
    t.after(async () => {
      gate.resolve();
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
    await waitUntil(() => sleeps === 2_401, 'the driver to pass the old 2400 cap');

    // The graph is still loaded and observable, not silently dropped at a cap.
    const held = host.statusOf('ephemeral-driver');
    assert.ok(held !== undefined, 'ephemeral graph disappeared at the old cap');
    assert.equal(held.rest, false);
    assert.equal(held.hovered, true);
    assert.equal(host.status().length, 0, 'an ephemeral graph is not listed as a LiveHive');

    await host.answer('ephemeral-driver', 'ask', text('done'));
    gate.resolve();
    await waitUntil(
      () => host.statusOf('ephemeral-driver') === undefined,
      'the ephemeral graph to unload after silent end',
    );
    assert.ok(sleeps >= 2_401);
  },
);
