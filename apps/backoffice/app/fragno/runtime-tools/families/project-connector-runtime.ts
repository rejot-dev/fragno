import { createRouteCaller } from "@fragno-dev/core/api";
import type { projectConnectorConnectInputSchema } from "@fragno-dev/project-connector-fragment/contracts";
import type { z } from "zod";

import type { FetchObject } from "@/backoffice-runtime/object-registry";
import type { ProjectConnectorFragment } from "@/fragno/project-connector";
import type { ScopedPublicFragmentAddress } from "@/fragno/scoped-public-fragment-routes";

import { isSuccessStatus, throwOnRouteRuntimeError } from "../runtime-errors";

/** Calls only the user-owned fragment; tools cannot supply a user ID or OAuth return URL. */
export function createProjectConnectorRuntime(
  object: FetchObject,
  resolvePublicAddress: () => Promise<ScopedPublicFragmentAddress>,
) {
  const callRoute = createRouteCaller<ProjectConnectorFragment>({
    baseUrl: "https://project-connector.do",
    mountRoute: "/api/project-connector",
    fetch: (request) => object.fetch(request),
  });
  function fail(response: Awaited<ReturnType<typeof callRoute>>, label: string): never {
    return throwOnRouteRuntimeError(response, {
      runtimeLabel: "Connector",
      label,
      notConfiguredMessage: "Connector is not configured.",
    });
  }
  return {
    async listProviderConfigs() {
      const response = await callRoute("GET", "/provider-configs");
      if (response.type === "json" && isSuccessStatus(response.status)) {
        return response.data;
      }
      return fail(response, "connector.providers.list");
    },
    async listProviderActions({ providerConfigId }: { providerConfigId: string }) {
      const response = await callRoute("GET", "/provider-configs/:providerConfigId/actions", {
        pathParams: { providerConfigId },
      });
      if (response.type === "json" && isSuccessStatus(response.status)) {
        return response.data;
      }
      return fail(response, "connector.providers.actions");
    },
    async check() {
      const response = await callRoute("GET", "/status");
      if (response.type === "json" && isSuccessStatus(response.status)) {
        return response.data;
      }
      return fail(response, "connector.status");
    },
    async connect(
      input:
        | Omit<z.infer<(typeof projectConnectorConnectInputSchema.options)[0]>, "returnUri">
        | Omit<z.infer<(typeof projectConnectorConnectInputSchema.options)[1]>, "returnUri">,
    ) {
      const address = await resolvePublicAddress();
      const response = await callRoute("POST", "/connection-requests", {
        body: { ...input, returnUri: address.oauthRedirectUri },
      });
      if (response.type === "json" && isSuccessStatus(response.status)) {
        return response.data;
      }
      return fail(response, "connector.connect");
    },
    async refreshConnection({ requestId }: { requestId: string }) {
      const response = await callRoute("POST", "/connection-requests/:requestId/refresh", {
        pathParams: { requestId },
      });
      if (response.type === "json" && isSuccessStatus(response.status)) {
        return response.data;
      }
      return fail(response, "connector.connections.refresh");
    },
    async listAccounts({ cursor }: { cursor: string | null }) {
      const response = await callRoute("GET", "/accounts", { query: cursor ? { cursor } : {} });
      if (response.type === "json" && isSuccessStatus(response.status)) {
        return response.data;
      }
      return fail(response, "connector.accounts.list");
    },
    async getProfile({ accountId }: { accountId: string }) {
      const response = await callRoute("GET", "/accounts/:accountId/profile", {
        pathParams: { accountId },
      });
      if (response.type === "json" && isSuccessStatus(response.status)) {
        return response.data;
      }
      return fail(response, "connector.accounts.profile");
    },
    async executeAction({
      accountId,
      actionId,
      input,
    }: {
      accountId: string;
      actionId: string;
      input: Record<string, unknown>;
    }) {
      const response = await callRoute("POST", "/accounts/:accountId/actions/:actionId", {
        pathParams: { accountId, actionId },
        body: { input },
      });
      if (response.type === "json" && isSuccessStatus(response.status)) {
        return response.data;
      }
      return fail(response, "connector.actions.execute");
    },
  };
}

/** Runtime method results retain the fragment's authoritative route contracts. */
export type ProjectConnectorRuntime = ReturnType<typeof createProjectConnectorRuntime>;
