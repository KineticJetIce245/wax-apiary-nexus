/**
 * Defaults and bounds shared by the composition parsers.
 *
 * `DEFAULT_MERGE_TIMEOUT_MS` and `MAX_MERGE_TIMEOUT_MS` are part of the public
 * runtime contract; the queue defaults only seed `defaults` in a composition.
 */

export const DEFAULT_MIN_INTERVAL_MS = 1000;
export const DEFAULT_QUEUE_MAX = 1024;
export const DEFAULT_QUEUE_TTL_MS = 604_800_000;

/**
 * Stage 5B: how long a Merge waits for its required branches, measured from the
 * first branch arrival for one forkId. The upper bound keeps the persisted
 * deadline (epoch ms plus this value) a safe 32-bit timer delay.
 */
export const DEFAULT_MERGE_TIMEOUT_MS = 600_000;
export const MAX_MERGE_TIMEOUT_MS = 2_147_483_647;
