import { zqlViewEngine } from "@fragno-dev/lofi-zql/worker";
import { serveLofiSqliteWorker } from "@fragno-dev/lofi/sqlite/worker";

import { backofficeFetch } from "@/fragno/auth/browser-auth.client";

import { UPLOAD_REPLICA_SCHEMAS } from "./replica-schemas";

/** A reading tab that lost the writer to an error competes for it again after this long. */
const RETRY_DELAY_MS = 5_000;

// A worker starts with no arguments but its name, so the page names it after the backend's URL.
// A replica that fails to open fails the page's connection.
serveLofiSqliteWorker({
  replica: {
    baseUrl: self.name,
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
  engines: [zqlViewEngine],
});
