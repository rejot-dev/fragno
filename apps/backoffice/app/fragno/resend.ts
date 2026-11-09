import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";

import { createResendFragment, type ResendFragmentConfig } from "@fragno-dev/resend-fragment";

import {
  authorizeBackofficeFragmentRequest,
  type BackofficeFragmentHttpAccess,
} from "@/backoffice-runtime/fragment-http-authorization";
import type { BackofficeFragmentRuntimeOptions } from "@/backoffice-runtime/fragment-runtime";
import type { BackofficeKernel } from "@/backoffice-runtime/kernel";

export type ResendConfig = Pick<
  ResendFragmentConfig,
  "apiKey" | "webhookSecret" | "defaultFrom" | "defaultReplyTo" | "defaultTags" | "defaultHeaders"
>;

/**
 * The callbacks are null for accounts without people's inbound addresses, whose received mail
 * reaches no one but their threads.
 */
export function createResendServer(
  config: ResendConfig,
  {
    client,
    onEmailReceived,
    onMailboxChanged,
    onMailboxEmailQueued,
    onEmailStatusUpdated,
  }: {
    client: ResendFragmentConfig["client"];
    onEmailReceived: ResendFragmentConfig["onEmailReceived"] | null;
    onMailboxChanged: ResendFragmentConfig["onMailboxChanged"] | null;
    onMailboxEmailQueued: ResendFragmentConfig["onMailboxEmailQueued"] | null;
    onEmailStatusUpdated: ResendFragmentConfig["onEmailStatusUpdated"] | null;
  },
  runtime: BackofficeFragmentRuntimeOptions,
  kernel: BackofficeKernel,
): ReturnType<typeof createResendFragment> {
  return createResendFragment(
    {
      ...config,
      client,
      onEmailReceived: onEmailReceived ?? undefined,
      onMailboxChanged: onMailboxChanged ?? undefined,
      onMailboxEmailQueued: onMailboxEmailQueued ?? undefined,
      onEmailStatusUpdated: onEmailStatusUpdated ?? undefined,
    },
    {
      databaseAdapter: runtime.adapters.createAdapter({
        kind: "resend",
      }),
      mountRoute: "/api/resend",
    },
  ).withMiddleware(async function authorizeResendRoutes({ ifMatchesRoute, requestContext }) {
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
        access = BACKOFFICE_PERMISSION.integrations.execute;
      });
    }
    for (const path of ["/emails", "/threads", "/threads/:threadId/reply"] as const) {
      await ifMatchesRoute("POST", path, () => {
        access = BACKOFFICE_PERMISSION.integrations.execute;
      });
    }
    return await authorizeBackofficeFragmentRequest(kernel, requestContext, access, null);
  });
}

export type ResendFragment = ReturnType<typeof createResendServer>;
