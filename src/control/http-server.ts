import { createHash, timingSafeEqual } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';

import { toHttpError } from './http-errors.js';
import { matchRoute } from './route-match.js';
import type { ControlRoutes } from './routes.js';
import type { ControlServerContext } from './server-context.js';
import type { ControlErrorCode, HttpError, Route } from './server-types.js';
import { HttpError as HttpErrorClass } from './server-types.js';
import { parseJsonObject } from './validation.js';

/** The Node HTTP transport for one control server context. */
export class ControlHttpServer {
  constructor(
    private readonly context: ControlServerContext,
    private readonly routes: ControlRoutes,
  ) {}

  createServer(): Server {
    const server = createServer((request, response) => {
      void this.handle(request, response);
    });
    // A late server-level error must never become an unhandled exception.
    server.on('error', () => undefined);
    return server;
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const requestStartedAt = Date.now();
    const pathForLog = requestPathForLog(request.url);
    let status = 500;
    let code: ControlErrorCode | 'ok' = 'internal';

    request.on('error', () => undefined);
    response.on('error', () => undefined);

    try {
      this.authorize(request);

      const route = matchRoute(request.url, request.method);
      if (route === undefined) {
        throw new HttpErrorClass(404, 'not-found', 'not found');
      }
      if (!route.methods.includes(request.method ?? '')) {
        throw new HttpErrorClass(405, 'method-not-allowed', 'method not allowed', {
          allow: route.methods,
        });
      }

      let payload: Record<string, unknown> | undefined;
      if (request.method === 'POST') {
        requireJsonContentType(request);
        const body = await this.readBody(request);
        payload = parseJsonObject(body);
      } else {
        rejectBodyOnGet(request);
      }

      const responseBody = await this.routes.dispatch(
        route,
        payload,
        request.url,
        request.method,
      );
      status = 200;
      code = 'ok';
      sendJson(response, status, responseBody);
    } catch (error) {
      const httpError = toHttpError(error);
      status = httpError.status;
      code = httpError.code;
      if (response.headersSent) {
        response.destroy();
      } else {
        sendError(request, response, httpError);
      }
    } finally {
      this.logRequest(
        request.method ?? '-',
        pathForLog,
        status,
        Date.now() - requestStartedAt,
        code,
      );
    }
  }

  private authorize(request: IncomingMessage): void {
    const expected = this.context.tokenValue;
    if (expected === undefined) {
      throw unauthorized();
    }
    const header = request.headers.authorization;
    if (typeof header !== 'string') {
      throw unauthorized();
    }
    const match = /^Bearer[ ]+([^\s]+)$/i.exec(header);
    if (match === null) {
      throw unauthorized();
    }
    const provided = match[1];
    if (provided === undefined || !tokensEqual(provided, expected)) {
      throw unauthorized();
    }
  }

  private readBody(request: IncomingMessage): Promise<Buffer> {
    return new Promise<Buffer>((resolvePromise, reject) => {
      const declaredHeader = request.headers['content-length'];
      if (declaredHeader !== undefined) {
        const declared = Number(declaredHeader);
        if (!Number.isSafeInteger(declared) || declared < 0) {
          reject(new HttpErrorClass(400, 'bad-request', 'invalid content-length'));
          return;
        }
        if (declared > this.context.maxBodyBytes) {
          reject(new HttpErrorClass(413, 'too-large', 'request body too large'));
          return;
        }
      }

      const chunks: Buffer[] = [];
      let total = 0;
      let settled = false;

      const cleanup = (): void => {
        request.off('data', onData);
        request.off('end', onEnd);
        request.off('error', onError);
        request.off('aborted', onAborted);
      };
      const fail = (error: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        request.pause();
        reject(error);
      };
      const onData = (chunk: Buffer): void => {
        total += chunk.length;
        if (total > this.context.maxBodyBytes) {
          fail(new HttpErrorClass(413, 'too-large', 'request body too large'));
          return;
        }
        chunks.push(chunk);
      };
      const onEnd = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolvePromise(Buffer.concat(chunks, total));
      };
      const onError = (): void => {
        fail(new HttpErrorClass(400, 'bad-request', 'request body could not be read'));
      };
      const onAborted = (): void => {
        fail(new HttpErrorClass(400, 'bad-request', 'request body could not be read'));
      };

      request.on('data', onData);
      request.on('end', onEnd);
      request.on('error', onError);
      request.on('aborted', onAborted);
    });
  }

  private logRequest(
    method: string,
    path: string,
    status: number,
    durationMs: number,
    code: ControlErrorCode | 'ok',
  ): void {
    try {
      this.context.logger(
        `control method=${sanitizeLogText(method, 16)} path=${path} ` +
          `status=${String(status)} durationMs=${String(Math.max(0, Math.trunc(durationMs)))} ` +
          `code=${code}`,
      );
    } catch {
      // Logging is observability, never a reason to change a response.
    }
  }
}

