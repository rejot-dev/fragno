import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";
import { createUploadFragmentClient } from "@fragno-dev/upload/react";

export function createUploadClient(
  orgId: string,
  config: FragnoPublicClientConfig = {},
): ReturnType<typeof createUploadFragmentClient> {
  return createUploadFragmentClient({
    ...config,
    mountRoute: `/api/upload/${orgId}`,
  });
}
