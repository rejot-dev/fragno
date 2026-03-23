import { createCloudflareFragmentClient } from "@fragno-dev/cloudflare-fragment/react";
import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";

export function createCloudflareClient(
  orgId: string,
  config: FragnoPublicClientConfig = {},
): ReturnType<typeof createCloudflareFragmentClient> {
  return createCloudflareFragmentClient({
    ...config,
    mountRoute: `/api/cloudflare/${orgId}`,
  });
}
