import { createCloudflareFragment } from "@fragno-dev/cloudflare-fragment";

import type { BackofficeFragmentRuntimeOptions } from "@/backoffice-runtime/fragment-runtime";

export type CloudflareFragmentSource = {
  accountId: string;
  apiToken: string;
};

export type CloudflareFragment = ReturnType<typeof createCloudflareFragment>;

export const createCloudflareServer = (
  source: CloudflareFragmentSource,
  runtime: BackofficeFragmentRuntimeOptions,
): CloudflareFragment =>
  createCloudflareFragment(
    {
      accountId: source.accountId,
      apiToken: source.apiToken,
    },
    {
      databaseAdapter: runtime.adapters.createAdapter({ kind: "cloudflare" }),
      mountRoute: "/api/cloudflare",
    },
  );
