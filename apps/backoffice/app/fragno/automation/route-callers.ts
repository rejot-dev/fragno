import { createRouteCaller } from "@fragno-dev/core/api";

import type { WorkflowsFragment } from "@fragno-dev/workflows";

import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";

import type { createAutomationFragment } from "./index";

type AutomationFragment = ReturnType<typeof createAutomationFragment>;

type CreateAutomationsRouteCallerOptions = {
  objects: BackofficeObjectRegistry;
  orgId: string;
};

const createAutomationsDoFetch = (options: CreateAutomationsRouteCallerOptions) => {
  const { objects, orgId } = options;
  const automationsDo = objects.automations.forOrg(orgId);
  return async (outboundRequest: Request) => {
    const url = new URL(outboundRequest.url);
    url.searchParams.set("orgId", orgId);
    return automationsDo.fetch(new Request(url.toString(), outboundRequest));
  };
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
