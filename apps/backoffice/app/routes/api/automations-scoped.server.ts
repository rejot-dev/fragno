import type { RouterContextProvider } from "react-router";

import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import { removeBackofficeInternalContextHeader } from "@/backoffice-runtime/internal-object-request";
import {
  backofficeObjectScopeFromContextScope,
  encodeBackofficeObjectAddress,
} from "@/backoffice-runtime/object-registry";
import { forwardRequestOwnedResponse } from "@/backoffice-runtime/request-owned-response";
import { requireBackofficeContextScopeFromRouteParams } from "@/backoffice-runtime/scope-codec";
import { requireBackofficeContext } from "@/fragno/auth/backoffice-principal.server";
import { isAutomationOutboxPath } from "@/fragno/automation/route-callers";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

export type AutomationsScopedRouteParams = {
  scopeKind?: string;
  scopeId?: string;
  "*"?: string;
};

function getScopedAutomationsDurableObject(env: CloudflareEnv, scope: BackofficeContextScope) {
  const objectName = encodeBackofficeObjectAddress({
    binding: "AUTOMATIONS",
    scope: backofficeObjectScopeFromContextScope(scope),
  });
  return env.AUTOMATIONS.get(env.AUTOMATIONS.idFromName(objectName));
}

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
  const scope = requireBackofficeContextScopeFromRouteParams(params);
  await requireBackofficeContext(request, context, scope);

  const suffix = params["*"] ? `/${params["*"]}` : "";
  if (mountRoute === "/api/automations" && !isAutomationOutboxPath(suffix)) {
    return new Response("Not Found", { status: 404 });
  }

  const { env } = context.get(BackofficeWorkerContext);
  const automationsDo = getScopedAutomationsDurableObject(env, scope);

  const url = new URL(request.url);
  url.pathname = `${mountRoute}${suffix}`;

  // A streaming Response returned through an RpcTarget keeps the JSRPC invocation alive for the
  // body lifetime. Forward outbox streams through the Durable Object fetch boundary so their
  // automatic storage spans remain owned by the stream request's trace.
  return forwardRequestOwnedResponse(
    request,
    await automationsDo.fetch(
      removeBackofficeInternalContextHeader(new Request(url.toString(), request)),
    ),
  );
};
