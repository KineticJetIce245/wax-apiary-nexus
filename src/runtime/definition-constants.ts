/**
 * Defaults and bounds shared by the composition parsers.
 *
 * The queue defaults only seed `defaults` in a composition; `typeQueueMax` is
 * the per-type gather queue bound carried in the gather config. Tombstone
 * retention is the temporary §4.13 bound on closed keyed groups.
 */

export const DEFAULT_MIN_INTERVAL_MS = 1000;
export const DEFAULT_QUEUE_MAX = 1024;
export const DEFAULT_QUEUE_TTL_MS = 604_800_000;
export const DEFAULT_TYPE_QUEUE_MAX = 256;
/** Keep at most this many closed keyed groups (temporary, ARCH §4.13). */
export const DEFAULT_GATHER_TOMBSTONE_MAX = 64;
/** A closed keyed group is forgotten after this long (temporary, ARCH §4.13). */
export const DEFAULT_GATHER_TOMBSTONE_TTL_MS = 3_600_000;
