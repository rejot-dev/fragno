import type { RouterContextProvider } from "react-router";

import { authorizeAccessTokenForOrganization } from "@/fragno/auth/access-token.server";
import { getAutomationsDurableObject } from "@/worker-runtime/durable-objects";

type AutomationsWorkflowsRouteParams = {
  orgId?: string;
  "*"?: string;
};

const forwardToOrganizationWorkflows = async (
  request: Request,
  context: Readonly<RouterContextProvider>,
  params: AutomationsWorkflowsRouteParams,
) => {
  if (!params.orgId) {
    return new Response("Missing organisation id", { status: 400 });
  }

  const auth = await authorizeAccessTokenForOrganization(request, context, params.orgId);
  if (!auth.ok) {
    return auth.response;
  }

  const url = new URL(request.url);
  const workflowPath = params["*"] ? `/${params["*"]}` : "";
  url.pathname = `/api/automations-workflows${workflowPath}`;
  url.searchParams.set("orgId", params.orgId);

  const automationsObject = getAutomationsDurableObject(context, params.orgId);
  const response = await automationsObject.fetch(new Request(url.toString(), request));
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
 * Authenticated organization-scoped proxy for the Automations Durable Object's workflows fragment.
 */
export async function loader({
  request,
  context,
  params,
}: {
  request: Request;
  context: Readonly<RouterContextProvider>;
  params: AutomationsWorkflowsRouteParams;
}) {
  return forwardToOrganizationWorkflows(request, context, params);
}

export async function action({
  request,
  context,
  params,
}: {
  request: Request;
  context: Readonly<RouterContextProvider>;
  params: AutomationsWorkflowsRouteParams;
}) {
  return forwardToOrganizationWorkflows(request, context, params);
}
