import { createResendFragment, type ResendFragmentConfig } from "@fragno-dev/resend-fragment";

import type { BackofficeFragmentRuntimeOptions } from "@/backoffice-runtime/fragment-runtime";

export type ResendConfig = Pick<
  ResendFragmentConfig,
  "apiKey" | "webhookSecret" | "defaultFrom" | "defaultReplyTo" | "defaultTags" | "defaultHeaders"
>;

export function createResendServer(
  config: ResendConfig,
  runtime: BackofficeFragmentRuntimeOptions,
): ReturnType<typeof createResendFragment> {
  return createResendFragment(config, {
    databaseAdapter: runtime.adapters.createAdapter({
      kind: "resend",
    }),
    mountRoute: "/api/resend",
  });
}

export type ResendFragment = ReturnType<typeof createResendServer>;
