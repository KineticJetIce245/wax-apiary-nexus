import { join } from 'node:path';

import { expandHomePath } from '../storage/conversation-store.js';

export const LOOPBACK_HOST = '127.0.0.1';
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
export const DEFAULT_DAEMON_DIR = join(expandHomePath('~/.wax'), 'waxd');
export const DEFAULT_SESSION_SWEEP_INTERVAL_MS = 60_000;
export const DEFAULT_GRAPH_SWEEP_INTERVAL_MS = 60_000;
export const MAX_ID_LENGTH = 512;
export const MAX_PATH_LENGTH = 2_048;
/** Bound for the bearer token and the optional `/answer` hover token. */
export const MAX_TOKEN_LENGTH = 4_096;
/** Bound for the optional manifest path on a trigger or answer request. */
export const MAX_GRAPH_REF_LENGTH = 4_096;
export const TRIGGERABLE_NODE_KINDS: readonly string[] = ['forager', 'worker', 'user'];
/** `/answer` only resolves a user hover; guard decisions keep their own path. */
export const ANSWERABLE_NODE_KINDS: readonly string[] = ['user'];
