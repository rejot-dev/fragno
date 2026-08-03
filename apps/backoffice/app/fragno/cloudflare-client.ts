import { createCloudflareFragmentClient } from "@fragno-dev/cloudflare-fragment/react";

export type CloudflareClient = ReturnType<typeof createCloudflareFragmentClient>;

export const cloudflareClient: CloudflareClient = createCloudflareFragmentClient({
  mountRoute: "/api/cloudflare",
});
