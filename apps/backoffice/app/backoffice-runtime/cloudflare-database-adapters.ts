import { SqlAdapter } from "@fragno-dev/db/adapters/sql";
import { DurableObjectDialect } from "@fragno-dev/db/dialects/durable-object";
import { CloudflareDurableObjectsDriverConfig } from "@fragno-dev/db/drivers";

import type {
  BackofficeDatabaseAdapterFactory,
  BackofficeDatabaseAdapterScope,
} from "./database-adapters";

export const cloudflareDatabaseAdapters = (
  scope?: BackofficeDatabaseAdapterScope,
): BackofficeDatabaseAdapterFactory => ({
  createAdapter(_input) {
    if (scope?.type !== "durableObject") {
      throw new Error("Cloudflare database adapters require a Durable Object database scope.");
    }

    return new SqlAdapter({
      dialect: new DurableObjectDialect({ ctx: scope.state }),
      driverConfig: new CloudflareDurableObjectsDriverConfig(),
    });
  },
  forScope(nextScope) {
    return cloudflareDatabaseAdapters(nextScope);
  },
});
