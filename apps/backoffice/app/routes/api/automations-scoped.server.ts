import type { RouterContextProvider } from "react-router";

import { requireBackofficeContext } from "@/fragno/auth/backoffice-principal.server";
import { isAutomationOutboxPath } from "@/fragno/automation/route-callers";
import { automationScopeFromRouteParams } from "@/routes/backoffice/automations/scope";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

export type AutomationsScopedRouteParams = {
  scopeKind?: string;
  scopeId?: string;
  "*"?: string;
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
  mountRoute: "/api/automations";
}) => {
  const scope = automationScopeFromRouteParams(params);
  const execution = await requireBackofficeContext(request, context, scope);

  const suffix = params["*"] ? `/${params["*"]}` : "";
  if (mountRoute === "/api/automations" && !isAutomationOutboxPath(suffix)) {
    return new Response("Not Found", { status: 404 });
  }

  const { runtime, kernel } = context.get(BackofficeWorkerContext);
  const automationsDo = kernel.scoped("AUTOMATIONS", scope, runtime.objects.automations);

  const url = new URL(request.url);
  url.pathname = `${mountRoute}${suffix}`;

  return await automationsDo.fetchWithContext(new Request(url.toString(), request), {
    execution,
    propagationContext: null,
  });
};
