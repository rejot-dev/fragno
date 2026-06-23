import type { ApiFragmentConfig } from "@fragno-dev/api-fragment/definition";

import { createApiFragment } from "@fragno-dev/api-fragment";

import type { BackofficeFragmentRuntimeOptions } from "@/backoffice-runtime/fragment-runtime";

export type ApiConfig = Pick<
  ApiFragmentConfig,
  | "publicBaseUrl"
  | "allowedBaseUrls"
  | "onConnectionChanged"
  | "onConnectionDeleted"
  | "onConnectionAvailable"
  | "onWebhookReceived"
>;

export const resolveApiPublicBaseUrl = ({ baseUrl, orgId }: { baseUrl: string; orgId: string }) => {
  const parsed = new URL(baseUrl);
  const mountPath = `/api/http/${orgId}`;
  const trimmedPath = parsed.pathname.replace(/\/+$/, "");
  if (trimmedPath !== mountPath) {
    parsed.pathname = `${trimmedPath}${mountPath}`.replace(/\/+/g, "/");
  }
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/+$/, "");
};

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
