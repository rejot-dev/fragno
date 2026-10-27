import { readViewEngine, serveLofiSqliteWorker } from "@fragno-dev/lofi/sqlite/worker";

import { REPLICA_READS, replicaReads } from "./replica-reads";
import { LOCAL_PROJECTIONS, LOCAL_SCHEMAS, REGISTERED_SCHEMAS } from "./schemas";

// The page names the worker after the base URL of the backend it replicates.
serveLofiSqliteWorker({
  replica: {
    baseUrl: self.name,
    fetch: fetch.bind(globalThis),
    schemas: REGISTERED_SCHEMAS.map((schema) => ({ schema })),
    localSchemas: LOCAL_SCHEMAS.map((schema) => ({ schema })),
    projections: LOCAL_PROJECTIONS,
    ephemeralTables: [],
    onError(error) {
      console.error("The SQLite replica failed to synchronize.", error);
    },
    retryDelayMs: 5_000,
  },
  engines: [readViewEngine({ kind: REPLICA_READS, reads: replicaReads })],
});
