import { authorizeAccessTokenForOrganization } from "@/fragno/auth/access-token.server";
import { getPiDurableObject } from "@/worker-runtime/durable-objects";

import type { Route } from "./+types/pi";

const forwardToPi = async (
  request: Request,
  context: Route.LoaderArgs["context"],
  orgId: string | undefined,
) => {
  if (!orgId) {
    return new Response("Missing organisation id", { status: 400 });
  }

  const auth = await authorizeAccessTokenForOrganization(request, context, orgId);
  if (!auth.ok) {
    return auth.response;
  }

  const piDo = getPiDurableObject(context, orgId);
  const url = new URL(request.url);
  const prefix = `/api/pi/${orgId}`;
  if (url.pathname.startsWith(prefix)) {
    const suffix = url.pathname.slice(prefix.length);
    url.pathname = `/api/pi${suffix}`;
  }
  url.searchParams.set("orgId", orgId);

  const proxyRequest = new Request(url.toString(), request);
  const response = await piDo.fetch(proxyRequest);
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
 * Catch-all route that forwards all /api/pi/:orgId/* requests to the Pi Durable Object.
 * The org-specific prefix is stripped before the request reaches the fragment.
 */
export async function loader({ request, context, params }: Route.LoaderArgs) {
  return forwardToPi(request, context, params.orgId);
}

export async function action({ request, context, params }: Route.ActionArgs) {
  return forwardToPi(request, context, params.orgId);
}
