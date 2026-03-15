import { getPiDurableObject } from "@/cloudflare/cloudflare-utils";

import type { Route } from "./+types/workflows";

const forwardToWorkflows = async (
  request: Request,
  context: Route.LoaderArgs["context"],
  orgId: string | undefined,
) => {
  if (!orgId) {
    return new Response("Missing organisation id", { status: 400 });
  }

  const piDo = getPiDurableObject(context, orgId);
  const url = new URL(request.url);
  const prefix = `/api/workflows/${orgId}`;
  if (url.pathname.startsWith(prefix)) {
    const suffix = url.pathname.slice(prefix.length);
    url.pathname = `/api/workflows${suffix}`;
  }
  url.searchParams.set("orgId", orgId);

  const proxyRequest = new Request(url.toString(), request);
  return piDo.fetch(proxyRequest);
};

/**
 * Catch-all route that forwards all /api/workflows/:orgId/* requests to the Pi Durable Object.
 * The org-specific prefix is stripped before the request reaches the workflows fragment.
 */
export async function loader({ request, context, params }: Route.LoaderArgs) {
  return forwardToWorkflows(request, context, params.orgId);
}

export async function action({ request, context, params }: Route.ActionArgs) {
  return forwardToWorkflows(request, context, params.orgId);
}
