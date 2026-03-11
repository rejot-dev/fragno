import {
  createCloudflareFragment,
  type CloudflareFragmentConfig,
} from "@fragno-dev/cloudflare-fragment";
import { SqlAdapter } from "@fragno-dev/db/adapters/sql";
import { DurableObjectDialect } from "@fragno-dev/db/dialects/durable-object";
import { CloudflareDurableObjectsDriverConfig } from "@fragno-dev/db/drivers";

export function createAdapter(state?: DurableObjectState) {
  const dialect = new DurableObjectDialect({
    ctx: state!,
  });

  return new SqlAdapter({
    dialect,
    driverConfig: new CloudflareDurableObjectsDriverConfig(),
  });
}

export function createCloudflareServer(
  config: CloudflareFragmentConfig,
  state: DurableObjectState,
): ReturnType<typeof createCloudflareFragment> {
  return createCloudflareFragment(config, {
    databaseAdapter: createAdapter(state),
    mountRoute: "/api/cloudflare",
  });
}

export type CloudflareFragment = ReturnType<typeof createCloudflareServer>;
