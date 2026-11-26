import assert from 'node:assert/strict';
import test from 'node:test';

import { matchRoute } from '../src/control/route-match.js';

/**
 * ARCHITECTURE.md §4.11 / §9 D7 and CONTRACT.md invariant 13: `Pheromone.id` is
 * a field-local message identity, never a runId-like control handle. Adding an
 * HTTP route that accepts it as a query key must fail this guard.
 */
const PHEROMONE_ID_PATHS = [
  '/lives/demo/pheromones/ph_1',
  '/lives/demo/pheromone/ph_1',
  '/pheromones/ph_1',
  '/pheromone/ph_1',
] as const;

const GUARD_MESSAGE = 'Pheromone.id must not be a control-plane handle (ARCH §4.11/D7)';

test('no control route accepts a Pheromone.id as a query key', () => {
  for (const path of PHEROMONE_ID_PATHS) {
    for (const method of ['GET', 'POST']) {
      assert.equal(
        matchRoute(path, method),
        undefined,
        `${method} ${path} matched: ${GUARD_MESSAGE}`,
      );
    }
  }
});

// Sanity: proves the assertions above are not vacuously green because the
// matcher stopped resolving every route.
test('/lives/trigger still resolves to the lives-trigger route', () => {
  const route = matchRoute('/lives/trigger', 'POST');
  assert.ok(route, 'sanity: /lives/trigger must still match a route');
  assert.equal(route.kind, 'lives-trigger');
  assert.deepEqual(route.methods, ['POST']);
});
