import { readViewEngine, serveLofiSqliteWorker } from "@fragno-dev/lofi/sqlite/worker";

import { IMPORT_READS, importReads, importReplica, type ImportTarget } from "./import-replica";
import { FIXTURE_BASE_PATH } from "./outbox-fixture";

// The page names the worker after what it imports.
const target = JSON.parse(self.name) as ImportTarget;
serveLofiSqliteWorker({
  replica: {
    ...importReplica(target),
    baseUrl: FIXTURE_BASE_PATH,
    fetch: fetch.bind(globalThis),
    onError(error) {
      console.error("The import failed.", error);
    },
    retryDelayMs: 5_000,
  },
  engines: [readViewEngine({ kind: IMPORT_READS, reads: importReads })],
});
