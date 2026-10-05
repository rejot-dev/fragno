import { GraftControlReadReplica } from "./graft-control-read-replica";
import type { GraftNodeLease } from "./graft-control-store";
import { createSqlitePragmaGraftDatabaseOperations } from "./graft-database-operations";
import type { GraftNodeRuntimeStorage } from "./graft-runtime-storage";
import { initializeGraftSqlite } from "./graft-sqlite";

/** Read-only worker discovery has no provisioning, ownership, lease mutation, or remote push API. */
export class GraftWorkerDirectory {
  readonly #replica: GraftControlReadReplica;

  constructor(storage: GraftNodeRuntimeStorage) {
    initializeGraftSqlite(storage.configPath);
    this.#replica = new GraftControlReadReplica(
      storage,
      createSqlitePragmaGraftDatabaseOperations(),
    );
  }

  /** Refreshes durable leases; callers still probe authority-aware readiness before delivery. */
  readLiveWorkers(leaseExpiryCutoffMs: number): GraftNodeLease[] {
    return this.#replica.readSnapshot((database) => {
      const rows = database
        .prepare(`
        SELECT node_id, process_generation, private_address, application_origin,
               compatibility_version, expires_at_ms, renewal_id
        FROM node_runtime_node_lease WHERE expires_at_ms > ? ORDER BY node_id
      `)
        .all(leaseExpiryCutoffMs) as {
        node_id: string;
        process_generation: string;
        private_address: string;
        application_origin: string;
        compatibility_version: number;
        expires_at_ms: number;
        renewal_id: string;
      }[];
      return rows.map((row) => ({
        nodeId: row.node_id,
        processGeneration: row.process_generation,
        privateAddress: row.private_address,
        applicationOrigin: row.application_origin,
        compatibilityVersion: row.compatibility_version,
        expiresAtMs: row.expires_at_ms,
        renewalId: row.renewal_id,
      }));
    });
  }

  close(): void {
    this.#replica.close();
  }
}
