import { createResendFragment, type ResendFragmentConfig } from "@fragno-dev/resend-fragment";

import {
  authorizeBackofficeFragmentRequest,
  type BackofficeFragmentHttpAccess,
} from "@/backoffice-runtime/fragment-http-authorization";
import type { BackofficeFragmentRuntimeOptions } from "@/backoffice-runtime/fragment-runtime";
import type { BackofficeKernel } from "@/backoffice-runtime/kernel";
import { BACKOFFICE_PERMISSION } from "@/backoffice-runtime/permissions";

export type ResendConfig = Pick<
  ResendFragmentConfig,
  "apiKey" | "webhookSecret" | "defaultFrom" | "defaultReplyTo" | "defaultTags" | "defaultHeaders"
>;

export function createResendServer(
  config: ResendConfig,
  runtime: BackofficeFragmentRuntimeOptions,
  kernel: BackofficeKernel,
): ReturnType<typeof createResendFragment> {
  return createResendFragment(config, {
    databaseAdapter: runtime.adapters.createAdapter({
      kind: "resend",
    }),
    mountRoute: "/api/resend",
  }).withMiddleware(async function authorizeResendRoutes({ ifMatchesRoute, requestContext }) {
    let access: BackofficeFragmentHttpAccess = null;
    await ifMatchesRoute("POST", "/webhook", () => {
      access = "public-ingress";
    });
    for (const path of [
      "/domains",
      "/domains/:domainId",
      "/emails",
      "/emails/:emailId",
      "/received-emails",
      "/received-emails/:emailId",
      "/threads",
      "/threads/:threadId",
      "/threads/:threadId/messages",
    ] as const) {
      await ifMatchesRoute("GET", path, () => {
        access = BACKOFFICE_PERMISSION.resend.read;
      });
    }
    for (const path of ["/emails", "/threads", "/threads/:threadId/reply"] as const) {
      await ifMatchesRoute("POST", path, () => {
        access = BACKOFFICE_PERMISSION.resend.send;
      });
    }
    return await authorizeBackofficeFragmentRequest(kernel, requestContext, access, null);
  });
}

export type ResendFragment = ReturnType<typeof createResendServer>;
