import { createResendFragmentClient } from "@fragno-dev/resend-fragment/react";
import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";

export function createResendClient(orgId: string, config: FragnoPublicClientConfig = {}) {
  return createResendFragmentClient({
    ...config,
    mountRoute: `/api/resend/${orgId}`,
  });
}
