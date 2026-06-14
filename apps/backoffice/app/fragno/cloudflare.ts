import {
  createCloudflareFragment,
  type CloudflareFragmentConfig,
} from "@fragno-dev/cloudflare-fragment";

import type { BackofficeFragmentRuntimeOptions } from "@/backoffice-runtime/fragment-runtime";

export function createCloudflareServer(
  config: CloudflareFragmentConfig,
  runtime: BackofficeFragmentRuntimeOptions,
): ReturnType<typeof createCloudflareFragment> {
  return createCloudflareFragment(config, {
    databaseAdapter: runtime.adapters.createAdapter({
      kind: "cloudflareWorkers",
    }),
    mountRoute: "/api/cloudflare",
  });
}

export type CloudflareFragment = ReturnType<typeof createCloudflareServer>;
