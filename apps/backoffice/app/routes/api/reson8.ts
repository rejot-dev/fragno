import type { LoaderFunctionArgs } from "react-router";

import { getReson8DurableObject } from "@/cloudflare/cloudflare-utils";

const forwardToReson8 = async (
  request: Request,
  context: LoaderFunctionArgs["context"],
  orgId: string | undefined,
) => {
  if (!orgId) {
    return new Response("Missing organisation id", { status: 400 });
  }

  const reson8Do = getReson8DurableObject(context, orgId);
  const url = new URL(request.url);
  const prefix = `/api/reson8/${orgId}`;
  if (url.pathname.startsWith(prefix)) {
    const suffix = url.pathname.slice(prefix.length);
    url.pathname = `/api/reson8${suffix}`;
  }
  url.searchParams.set("orgId", orgId);

  const proxyRequest = new Request(url.toString(), request);
  return reson8Do.fetch(proxyRequest);
};

/**
 * Catch-all route that forwards all /api/reson8/:orgId/* requests to the Reson8 Durable Object.
 * The org-specific prefix is stripped before the request reaches the fragment.
 */
export async function loader({ request, context, params }: LoaderFunctionArgs) {
  return forwardToReson8(request, context, params.orgId);
}

export async function action({ request, context, params }: LoaderFunctionArgs) {
  return forwardToReson8(request, context, params.orgId);
}
