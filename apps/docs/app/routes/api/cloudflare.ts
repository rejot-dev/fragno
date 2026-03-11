import type { Route } from "./+types/cloudflare";
import { getCloudflareWorkersDurableObject } from "@/cloudflare/cloudflare-utils";

const forwardToCloudflare = async (
  request: Request,
  context: Route.LoaderArgs["context"],
  orgId: string | undefined,
) => {
  if (!orgId) {
    return new Response("Missing organisation id", { status: 400 });
  }

  const cloudflareDo = getCloudflareWorkersDurableObject(context, orgId);
  const url = new URL(request.url);
  const prefix = `/api/cloudflare/${orgId}`;
  if (url.pathname.startsWith(prefix)) {
    const suffix = url.pathname.slice(prefix.length);
    url.pathname = `/api/cloudflare${suffix}`;
  }
  url.searchParams.set("orgId", orgId);

  const proxyRequest = new Request(url.toString(), request);
  return cloudflareDo.fetch(proxyRequest);
};

/**
 * Catch-all route that forwards all /api/cloudflare/:orgId/* requests to the Cloudflare Workers
 * Durable Object. The org-specific prefix is stripped before the request reaches the fragment.
 */
export async function loader({ request, context, params }: Route.LoaderArgs) {
  return forwardToCloudflare(request, context, params.orgId);
}

export async function action({ request, context, params }: Route.ActionArgs) {
  return forwardToCloudflare(request, context, params.orgId);
}
