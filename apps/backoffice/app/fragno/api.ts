import type { ApiFragmentConfig } from "@fragno-dev/api-fragment/definition";
import { createApiFragment } from "@fragno-dev/api-fragment/server";

import type { BackofficeFragmentRuntimeOptions } from "@/backoffice-runtime/fragment-runtime";

export type ApiConfig = Pick<
  ApiFragmentConfig,
  | "publicBaseUrl"
  | "allowedBaseUrls"
  | "onConnectionChanged"
  | "onConnectionDeleted"
  | "onConnectionAvailable"
  | "onWebhookEndpointChanged"
  | "onWebhookReceived"
>;

export function createApiServer(
  config: ApiConfig,
  runtime: BackofficeFragmentRuntimeOptions,
): ReturnType<typeof createApiFragment> {
  return createApiFragment(
    {
      publicBaseUrl: config.publicBaseUrl,
      allowedBaseUrls: config.allowedBaseUrls,
      onConnectionChanged: config.onConnectionChanged,
      onConnectionDeleted: config.onConnectionDeleted,
      onConnectionAvailable: config.onConnectionAvailable,
      onWebhookEndpointChanged: config.onWebhookEndpointChanged,
      onWebhookReceived: config.onWebhookReceived,
    },
    {
      databaseAdapter: runtime.adapters.createAdapter({
        kind: "api",
      }),
      mountRoute: "/api/api",
    },
  );
}

export type ApiFragment = ReturnType<typeof createApiServer>;
