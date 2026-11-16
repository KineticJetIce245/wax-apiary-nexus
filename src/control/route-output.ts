import type { RunRecord } from '../storage/run-store.js';

export function queryParam(rawUrl: string | undefined, name: string): string | undefined {
  if (rawUrl === undefined) {
    return undefined;
  }
  const queryIndex = rawUrl.indexOf('?');
  if (queryIndex === -1) {
    return undefined;
  }
  const value = new URLSearchParams(rawUrl.slice(queryIndex + 1)).get(name);
  return value === null || value === '' ? undefined : value;
}

export function outputBody(record: RunRecord): Record<string, unknown> {
  return {
    ok: true,
    graphId: record.liveId,
    runId: record.runId,
    requestId: record.requestId,
    outputs: record.outputs.map((output) => ({
      nodeId: output.nodeId,
      value: output.value,
    })),
  };
}
