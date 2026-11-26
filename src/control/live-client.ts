import type { HiveTemplate, LiveHive, SessionParams } from '../b/types.js';
import type { Project } from '../project/kernel.js';
import { ControlClientError, ControlClient } from './client.js';

export interface LiveOperationResult {
  readonly liveId: string;
  readonly status: Record<string, unknown>;
}

/**
 * Typed B operation client. It extends the established loopback-only,
 * single-attempt control client; the token never enters a URL or error text.
 */
export class LiveHiveClient extends ControlClient {
  async listLives(): Promise<readonly unknown[]> {
    const body = await this.request('GET', '/lives');
    const lives = body['lives'];
    if (!Array.isArray(lives)) {
      throw protocolError("control response missing 'lives' array");
    }
    return lives;
  }

  /** The field-owned last output per bee; no run id and no history. */
  async output(liveId: string): Promise<Record<string, unknown>> {
    return this.request('GET', `/lives/${encodeURIComponent(liveId)}/output`);
  }

  async createLive(live: LiveHive, project?: Project): Promise<LiveOperationResult> {
    const body = await this.request('POST', '/lives', {
      live,
      ...(project === undefined ? {} : { project }),
    });
    return parseLiveResult(body);
  }

  async loadLive(
    liveId: string,
    path?: string,
    project?: Project,
  ): Promise<LiveOperationResult> {
    const body = await this.request('POST', '/lives/load', {
      liveId,
      ...(path === undefined ? {} : { path }),
      ...(project === undefined ? {} : { project }),
    });
    return parseLiveResult(body);
  }

  async instantiateLive(
    templateId: string,
    liveId: string,
    overrides?: Readonly<Record<string, SessionParams>>,
    project?: Project,
  ): Promise<LiveOperationResult> {
    const body = await this.request('POST', '/lives/instantiate', {
      templateId,
      liveId,
      ...(overrides === undefined ? {} : { overrides }),
      ...(project === undefined ? {} : { project }),
    });
    return parseLiveResult(body);
  }

  /**
   * Deliver one Pheromone to a bee. The call returns once the daemon accepted
   * it (202); execution continues on the daemon. Read `inspect`/`output` for
   * the field's state.
   */
  async trigger(liveId: string, beeId: string, input: string): Promise<void> {
    await this.request('POST', '/lives/trigger', { liveId, beeId, input });
  }

  async answerLive(
    liveId: string,
    beeId: string,
    input: string,
    token?: string,
  ): Promise<void> {
    await this.request('POST', '/lives/answer', {
      liveId,
      beeId,
      input,
      ...(token === undefined ? {} : { token }),
    });
  }

  async saveLive(liveId: string): Promise<unknown> {
    const body = await this.request('POST', '/lives/save', { liveId });
    return requireField(body, 'status');
  }

  async unloadLive(liveId: string): Promise<boolean> {
    const body = await this.request('POST', '/lives/unload', { liveId });
    const value = body['unloaded'];
    if (typeof value !== 'boolean') {
      throw protocolError("control response missing boolean 'unloaded'");
    }
    return value;
  }

  async migrateLive(
    liveId: string,
    hive: LiveHive,
    project?: Project,
  ): Promise<LiveOperationResult> {
    const body = await this.request('POST', '/lives/migrate', {
      liveId,
      hive,
      ...(project === undefined ? {} : { project }),
    });
    return parseLiveResult(body);
  }

  async inspect(liveId: string): Promise<Record<string, unknown>> {
    return this.request('GET', `/lives/${encodeURIComponent(liveId)}/inspect`);
  }

  async dispatch(
    input: string,
    options: {
      readonly sessionParams?: SessionParams;
      readonly sessionId?: string;
      readonly project?: Project;
    } = {},
  ): Promise<void> {
    await this.request('POST', '/dispatch', {
      input,
      ...(options.sessionParams === undefined
        ? {}
        : { sessionParams: options.sessionParams }),
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      ...(options.project === undefined ? {} : { project: options.project }),
    });
  }
}

/** Template-only additions; keeps the core LiveHiveClient at the method cap. */
export class TemplateClient extends LiveHiveClient {
  async composeTemplate(template: HiveTemplate): Promise<string> {
    const body = await this.request('POST', '/templates', { template });
    const templateId = body['templateId'];
    if (typeof templateId !== 'string' || templateId.length === 0) {
      throw protocolError("control response missing 'templateId'");
    }
    return templateId;
  }

  async listTemplates(): Promise<readonly unknown[]> {
    const body = await this.request('GET', '/templates');
    const templates = body['templates'];
    if (!Array.isArray(templates)) {
      throw protocolError("control response missing 'templates' array");
    }
    return templates;
  }
}

function parseLiveResult(body: Record<string, unknown>): LiveOperationResult {
  const liveId = body['liveId'];
  const status = body['status'];
  if (typeof liveId !== 'string' || typeof status !== 'object' || status === null) {
    throw protocolError("control response missing liveId/status");
  }
  return { liveId, status: status as Record<string, unknown> };
}

function requireField(body: Record<string, unknown>, field: string): unknown {
  if (!Object.hasOwn(body, field)) {
    throw protocolError(`control response missing '${field}'`);
  }
  return body[field];
}

function protocolError(message: string): ControlClientError {
  return new ControlClientError(message, { code: 'protocol' });
}
