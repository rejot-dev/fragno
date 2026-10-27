import { serveLofiSqliteWorker } from "@fragno-dev/lofi/sqlite/worker";

import { backofficeFetch } from "@/fragno/auth/browser-auth.client";
import { readWorkerReplicaName } from "@/fragno/lofi/worker-replica-target";

import { UPLOAD_REPLICA_SCHEMAS } from "./replica-schemas";

/** A reading tab that lost the writer to an error competes for it again after this long. */
const RETRY_DELAY_MS = 5_000;

// The page names the worker after the backend it replicates. A replica that fails to open, such as
// one of a backend replaced since the page loaded, fails the page's connection.
const { baseUrl, adapterIdentity } = readWorkerReplicaName(self.name);
serveLofiSqliteWorker({
  replica: {
    baseUrl,
    adapterIdentity,
    fetch: backofficeFetch,
    schemas: UPLOAD_REPLICA_SCHEMAS,
    localSchemas: [],
    projections: [],
    ephemeralTables: [],
    onError(error) {
      console.error("The Upload replica failed to synchronize.", error);
    },
    retryDelayMs: RETRY_DELAY_MS,
  },
  engines: [],
});
