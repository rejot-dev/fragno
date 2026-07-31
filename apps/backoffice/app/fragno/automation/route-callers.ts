import { createRouteCaller } from "@fragno-dev/core/api";

import type { WorkflowsFragment } from "@fragno-dev/workflows";

import type {
  AutomationsObject,
  BackofficeActionRpcContext,
} from "@/backoffice-runtime/object-registry";

import type { createAutomationFragment } from "./index";

type AutomationFragment = ReturnType<typeof createAutomationFragment>;

type CreateAutomationsRouteCallerOptions = {
  object: AutomationsObject;
  context?: BackofficeActionRpcContext;
};

export const isAutomationOutboxPath = (path: string) =>
  path === "/_internal" || path.startsWith("/_internal/");

const createAutomationsDoFetch =
  ({ object, context }: CreateAutomationsRouteCallerOptions) =>
  (request: Request) =>
    context ? object.fetchWithContext(request, context) : object.fetch(request);

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
