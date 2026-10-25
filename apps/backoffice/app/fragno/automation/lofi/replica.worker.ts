import { serveLofiSqliteWorker } from "@fragno-dev/lofi/sqlite/worker";

import { backofficeFetch } from "@/fragno/auth/browser-auth.client";

import { automationReplicaHost } from "./replica-host";

/** A reading tab that lost the writer to an error competes for it again after this long. */
const RETRY_DELAY_MS = 5_000;

// A worker starts with no arguments but its name, so the page names it after the backend's URL.
// A replica that fails to open fails the page's connection.
serveLofiSqliteWorker({
  replica: {
    baseUrl: self.name,
    fetch: backofficeFetch,
    schemas: automationReplicaHost.schemas,
    localSchemas: automationReplicaHost.localSchemas,
    projections: automationReplicaHost.projections,
    ephemeralTables: automationReplicaHost.ephemeralTables,
    onError(error) {
      console.error("The Automations replica failed to synchronize.", error);
    },
    retryDelayMs: RETRY_DELAY_MS,
  },
  engines: automationReplicaHost.engines,
});
