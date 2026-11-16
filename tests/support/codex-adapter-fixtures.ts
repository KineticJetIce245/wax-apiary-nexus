import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CodexAppServerAdapter } from '../../src/adapters/codex/adapter.js';
import type { HarnessEvent } from '../../src/adapters/harness.js';
import type { CodexLaunch } from '../../src/session/connection.js';

const FAKE_SERVER = String.raw`
const readline = require('node:readline');
const path = require('node:path');
const fs = require('node:fs');
const mode = process.argv[2];
const recordPath = process.argv[3];
const recordDir = process.argv[4] || '';
const projectRoot = process.argv[5] || '';
const rl = readline.createInterface({ input: process.stdin });
let turnSeq = 0;
let threadSeq = 0;
let currentThread = null;
let activeTurn = null;
let approvalId = 900;
const pendingApprovals = new Map();

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}
function respond(id, result) {
  send({ id, result });
}
function notify(method, params) {
  send({ method, params });
}
function finish(status, error) {
  notify('turn/completed', {
    threadId: currentThread,
    turn: { id: activeTurn, status, ...(error === undefined ? {} : { error }) },
  });
  activeTurn = null;
}

rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    if (mode === 'init-reject' && message.params?.capabilities?.experimentalApi === true) {
      send({ id: message.id, error: { code: -32602, message: 'experimentalApi is not supported' } });
      return;
    }
    if (recordDir) {
      fs.writeFileSync(path.join(recordDir, 'initialize.json'), JSON.stringify(message.params));
    }
    respond(message.id, { userAgent: 'codex-cli 0.166.0 (fake)' });
    return;
  }
  if (message.method === 'initialized') {
    return;
  }
  if (message.method === 'account/read') {
    respond(message.id, { account: { type: 'chatgpt' }, requiresOpenaiAuth: true });
    return;
  }
  if (message.method === 'project/list') {
    if (mode === 'project') {
      respond(message.id, {
        data: [
          { id: 'proj-outer', roots: [{ path: path.dirname(projectRoot) }] },
          { id: 'proj-inner', roots: [{ path: projectRoot }] },
        ],
        nextCursor: null,
      });
    } else if (mode === 'project-error') {
      send({ id: message.id, error: { code: -32601, message: 'Method not found' } });
    } else {
      respond(message.id, { data: [], nextCursor: null });
    }
    return;
  }
  if (message.method === 'thread/name/set') {
    if (recordDir) {
      fs.writeFileSync(path.join(recordDir, 'thread-name.json'), JSON.stringify(message.params));
    }
    respond(message.id, {});
    return;
  }
  if (message.method === 'thread/start') {
    threadSeq += 1;
    currentThread = 'thr-' + threadSeq;
    if (recordPath) {
      require('node:fs').writeFileSync(recordPath, JSON.stringify(message.params));
    }
    respond(message.id, {
      thread: { id: currentThread },
      model: 'fake-model',
      approvalPolicy: 'on-request',
      sandbox: { type: 'readOnly' },
    });
    return;
  }
  if (message.method === 'thread/resume') {
    if (recordPath) {
      require('node:fs').writeFileSync(recordPath, JSON.stringify(message.params));
    }
    respond(message.id, { thread: { id: message.params.threadId, cwd: '/resumed/cwd' } });
    return;
  }  if (message.method === 'turn/start') {
    turnSeq += 1;
    activeTurn = 'turn-' + turnSeq;
    if (mode === 'no-accept') {
      return;
    }
    if (mode === 'late-start' && turnSeq === 1) {
      setTimeout(() => {
        notify('turn/started', { threadId: currentThread, turn: { id: activeTurn } });
        setTimeout(() => finish('completed'), 50);
      }, 150);
      return;
    }
    respond(message.id, { turn: { id: activeTurn } });
    notify('turn/started', { threadId: currentThread, turn: { id: activeTurn } });
    if (mode === 'exit') {
      setTimeout(() => process.exit(0), 20);
      return;
    }
    if (mode === 'happy') {
      notify('item/started', { threadId: currentThread, turnId: activeTurn, item: { type: 'agentMessage', id: 'msg-1', text: '' } });
      notify('item/agentMessage/delta', { threadId: currentThread, turnId: activeTurn, itemId: 'msg-1', delta: 'hel' });
      notify('item/agentMessage/delta', { threadId: currentThread, turnId: activeTurn, itemId: 'msg-1', delta: 'lo' });
      notify('item/completed', { threadId: currentThread, turnId: activeTurn, item: { type: 'agentMessage', id: 'msg-1', text: 'hello' } });
      finish('completed');
    }
    if (mode === 'approval' || mode === 'deny') {
      const id = approvalId++;
      pendingApprovals.set(id, true);
      send({
        id,
        method: 'item/commandExecution/requestApproval',
        params: { threadId: currentThread, turnId: activeTurn, itemId: 'exec-1', command: 'echo hi' },
      });
    }
    if (mode === 'permissions' || mode === 'permissions-deny') {
      const id = approvalId++;
      send({
        id,
        method: 'item/permissions/requestApproval',
        params: {
          threadId: currentThread,
          turnId: activeTurn,
          permissions: { network: { enabled: true } },
          reason: 'network access',
        },
      });
    }
    if (mode === 'elicitation' || mode === 'elicitation-deny') {
      const id = approvalId++;
      send({
        id,
        method: 'mcpServer/elicitation/request',
        params: { serverName: 'unified_delegate', threadId: currentThread, turnId: activeTurn },
      });
    }
    if (mode === 'elicitation-mismatch') {
      const id = approvalId++;
      send({
        id,
        method: 'mcpServer/elicitation/request',
        params: { serverName: 'unified_delegate', threadId: currentThread, turnId: 'stale-turn' },
      });
    }
    if (mode === 'fail') {
      finish('failed', { message: 'boom' });
    }
    if (mode === 'unknown-status') {
      finish('mystery');
    }
    if (mode === 'hang-turn') {
      // never settle
    }
    if (mode === 'stale-terminal' && turnSeq === 2) {
      setTimeout(
        () => notify('turn/completed', { threadId: currentThread, turn: { id: 'turn-1', status: 'completed' } }),
        20,
      );
      setTimeout(() => finish('completed'), 100);
    }
    if (mode === 'stale-approval') {
      if (turnSeq === 1) {
        setTimeout(() => finish('completed'), 20);
      } else {
        const id = approvalId++;
        send({
          id,
          method: 'item/commandExecution/requestApproval',
          params: { threadId: currentThread, turnId: 'turn-1', itemId: 'old-exec', command: 'old command' },
        });
      }
    }
    return;
  }
  if (message.method === 'turn/interrupt') {
    respond(message.id, {});
    if (mode === 'no-terminal') {
      return;
    }
    if (mode === 'late-terminal') {
      setTimeout(() => finish('interrupted'), 100);
      return;
    }
    if (activeTurn !== null) {
      finish('interrupted');
    }
    return;
  }
  if (message.method === 'thread/unsubscribe') {
    if (mode === 'hang-close') {
      return;
    }
    respond(message.id, { status: 'unsubscribed' });
    return;
  }
  if (message.id !== undefined && message.result !== undefined) {
    const decision = message.result.decision;
    const text =
      mode === 'permissions' || mode === 'permissions-deny' || mode === 'elicitation' || mode === 'elicitation-deny' || mode === 'elicitation-mismatch'
        ? 'result=' + JSON.stringify(message.result)
        : 'decision=' + decision;
    notify('item/completed', {
      threadId: currentThread,
      turnId: activeTurn,
      item: { type: 'agentMessage', id: 'msg-approval', text },
    });
    finish('completed');
    return;
  }
  if (message.id !== undefined && message.error !== undefined) {
    finish('failed', { message: message.error.message });
  }
});
`;

