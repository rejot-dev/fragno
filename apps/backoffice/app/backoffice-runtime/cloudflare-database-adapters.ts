import { SqlAdapter } from "@fragno-dev/db/adapters/sql";
import { DurableObjectDialect } from "@fragno-dev/db/dialects/durable-object";
import { CloudflareDurableObjectsDriverConfig } from "@fragno-dev/db/drivers";

import { createCloudflareDatabaseQueryInstrumentation } from "./cloudflare-database-query-instrumentation";
import type {
  BackofficeDatabaseAdapterFactory,
  BackofficeDatabaseAdapterScope,
} from "./database-adapters";

export const cloudflareDatabaseAdapters = (
  scope?: BackofficeDatabaseAdapterScope,
): BackofficeDatabaseAdapterFactory => {
  const queryInstrumentation =
    scope?.type === "durableObject"
      ? createCloudflareDatabaseQueryInstrumentation({
          durableObjectId: scope.id,
          nowEpochMs: Date.now,
          logQueryMetrics(event, fields) {
            console.info(event, fields);
            return undefined;
          },
        })
      : null;

  return {
    createAdapter(input) {
      if (scope?.type !== "durableObject" || !queryInstrumentation) {
        throw new Error("Cloudflare database adapters require a Durable Object database scope.");
      }

      return new SqlAdapter({
        dialect: new DurableObjectDialect({
          ctx: scope.state,
          queryInstrumentation: queryInstrumentation.forDatabase({
            kind: input.kind,
            name: input.databaseName ?? null,
          }),
        }),
        driverConfig: new CloudflareDurableObjectsDriverConfig(),
      });
    },
    forScope(nextScope) {
      return cloudflareDatabaseAdapters(nextScope);
    },
  };
};
