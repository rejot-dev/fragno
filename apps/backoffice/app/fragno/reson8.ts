import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";

import { createReson8Fragment } from "@fragno-dev/reson8-fragment";

import {
  authorizeBackofficeFragmentRequest,
  type BackofficeFragmentHttpAccess,
} from "@/backoffice-runtime/fragment-http-authorization";
import type { BackofficeKernel } from "@/backoffice-runtime/kernel";

export type Reson8Config = {
  apiKey: string;
};

export function createReson8Server(
  config: Reson8Config,
  kernel: BackofficeKernel,
  fetchImpl: typeof fetch = fetch,
): ReturnType<typeof createReson8Fragment> {
  return createReson8Fragment(
    { ...config, fetch: fetchImpl },
    {
      mountRoute: "/api/reson8",
    },
  ).withMiddleware(async function authorizeReson8Routes({ ifMatchesRoute, requestContext }) {
    let access: BackofficeFragmentHttpAccess = null;
    for (const path of ["/custom-model", "/custom-model/:id"] as const) {
      // Listing custom models is the read-only access check integrations.verify runs.
      await ifMatchesRoute("GET", path, () => {
        access = BACKOFFICE_PERMISSION.connections.read;
      });
    }
    for (const path of ["/auth/token", "/custom-model", "/speech-to-text/prerecorded"] as const) {
      await ifMatchesRoute("POST", path, () => {
        access = BACKOFFICE_PERMISSION.integrations.execute;
      });
    }
    return await authorizeBackofficeFragmentRequest(kernel, requestContext, access, null);
  });
}

export type Reson8Fragment = ReturnType<typeof createReson8Server>;
