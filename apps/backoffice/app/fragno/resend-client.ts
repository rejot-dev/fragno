import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";
import { createResendFragmentClient } from "@fragno-dev/resend-fragment/react";

export function createResendClient(
  orgId: string,
  config: FragnoPublicClientConfig = {},
): ReturnType<typeof createResendFragmentClient> {
  return createResendFragmentClient({
    ...config,
    mountRoute: `/api/resend/${orgId}`,
  });
}
