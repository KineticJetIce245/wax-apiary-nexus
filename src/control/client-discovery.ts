import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { expandHomePath } from '../storage/conversation-store.js';
import { ControlClientError } from './client-errors.js';

const LOOPBACK_HOST = '127.0.0.1';
const DEFAULT_DAEMON_PARTS = ['.wax', 'waxd'] as const;
const MAX_CONFIG_LENGTH = 4_096;
const MAX_TOKEN_LENGTH = 4_096;

export interface DaemonDiscoveryOptions {
  /** Default `~/.wax/waxd`. A leading `~` is expanded. */
  readonly daemonDir?: string;
  /** Used only to resolve the default home directory. */
  readonly env?: NodeJS.ProcessEnv;
}

export interface DaemonDiscovery {
  readonly baseUrl: string;
  readonly token: string;
  readonly infoPath: string;
  readonly tokenPath: string;
}

export interface LoopbackUrl {
  readonly baseUrl: string;
  readonly port: number;
}

/**
 * Reads `server.json` and the token file written by `ControlServer`.
 *
 * Discovery is deliberately strict: only a loopback HTTP URL on the exact
 * port declared in the info file is accepted. A malformed, redirected or
 * remote endpoint must never receive the daemon token.
 */
export function discoverDaemon(options: DaemonDiscoveryOptions = {}): DaemonDiscovery {
  const daemonDir = resolveDaemonDirectory(options);
  const infoPath = join(daemonDir, 'server.json');

  const raw = readInfoFile(infoPath);
  const info = parseInfoFile(raw, infoPath);

  const host = info['host'];
  if (host !== LOOPBACK_HOST) {
    throw discoveryError(infoPath, `host must be '${LOOPBACK_HOST}'`);
  }

  const port = info['port'];
  if (
    typeof port !== 'number' ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    throw discoveryError(infoPath, 'port must be an integer between 1 and 65535');
  }

  let endpoint: LoopbackUrl;
  try {
    endpoint = parseLoopbackUrl(info['url']);
  } catch {
    throw discoveryError(infoPath, `url must be http://${LOOPBACK_HOST}:<port>`);
  }
  if (endpoint.port !== port) {
    throw discoveryError(infoPath, 'port does not match url');
  }

  const rawTokenPath = info['tokenPath'];
  if (
    typeof rawTokenPath !== 'string' ||
    rawTokenPath.length === 0 ||
    rawTokenPath.length > MAX_CONFIG_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(rawTokenPath)
  ) {
    throw discoveryError(infoPath, 'tokenPath must be a non-empty string');
  }
  const tokenPath = resolve(expandHomePath(rawTokenPath));
  const token = readTokenFile(infoPath, tokenPath);

  return {
    baseUrl: endpoint.baseUrl,
    token,
    infoPath,
    tokenPath,
  };
}

/**
 * Strict parser for the only endpoint this client may ever contact. Echoing
 * the rejected value is avoided so a token accidentally embedded in a URL can
 * never end up in an error message.
 */
export function parseLoopbackUrl(value: unknown): LoopbackUrl {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_CONFIG_LENGTH
  ) {
    throw new Error('invalid loopback url');
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('invalid loopback url');
  }

  if (
    parsed.protocol !== 'http:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.hostname !== LOOPBACK_HOST ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new Error('invalid loopback url');
  }

  const portText = parsed.port;
  if (!/^[0-9]+$/.test(portText)) {
    throw new Error('invalid loopback url');
  }
  const port = Number(portText);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('invalid loopback url');
  }

  return {
    baseUrl: `http://${LOOPBACK_HOST}:${String(port)}`,
    port,
  };
}

function resolveDaemonDirectory(options: DaemonDiscoveryOptions): string {
  if (options.daemonDir !== undefined) {
    const value = options.daemonDir;
    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      value.length > MAX_CONFIG_LENGTH ||
      /[\u0000-\u001f\u007f]/.test(value)
    ) {
      throw new ControlClientError('control daemonDir must be a non-empty string', {
        code: 'discovery',
      });
    }
    return resolve(expandHomePath(value));
  }

  const env = options.env;
  const home = env?.['HOME'] || env?.['USERPROFILE'] || homedir();
  return resolve(join(home, ...DEFAULT_DAEMON_PARTS));
}

function readInfoFile(infoPath: string): string {
  try {
    return readFileSync(infoPath, 'utf8');
  } catch {
    throw discoveryError(infoPath, 'server.json is missing or unreadable');
  }
}

function parseInfoFile(raw: string, infoPath: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw discoveryError(infoPath, 'server.json is not valid JSON');
  }
  if (!isRecord(parsed)) {
    throw discoveryError(infoPath, 'server.json must be a JSON object');
  }
  return parsed;
}

function readTokenFile(infoPath: string, tokenPath: string): string {
  let contents: string;
  try {
    contents = readFileSync(tokenPath, 'utf8');
  } catch {
    throw discoveryError(infoPath, `token file '${tokenPath}' is missing or unreadable`);
  }

  const token = contents.trim();
  if (
    token.length === 0 ||
    token.length > MAX_TOKEN_LENGTH ||
    /[\s\u0000-\u001f\u007f]/.test(token)
  ) {
    throw discoveryError(
      infoPath,
      `token file '${tokenPath}' does not contain a valid token`,
    );
  }
  return token;
}

function discoveryError(infoPath: string, reason: string): ControlClientError {
  return new ControlClientError(
    `daemon discovery failed at '${infoPath}': ${reason}`,
    { code: 'discovery' },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
