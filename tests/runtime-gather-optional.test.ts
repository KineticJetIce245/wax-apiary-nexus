// M19a placeholder. The pre-M19 implementation of this file is archived at
// docs/temp/m19-legacy-tests/runtime-gather-optional.test.ts (outside Git). It asserts the removed
// branch/lineage spread/gather model and is rewritten by M19d.
import test from 'node:test';

test.skip("M19d 重写：required branches complete immediately without waiting for an optional one", () => {});
test.skip("M19d 重写：an optional branch that arrives first waits for required, then combines", () => {});
test.skip("M19d 重写：text combine uses required order, then arrived optional in optional config order", () => {});
test.skip("M19d 重写：an optional branch failure is logged and does not fail the required set", () => {});
test.skip("M19d 重写：an unknown optional branch on restore is logged and does not fail the join", () => {});
test.skip("M19d 重写：a late optional branch is dropped and logged without reopening the join", () => {});
test.skip("M19d 重写：a late required branch is a protocol error and never emits a second time", () => {});
test.skip("M19d 重写：completed gathers are bounded by count, keeping the newest markers", () => {});
test.skip("M19d 重写：expired completed gathers are pruned on the next gather activity", () => {});
test.skip("M19d 重写：restore prunes a completed marker that outlived its retention", () => {});
