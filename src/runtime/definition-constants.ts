/**
 * Defaults and bounds shared by the composition parsers.
 *
 * The queue defaults only seed `defaults` in a composition; `typeQueueMax` is
 * the M19d per-type gather queue bound carried in the gather config.
 */

export const DEFAULT_MIN_INTERVAL_MS = 1000;
export const DEFAULT_QUEUE_MAX = 1024;
export const DEFAULT_QUEUE_TTL_MS = 604_800_000;
export const DEFAULT_TYPE_QUEUE_MAX = 256;
