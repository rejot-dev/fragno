import type { RouterContextProvider } from "react-router";

import { authorizeAccessTokenForOrganization } from "@/fragno/auth/access-token.server";
import { getAutomationsDurableObject } from "@/worker-runtime/durable-objects";

const forwardToAutomations = async (
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string | undefined,
) => {
  if (!orgId) {
    return new Response("Missing organisation id", { status: 400 });
  }

  const auth = await authorizeAccessTokenForOrganization(request, context, orgId);
  if (!auth.ok) {
    return auth.response;
  }

  const automationsDo = getAutomationsDurableObject(context, orgId);
  const url = new URL(request.url);
  const publicMount = url.pathname.startsWith(`/api/automations-workflows/${orgId}`)
    ? "/api/automations-workflows"
    : "/api/automations";
  const prefix = `${publicMount}/${orgId}`;
  if (url.pathname.startsWith(prefix)) {
    const suffix = url.pathname.slice(prefix.length);
    url.pathname = `${publicMount}${suffix}`;
  }
  url.searchParams.set("orgId", orgId);

  const proxyRequest = new Request(url.toString(), request);
  const response = await automationsDo.fetch(proxyRequest);
  if (auth.headers.length === 0) {
    return response;
  }

  const headers = new Headers(response.headers);
  for (const [name, value] of auth.headers) {
    headers.append(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

/**
 * Catch-all route that forwards org-scoped automation fragment requests to the Automations Durable Object.
 * The org-specific prefix is stripped before the request reaches the fragment.
 */
export async function loader({
  request,
  context,
  params,
}: {
  request: Request;
  context: Readonly<RouterContextProvider>;
  params: { orgId?: string };
}) {
  return forwardToAutomations(request, context, params.orgId);
}

export async function action({
  request,
  context,
  params,
}: {
  request: Request;
  context: Readonly<RouterContextProvider>;
  params: { orgId?: string };
}) {
  return forwardToAutomations(request, context, params.orgId);
}
