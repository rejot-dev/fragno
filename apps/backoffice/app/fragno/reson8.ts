import { createReson8Fragment } from "@fragno-dev/reson8-fragment";

import {
  authorizeBackofficeFragmentRequest,
  type BackofficeFragmentHttpAccess,
} from "@/backoffice-runtime/fragment-http-authorization";
import type { BackofficeKernel } from "@/backoffice-runtime/kernel";
import { BACKOFFICE_PERMISSION } from "@/backoffice-runtime/permissions";

export type Reson8Config = {
  apiKey: string;
};

export function createReson8Server(
  config: Reson8Config,
  kernel: BackofficeKernel,
): ReturnType<typeof createReson8Fragment> {
  return createReson8Fragment(config, {
    mountRoute: "/api/reson8",
  }).withMiddleware(async function authorizeReson8Routes({ ifMatchesRoute, requestContext }) {
    let access: BackofficeFragmentHttpAccess = null;
    for (const path of ["/custom-model", "/custom-model/:id"] as const) {
      await ifMatchesRoute("GET", path, () => {
        access = BACKOFFICE_PERMISSION.reson8.use;
      });
    }
    for (const path of ["/auth/token", "/custom-model", "/speech-to-text/prerecorded"] as const) {
      await ifMatchesRoute("POST", path, () => {
        access = BACKOFFICE_PERMISSION.reson8.use;
      });
    }
    return await authorizeBackofficeFragmentRequest(kernel, requestContext, access, null);
  });
}

export type Reson8Fragment = ReturnType<typeof createReson8Server>;
