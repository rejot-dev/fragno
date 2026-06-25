import { createRouteCaller } from "@fragno-dev/core/api";

import type { WorkflowsFragment } from "@fragno-dev/workflows";

import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import type { AutomationsObject } from "@/backoffice-runtime/object-registry";

import type { createAutomationFragment } from "./index";

type AutomationFragment = ReturnType<typeof createAutomationFragment>;

type CreateAutomationsRouteCallerOptions = {
  object: AutomationsObject;
  scope?: BackofficeContextScope;
};

const applyScopeQuery = (url: URL, scope: BackofficeContextScope) => {
  url.searchParams.set("scopeKind", scope.kind);
  if (scope.kind === "org" || scope.kind === "project") {
    url.searchParams.set("orgId", scope.orgId);
  }
  if (scope.kind === "project") {
    url.searchParams.set("projectId", scope.projectId);
  }
  if (scope.kind === "user") {
    url.searchParams.set("userId", scope.userId);
  }
};

const createAutomationsDoFetch =
  ({ object, scope }: CreateAutomationsRouteCallerOptions) =>
  async (outboundRequest: Request) => {
    const url = new URL(outboundRequest.url);
    if (scope) {
      applyScopeQuery(url, scope);
    }
    return object.fetch(new Request(url.toString(), outboundRequest));
  };

export const createAutomationsRouteCaller = (
  options: CreateAutomationsRouteCallerOptions,
): ReturnType<typeof createRouteCaller<AutomationFragment>> =>
  createRouteCaller<AutomationFragment>({
    baseUrl: "https://automations.do",
    mountRoute: "/api/automations",
    fetch: createAutomationsDoFetch(options),
  });

export const createWorkflowsRouteCaller = (
  options: CreateAutomationsRouteCallerOptions,
): ReturnType<typeof createRouteCaller<WorkflowsFragment>> =>
  createRouteCaller<WorkflowsFragment>({
    baseUrl: "https://automations.do",
    mountRoute: "/api/automations-workflows",
    fetch: createAutomationsDoFetch(options),
  });
