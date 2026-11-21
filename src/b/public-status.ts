import type { GraphRunResult, GraphStatus } from '../daemon/graph-host.js';

/**
 * Public projection of the internal execution-engine status.
 *
 * The engine names (`graphId`, `graphRevision`) are implementation details and
 * never cross the control HTTP or CLI boundary. This projection is explicit so
 * a new internal field cannot leak by accident.
 */
export type PublicGraphStatus = {
  readonly rest: boolean;
  readonly hovered: boolean;
  readonly nodes: GraphStatus['nodes'];
  readonly recovery?: GraphStatus['recovery'];
  readonly residency: GraphStatus['residency'];
};

/** Public projection of one run; the live is named `liveId`, never `graphId`. */
export type PublicGraphRunResult = {
  readonly liveId: string;
  readonly runId: string;
  readonly requestId: string;
  readonly rest: boolean;
  readonly hovered: boolean;
  readonly pumps: number;
  readonly status: PublicGraphStatus;
  readonly persisted: boolean;
  readonly persistError?: string;
};

/** Hide engine-only identity fields from a status returned by the API. */
export function toPublicStatus(status: GraphStatus): PublicGraphStatus {
  return {
    rest: status.rest,
    hovered: status.hovered,
    nodes: status.nodes,
    ...(status.recovery === undefined ? {} : { recovery: status.recovery }),
    residency: status.residency,
  };
}

/** Hide engine-only identity fields from a run result returned by the API. */
export function toPublicRunResult(result: GraphRunResult): PublicGraphRunResult {
  return {
    liveId: result.graphId,
    runId: result.runId,
    requestId: result.requestId,
    rest: result.rest,
    hovered: result.hovered,
    pumps: result.pumps,
    status: toPublicStatus(result.status),
    persisted: result.persisted,
    ...(result.persistError === undefined ? {} : { persistError: result.persistError }),
  };
}