interface FakeServerOptions {
  /** Directory where initialize and thread-name request params are recorded. */
  readonly recordDir?: string;
  /** Root returned by a `project/list` response in the project modes. */
  readonly projectRoot?: string;
}

export function makeFakeServer(
  mode: string,
  recordPath?: string,
  options: FakeServerOptions = {},
): CodexLaunch {
  const dir = mkdtempSync(join(tmpdir(), 'uw-fake-codex-'));
  const script = join(dir, 'fake-app-server.cjs');
  writeFileSync(script, FAKE_SERVER, 'utf8');
  return {
    file: process.execPath,
    args: [
      script,
      mode,
      recordPath ?? '',
      options.recordDir ?? '',
      options.projectRoot ?? '',
    ],
  };
}

export async function open(mode: string): Promise<{ adapter: CodexAppServerAdapter; events: HarnessEvent[]; projectDir: string }> {
  const projectDir = mkdtempSync(join(tmpdir(), 'uw-codex-project-'));
  const adapter = new CodexAppServerAdapter({ launch: makeFakeServer(mode), requestTimeoutMs: 2_000 });
  const events: HarnessEvent[] = [];
  adapter.onEvent((event) => events.push(event));
  await adapter.start();
  return { adapter, events, projectDir };
}

export async function waitForEvent<T extends { readonly type: string }>(
  events: readonly T[],
  predicate: (event: T) => boolean,
  timeoutMs = 5_000,
): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const found = events.find(predicate);
    if (found !== undefined) {
      return found;
    }
    await delay(10);
  }
  throw new Error(`event not observed within ${timeoutMs}ms`);
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
