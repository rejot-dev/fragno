import { createRouteCaller } from "@fragno-dev/core/api";
import type { RouterContextProvider } from "react-router";

import { getAutomationsDurableObject } from "@/cloudflare/cloudflare-utils";
import type {
  AutomationBindingCatalogEntry,
  AutomationScriptCatalogEntry,
  createAutomationFragment,
} from "@/fragno/automation";

type AutomationFragment = ReturnType<typeof createAutomationFragment>;

type AutomationIdLike =
  | string
  | {
      externalId?: string | null;
      id?: string | null;
    }
  | null
  | undefined;

export type AutomationScriptRecord = AutomationScriptCatalogEntry;
export type AutomationTriggerBindingRecord = AutomationBindingCatalogEntry;

export type AutomationIdentityBindingRecord = {
  id?: AutomationIdLike;
  source?: string | null;
  key?: string | null;
  value?: string | null;
  description?: string | null;
  status?: string | null;
  linkedAt?: string | Date | null;
  createdAt?: string | Date | null;
  updatedAt?: string | Date | null;
};

const isSuccessStatus = (status: number) => status >= 200 && status < 300;

const createAutomationsRouteCaller = (
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
) => {
  const automationsDo = getAutomationsDurableObject(context, orgId);
  return createRouteCaller<AutomationFragment>({
    baseUrl: request.url,
    mountRoute: "/api/automations/bindings",
    baseHeaders: request.headers,
    fetch: async (outboundRequest) => {
      const url = new URL(outboundRequest.url);
      url.searchParams.set("orgId", orgId);
      return automationsDo.fetch(new Request(url.toString(), outboundRequest));
    },
  });
};

const toRecordArray = <T extends Record<string, unknown>>(value: unknown): T[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is T => Boolean(item) && typeof item === "object");
};

export const toExternalId = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }

  if (!value || typeof value !== "object") {
    return "";
  }

  if ("externalId" in value && typeof value.externalId === "string") {
    return value.externalId;
  }

  if ("id" in value && typeof value.id === "string") {
    return value.id;
  }

  return "";
};

export async function fetchAutomationScripts(
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
): Promise<{
  scripts: AutomationScriptRecord[];
  scriptsError: string | null;
}> {
  try {
    const callRoute = createAutomationsRouteCaller(request, context, orgId);
    const response = await callRoute("GET", "/scripts");

    if (response.type === "json" && isSuccessStatus(response.status)) {
      return {
        scripts: toRecordArray<AutomationScriptRecord>(response.data),
        scriptsError: null,
      };
    }

    if (response.type === "error") {
      return { scripts: [], scriptsError: response.error.message };
    }

    return {
      scripts: [],
      scriptsError: `Failed to fetch automation scripts (${response.status}).`,
    };
  } catch (error) {
    return {
      scripts: [],
      scriptsError: error instanceof Error ? error.message : "Failed to load automation scripts.",
    };
  }
}

export async function fetchAutomationTriggerBindings(
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
): Promise<{
  bindings: AutomationTriggerBindingRecord[];
  bindingsError: string | null;
}> {
  try {
    const callRoute = createAutomationsRouteCaller(request, context, orgId);
    const response = await callRoute("GET", "/bindings");

    if (response.type === "json" && isSuccessStatus(response.status)) {
      return {
        bindings: toRecordArray<AutomationTriggerBindingRecord>(response.data),
        bindingsError: null,
      };
    }

    if (response.type === "error") {
      return { bindings: [], bindingsError: response.error.message };
    }

    return {
      bindings: [],
      bindingsError: `Failed to fetch automation trigger bindings (${response.status}).`,
    };
  } catch (error) {
    return {
      bindings: [],
      bindingsError:
        error instanceof Error ? error.message : "Failed to load automation trigger bindings.",
    };
  }
}

export async function fetchAutomationIdentityBindings(
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
): Promise<{
  identityBindings: AutomationIdentityBindingRecord[];
  identityBindingsError: string | null;
}> {
  try {
    const callRoute = createAutomationsRouteCaller(request, context, orgId);
    const response = await callRoute("GET", "/identity-bindings");

    if (response.type === "json" && isSuccessStatus(response.status)) {
      return {
        identityBindings: toRecordArray<AutomationIdentityBindingRecord>(response.data),
        identityBindingsError: null,
      };
    }

    if (response.type === "error") {
      return {
        identityBindings: [],
        identityBindingsError: response.error.message,
      };
    }

    return {
      identityBindings: [],
      identityBindingsError: `Failed to fetch identity bindings (${response.status}).`,
    };
  } catch (error) {
    return {
      identityBindings: [],
      identityBindingsError:
        error instanceof Error ? error.message : "Failed to load identity bindings.",
    };
  }
}

export async function revokeAutomationIdentityBinding(
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
  bindingId: string,
): Promise<{
  ok: boolean;
  error: string | null;
}> {
  try {
    const callRoute = createAutomationsRouteCaller(request, context, orgId);
    const response = await callRoute("POST", "/identity-bindings/:bindingId/revoke", {
      pathParams: { bindingId },
    });

    if (response.type === "json" && isSuccessStatus(response.status)) {
      return { ok: Boolean(response.data?.ok), error: null };
    }

    if (response.type === "error") {
      return { ok: false, error: response.error.message };
    }

    return {
      ok: false,
      error: `Failed to revoke identity binding (${response.status}).`,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Failed to revoke identity binding.",
    };
  }
}
