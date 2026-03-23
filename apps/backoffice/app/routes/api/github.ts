import { getGitHubDurableObject } from "@/cloudflare/cloudflare-utils";

import type { Route } from "./+types/github";

const forwardToGitHub = async (
  request: Request,
  context: Route.LoaderArgs["context"],
  orgId: string | undefined,
) => {
  if (!orgId) {
    return new Response("Missing organisation id", { status: 400 });
  }

  const githubDo = getGitHubDurableObject(context, orgId);
  const url = new URL(request.url);
  const prefix = `/api/github/${orgId}`;
  if (url.pathname.startsWith(prefix)) {
    const suffix = url.pathname.slice(prefix.length);
    url.pathname = `/api/github${suffix}`;
  }
  url.searchParams.set("orgId", orgId);

  const proxyRequest = new Request(url.toString(), request);
  return githubDo.fetch(proxyRequest);
};

/**
 * Catch-all route that forwards all /api/github/:orgId/* requests to the GitHub Durable Object.
 * The org-specific prefix is stripped before the request reaches the fragment.
 */
export async function loader({ request, context, params }: Route.LoaderArgs) {
  return forwardToGitHub(request, context, params.orgId);
}

export async function action({ request, context, params }: Route.ActionArgs) {
  return forwardToGitHub(request, context, params.orgId);
}
