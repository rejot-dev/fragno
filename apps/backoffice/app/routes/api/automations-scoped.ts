import type { RouterContextProvider } from "react-router";

import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import { requireBackofficeContext } from "@/fragno/auth/backoffice-principal.server";
import { automationScopeFromRouteParams } from "@/routes/backoffice/automations/scope";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

const AUTOMATIONS_MOUNT = "/api/automations";

type AutomationsScopedRouteParams = {
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

const forwardToScopedAutomations = async (
  request: Request,
  context: Readonly<RouterContextProvider>,
  params: AutomationsScopedRouteParams,
) => {
  const scope = automationScopeFromRouteParams(params);
  await requireBackofficeContext(request, context, scope);

  const { runtime } = context.get(BackofficeWorkerContext);
  const kernel = new BackofficeKernel({ objects: runtime.objects });
  const automationsDo = kernel.scoped("AUTOMATIONS", scope, runtime.objects.automations);

  const url = new URL(request.url);
  const suffix = params["*"] ? `/${params["*"]}` : "";
  url.pathname = `${AUTOMATIONS_MOUNT}${suffix}`;
  applyAutomationScopeQuery(url, scope);

  return await automationsDo.fetch(new Request(url.toString(), request));
};

/**
 * Authenticated catch-all route for browser clients that need a scope-aware automations outbox.
 */
export async function loader({
  request,
  context,
  params,
}: {
  request: Request;
  context: Readonly<RouterContextProvider>;
  params: AutomationsScopedRouteParams;
}) {
  return forwardToScopedAutomations(request, context, params);
}

export async function action({
  request,
  context,
  params,
}: {
  request: Request;
  context: Readonly<RouterContextProvider>;
  params: AutomationsScopedRouteParams;
}) {
  return forwardToScopedAutomations(request, context, params);
}
