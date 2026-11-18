import { MAX_ID_LENGTH, MAX_PATH_LENGTH } from './server-constants.js';
import type { Route } from './server-types.js';

/** Match a raw request path without URL normalization. */
export function matchRoute(rawUrl: string | undefined, method?: string): Route | undefined {
  if (rawUrl === undefined) {
    return undefined;
  }
  const queryIndex = rawUrl.indexOf('?');
  const path = queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex);
  if (!path.startsWith('/') || path.length > MAX_PATH_LENGTH) {
    return undefined;
  }
  if (/[\\\u0000-\u001f\u007f]/.test(path)) {
    return undefined;
  }

  // Deliberately no URL normalization: `/status/../health` must be an
  // unknown path, never a redirect to `/health`. Dot segments and empty
  // segments are rejected before any route lookup.
  const parts = path.split('/').slice(1);
  if (parts.length === 0 || parts.some((part) => part === '' || part === '.' || part === '..')) {
    return undefined;
  }

  if (parts.length === 1) {
    switch (parts[0]) {
      case 'health':
        return { kind: 'health', methods: ['GET'] };
      case 'status':
        return { kind: 'status', methods: ['GET'] };
      case 'trigger':
        return { kind: 'trigger', methods: ['POST'] };
      case 'answer':
        return { kind: 'answer', methods: ['POST'] };
      case 'sweep':
        return { kind: 'sweep', methods: ['POST'] };
      case 'catalog':
        return { kind: 'catalog', methods: ['GET'] };
      case 'guards':
        return { kind: 'guards', methods: ['GET'] };
      case 'sessions':
        return { kind: 'sessions', methods: ['GET'] };
      case 'lives':
        return method === 'GET'
          ? { kind: 'lives-list', methods: ['GET'] }
          : { kind: 'lives-create', methods: ['POST'] };
      case 'templates':
        return { kind: 'templates', methods: ['GET', 'POST'] };
      case 'dispatch':
        return { kind: 'dispatch', methods: ['POST'] };
      default:
        return undefined;
    }
  }

  if (parts.length === 2) {
    const first = parts[0];
    const second = parts[1];
    if (first === undefined || second === undefined) {
      return undefined;
    }
    if (first === 'status') {
      if (second.length > MAX_ID_LENGTH) {
        return undefined;
      }
      return { kind: 'graph-status', methods: ['GET'], graphId: second };
    }
    if (first === 'graphs' && second === 'load') {
      return { kind: 'load', methods: ['POST'] };
    }
    if (first === 'graphs' && second === 'unload') {
      return { kind: 'unload', methods: ['POST'] };
    }
    if (first === 'sessions' && second === 'close') {
      return { kind: 'session-close', methods: ['POST'] };
    }
    if (first === 'sessions' && second === 'sweep') {
      return { kind: 'session-sweep', methods: ['POST'] };
    }
    if (first === 'guard' && second === 'decide') {
      return { kind: 'guard-decide', methods: ['POST'] };
    }
    if (first === 'lives') {
      switch (second) {
        case 'load':
          return { kind: 'lives-load', methods: ['POST'] };
        case 'instantiate':
          return { kind: 'lives-instantiate', methods: ['POST'] };
        case 'wake':
          return { kind: 'lives-wake', methods: ['POST'] };
        case 'answer':
          return { kind: 'lives-answer', methods: ['POST'] };
        case 'save':
          return { kind: 'lives-save', methods: ['POST'] };
        case 'unload':
          return { kind: 'lives-unload', methods: ['POST'] };
        case 'migrate':
          return { kind: 'lives-migrate', methods: ['POST'] };
        default:
          return undefined;
      }
    }
  }

  if (parts.length === 3) {
    const first = parts[0];
    const second = parts[1];
    const third = parts[2];
    if (first === undefined || second === undefined || third === undefined) {
      return undefined;
    }
    if (
      first === 'graphs' &&
      third === 'output' &&
      second.length <= MAX_ID_LENGTH
    ) {
      return { kind: 'graph-output', methods: ['GET'], graphId: second };
    }
    if (
      first === 'lives' &&
      third === 'inspect' &&
      second.length <= MAX_ID_LENGTH
    ) {
      return { kind: 'lives-inspect', methods: ['GET'], graphId: second };
    }
    if (
      first === 'lives' &&
      third === 'output' &&
      second.length <= MAX_ID_LENGTH
    ) {
      return { kind: 'lives-output', methods: ['GET'], graphId: second };
    }
  }

  return undefined;
}
