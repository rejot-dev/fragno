import { createRouteCaller } from "@fragno-dev/core/api";

import type { WorkflowsFragment } from "@fragno-dev/workflows";

import type { createAutomationFragment } from "./index";

type AutomationFragment = ReturnType<typeof createAutomationFragment>;

const createAutomationsDoFetch = (env: CloudflareEnv, orgId: string) => {
  const automationsDo = env.AUTOMATIONS.get(env.AUTOMATIONS.idFromName(orgId));
  return async (outboundRequest: Request) => {
    const url = new URL(outboundRequest.url);
    url.searchParams.set("orgId", orgId);
    return automationsDo.fetch(new Request(url.toString(), outboundRequest));
  };
};

export const createAutomationsRouteCaller = (
  env: CloudflareEnv,
  orgId: string,
): ReturnType<typeof createRouteCaller<AutomationFragment>> =>
  createRouteCaller<AutomationFragment>({
    baseUrl: "https://automations.do",
    mountRoute: "/api/automations/bindings",
    fetch: createAutomationsDoFetch(env, orgId),
  });

export const createWorkflowsRouteCaller = (
  env: CloudflareEnv,
  orgId: string,
): ReturnType<typeof createRouteCaller<WorkflowsFragment>> =>
  createRouteCaller<WorkflowsFragment>({
    baseUrl: "https://automations.do",
    mountRoute: "/api/automations",
    fetch: createAutomationsDoFetch(env, orgId),
  });
