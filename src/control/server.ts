import type { Server } from 'node:http';

import type { GraphHost } from '../daemon/graph-host.js';
import { ControlHttpServer } from './http-server.js';
import { ControlRoutes } from './routes.js';
import { ControlServerContext } from './server-context.js';
import { ControlServerLifecycle } from './server-lifecycle.js';
import type { ControlServerInfo, ControlServerOptions } from './server-types.js';

export type { ControlServerInfo, ControlServerOptions } from './server-types.js';

/**
 * Local control API facade.
 *
 * Transport is plain HTTP on loopback only; the token is the authentication
 * boundary. The facade owns the context and delegates lifecycle, transport and
 * route dispatch to the corresponding services.
 */
export class ControlServer {
  private readonly context: ControlServerContext;
  private readonly http: ControlHttpServer;
  private readonly lifecycle: ControlServerLifecycle;

  constructor(options: ControlServerOptions) {
    this.context = new ControlServerContext(options);
    const routes = new ControlRoutes(this.context);
    this.http = new ControlHttpServer(this.context, routes);
    this.lifecycle = new ControlServerLifecycle(this.context, this.http);
  }

  start(): Promise<ControlServerInfo> {
    return this.lifecycle.start();
  }

  stop(): Promise<void> {
    return this.lifecycle.stop();
  }

  info(): ControlServerInfo {
    return this.lifecycle.info();
  }

  /** Test/inspection seams; state lives in the shared context. */
  private get graphHost(): GraphHost | undefined {
    return this.context.graphHost;
  }

  private get server(): Server | undefined {
    return this.context.server;
  }

  private get sweepTimer(): NodeJS.Timeout | undefined {
    return this.context.sweepTimer;
  }
}
