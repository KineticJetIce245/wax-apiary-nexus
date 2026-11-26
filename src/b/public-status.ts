import type { LiveHiveStatus } from '../daemon/graph-host.js';

/**
 * Public projection of the internal execution-engine status.
 *
 * The engine names (`graphId`, `graphRevision`) are implementation details and
 * never cross the control HTTP or CLI boundary. This projection is explicit so
 * a new internal field cannot leak by accident.
 */
export type PublicLiveStatus = {
  readonly rest: boolean;
  readonly hovered: boolean;
  readonly nodes: LiveHiveStatus['nodes'];
  readonly recovery?: LiveHiveStatus['recovery'];
  readonly residency: LiveHiveStatus['residency'];
};

/** Hide engine-only identity fields from a status returned by the API. */
export function toPublicStatus(status: LiveHiveStatus): PublicLiveStatus {
  return {
    rest: status.rest,
    hovered: status.hovered,
    nodes: status.nodes,
    ...(status.recovery === undefined ? {} : { recovery: status.recovery }),
    residency: status.residency,
  };
}