export function listenOnLoopback(server: Server, port: number, host: string): Promise<void> {
  return new Promise<void>((resolvePromise, reject) => {
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onListening = (): void => {
      cleanup();
      resolvePromise();
    };
    const cleanup = (): void => {
      server.off('error', onError);
      server.off('listening', onListening);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ port, host, exclusive: true });
  });
}

export async function closeServer(server: Server | undefined): Promise<void> {
  if (server === undefined) {
    return;
  }
  await new Promise<void>((resolvePromise) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const done = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      resolvePromise();
    };

    timer = setTimeout(done, 1_000);
    timer.unref();
    try {
      server.close(() => done());
    } catch {
      done();
    }
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
  });
}

function unauthorized(): HttpError {
  return new HttpErrorClass(401, 'unauthorized', 'missing or invalid bearer token');
}

function tokensEqual(provided: string, expected: string): boolean {
  const providedDigest = createHash('sha256').update(provided, 'utf8').digest();
  const expectedDigest = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

function requireJsonContentType(request: IncomingMessage): void {
  const header = request.headers['content-type'];
  if (typeof header !== 'string') {
    throw new HttpErrorClass(
      415,
      'unsupported-media-type',
      'content-type must be application/json',
    );
  }
  const mediaType = header.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (mediaType !== 'application/json') {
    throw new HttpErrorClass(
      415,
      'unsupported-media-type',
      'content-type must be application/json',
    );
  }
}

function rejectBodyOnGet(request: IncomingMessage): void {
  const lengthHeader = request.headers['content-length'];
  const hasLength = lengthHeader !== undefined && lengthHeader !== '0';
  const hasTransferEncoding = request.headers['transfer-encoding'] !== undefined;
  if (hasLength || hasTransferEncoding) {
    throw new HttpErrorClass(400, 'bad-request', 'GET requests must not have a body');
  }
}

function requestPathForLog(rawUrl: string | undefined): string {
  if (rawUrl === undefined) {
    return '-';
  }
  const queryIndex = rawUrl.indexOf('?');
  const path = queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex);
  return sanitizeLogText(path, 200);
}

function sanitizeLogText(value: string, maxLength: number): string {
  return value.slice(0, maxLength).replace(/[^\u0021-\u007e]/g, '?');
}

function sendJson(
  response: ServerResponse,
  status: number,
  payload: Record<string, unknown>,
): void {
  if (response.writableEnded || response.destroyed) {
    return;
  }
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(payload));
}

function sendError(
  request: IncomingMessage,
  response: ServerResponse,
  error: HttpError,
): void {
  if (response.writableEnded || response.destroyed) {
    return;
  }
  const headers: Record<string, string> = {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Type': 'application/json; charset=utf-8',
    Connection: 'close',
  };
  if (error.options.allow !== undefined) {
    headers['Allow'] = error.options.allow.join(', ');
  }

  try {
    response.writeHead(error.status, headers);
  } catch {
    response.destroy();
    return;
  }

  const payload: Record<string, unknown> = {
    ok: false,
    code: error.code,
    error: error.message,
  };
  if (error.options.body !== undefined) {
    Object.assign(payload, error.options.body);
  }

  const destroyRequest = (): void => {
    try {
      request.destroy();
    } catch {
      // The client may already have gone away.
    }
  };
  response.once('finish', destroyRequest);
  response.once('close', destroyRequest);
  response.end(JSON.stringify(payload));
}
