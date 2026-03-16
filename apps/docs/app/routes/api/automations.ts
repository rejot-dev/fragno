import type { RouterContextProvider } from "react-router";

import { getAutomationsDurableObject } from "@/cloudflare/cloudflare-utils";

const forwardToAutomations = async (
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string | undefined,
) => {
  if (!orgId) {
    return new Response("Missing organisation id", { status: 400 });
  }

  const automationsDo = getAutomationsDurableObject(context, orgId);
  const url = new URL(request.url);
  const prefix = `/api/automations/${orgId}`;
  if (url.pathname.startsWith(prefix)) {
    const suffix = url.pathname.slice(prefix.length);
    url.pathname = `/api/automations${suffix}`;
  }
  url.searchParams.set("orgId", orgId);

  const proxyRequest = new Request(url.toString(), request);
  return automationsDo.fetch(proxyRequest);
};

/**
 * Catch-all route that forwards all /api/automations/:orgId/* requests to the Automations Durable Object.
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
