import { SqlAdapter } from "@fragno-dev/db/adapters/sql";
import { DurableObjectDialect } from "@fragno-dev/db/dialects/durable-object";
import { CloudflareDurableObjectsDriverConfig } from "@fragno-dev/db/drivers";

import { createOtpFragment } from "@fragno-dev/otp-fragment";

export const OTP_LINK_TYPE = "telegram_link" as const;
export const DEFAULT_TELEGRAM_LINK_EXPIRY_MINUTES = 10;

export function createAdapter(state?: DurableObjectState) {
  const dialect = new DurableObjectDialect({
    ctx: state!,
  });

  return new SqlAdapter({
    dialect,
    driverConfig: new CloudflareDurableObjectsDriverConfig(),
  });
}

export function createOtpServer(state: DurableObjectState) {
  return createOtpFragment(
    {
      defaultExpiryMinutes: DEFAULT_TELEGRAM_LINK_EXPIRY_MINUTES,
    },
    {
      databaseAdapter: createAdapter(state),
      mountRoute: "/api/otp",
    },
  );
}

export type OtpFragment = ReturnType<typeof createOtpServer>;
