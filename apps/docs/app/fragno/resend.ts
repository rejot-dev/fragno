import { createResendFragment, type ResendFragmentConfig } from "@fragno-dev/resend-fragment";
import { SqlAdapter } from "@fragno-dev/db/adapters/sql";
import { CloudflareDurableObjectsDriverConfig } from "@fragno-dev/db/drivers";
import { DurableObjectDialect } from "@fragno-dev/db/dialects/durable-object";

export type ResendConfig = Pick<
  ResendFragmentConfig,
  "apiKey" | "webhookSecret" | "defaultFrom" | "defaultReplyTo" | "defaultTags" | "defaultHeaders"
>;

export function createAdapter(state?: DurableObjectState) {
  const dialect = new DurableObjectDialect({
    ctx: state!,
  });

  return new SqlAdapter({
    dialect,
    driverConfig: new CloudflareDurableObjectsDriverConfig(),
  });
}

export function createResendServer(
  config: ResendConfig,
  state: DurableObjectState,
): ReturnType<typeof createResendFragment> {
  return createResendFragment(config, {
    databaseAdapter: createAdapter(state),
    mountRoute: "/api/resend",
  });
}

export type ResendFragment = ReturnType<typeof createResendServer>;
