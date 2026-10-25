import { zqlViewEngine } from "@fragno-dev/lofi-zql/worker";
import { serveLofiSqliteWorker } from "@fragno-dev/lofi/sqlite/worker";

import { uploadSchema } from "../../../packages/fragment-upload/src/schema";
import { FIXTURE_BASE_PATH } from "./outbox-fixture";
import { ZQL_ERRORS_CHANNEL } from "./zql-errors";

const errors = new BroadcastChannel(ZQL_ERRORS_CHANNEL);
const reportError = (error: unknown) => {
  errors.postMessage(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
};

serveLofiSqliteWorker({
  replica: {
    baseUrl: FIXTURE_BASE_PATH,
    fetch: fetch.bind(globalThis),
    schemas: [{ schema: uploadSchema }],
    localSchemas: [],
    projections: [],
    ephemeralTables: [],
    onError: reportError,
    retryDelayMs: 5_000,
  },
  engines: [zqlViewEngine],
});
