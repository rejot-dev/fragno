import { createRouteCaller } from "@fragno-dev/core/api";

import type { WorkflowsFragment } from "@fragno-dev/workflows";

import type { AutomationsObject } from "@/backoffice-runtime/object-registry";

import type { createAutomationFragment } from "./index";

type AutomationFragment = ReturnType<typeof createAutomationFragment>;

type CreateAutomationsRouteCallerOptions = {
  object: AutomationsObject;
  orgId?: string;
};

const createAutomationsDoFetch =
  ({ object, orgId }: CreateAutomationsRouteCallerOptions) =>
  async (outboundRequest: Request) => {
    const url = new URL(outboundRequest.url);
    if (orgId) {
      url.searchParams.set("orgId", orgId);
    }
    return object.fetch(new Request(url.toString(), outboundRequest));
  };

export const createAutomationsRouteCaller = (
  options: CreateAutomationsRouteCallerOptions,
): ReturnType<typeof createRouteCaller<AutomationFragment>> =>
  createRouteCaller<AutomationFragment>({
    baseUrl: "https://automations.do",
    mountRoute: "/api/automations/bindings",
    fetch: createAutomationsDoFetch(options),
  });

export const createWorkflowsRouteCaller = (
  options: CreateAutomationsRouteCallerOptions,
): ReturnType<typeof createRouteCaller<WorkflowsFragment>> =>
  createRouteCaller<WorkflowsFragment>({
    baseUrl: "https://automations.do",
    mountRoute: "/api/automations",
    fetch: createAutomationsDoFetch(options),
  });
