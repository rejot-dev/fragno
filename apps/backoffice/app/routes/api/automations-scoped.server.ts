import type { RouterContextProvider } from "react-router";

import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import { requireBackofficeContext } from "@/fragno/auth/backoffice-principal.server";
import { automationScopeFromRouteParams } from "@/routes/backoffice/automations/scope";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

export type AutomationsScopedRouteParams = {
  scopeKind?: string;
  scopeId?: string;
  "*"?: string;
};

const applyAutomationScopeQuery = (url: URL, scope: BackofficeContextScope) => {
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

export const forwardToScopedAutomationsFragment = async ({
  request,
  context,
  params,
  mountRoute,
}: {
  request: Request;
  context: Readonly<RouterContextProvider>;
  params: AutomationsScopedRouteParams;
  mountRoute: "/api/automations" | "/api/automations-workflows";
}) => {
  const scope = automationScopeFromRouteParams(params);
  await requireBackofficeContext(request, context, scope);

  const { runtime } = context.get(BackofficeWorkerContext);
  const kernel = new BackofficeKernel(runtime);
  const automationsDo = kernel.scoped("AUTOMATIONS", scope, runtime.objects.automations);

  const url = new URL(request.url);
  const suffix = params["*"] ? `/${params["*"]}` : "";
  url.pathname = `${mountRoute}${suffix}`;
  applyAutomationScopeQuery(url, scope);

  return await automationsDo.fetch(new Request(url.toString(), request));
};
