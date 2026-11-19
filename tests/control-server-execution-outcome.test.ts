import assert from 'node:assert/strict';
import test from 'node:test';

import { FakeAdapter, type FakeTerminal } from './support/fake-adapter.js';
import {
  OUTPUT_SECRET,
  PROMPT_SECRET,
  assertNoSecrets,
  foragerDefinition,
  makeEnvWithAdapter,
  startServer,
} from './support/control-server-fixtures.js';
import { bLoad, bWake } from './support/control-server-http.js';

interface Scenario {
  readonly terminal: FakeTerminal;
  readonly status: number;
  readonly code: string;
}

/**
 * The execution terminal state is the only signal the HTTP error carries.
 * `failed` and `unknown` remain internal 500; only a definite `cancelled`
 * stop is a client-visible conflict.
 */
const SCENARIOS: readonly Scenario[] = [
  { terminal: 'failed', status: 500, code: 'internal' },
  { terminal: 'unknown', status: 500, code: 'internal' },
  { terminal: 'cancelled', status: 409, code: 'execution-cancelled' },
];

for (const scenario of SCENARIOS) {
  const { terminal, status, code } = scenario;

  test(`a ${terminal} execution answers ${String(status)} ${code}`, async (t) => {
    const liveId = `outcome-${terminal}`;
    const adapter = new FakeAdapter({
      terminal,
      output: OUTPUT_SECRET,
      error: `${terminal}-native-detail`,
    });
    const env = makeEnvWithAdapter(adapter);
    const running = await startServer(env);
    t.after(async () => {
      await running.server.stop();
      await env.workspace.stop();
    });

    const loaded = await bLoad(running.info.url, running.token, {
      definition: foragerDefinition(liveId, `run ${PROMPT_SECRET} {{input}}`),
      bindings: { only: { kind: 'fresh' } },
      project: env.project,
    });
    assert.equal(loaded.status, 200);

    const wake = await bWake(running.info.url, running.token, liveId, 'only', PROMPT_SECRET);
    assert.equal(wake.status, status, wake.text);
    assert.equal(wake.body?.['ok'], false);
    assert.equal(wake.body?.['code'], code);
    assertNoSecrets(wake.text, running.token);
    assert.equal(wake.text.includes(OUTPUT_SECRET), false);

    t.diagnostic(`observed: state=${terminal} status=${String(wake.status)} code=${code}`);
  });
}
