import { getGitHubDurableObject } from "@/worker-runtime/durable-objects";

import type { Route } from "./+types/github";
import { requireApiOrganization } from "./organization.server";

const forwardToGitHub = async (
  request: Request,
  context: Route.LoaderArgs["context"],
  orgSlug: string | undefined,
) => {
  const organization = await requireApiOrganization(request, context, orgSlug);
  const orgId = organization.id;

  const githubDo = getGitHubDurableObject(context, orgId);
  const url = new URL(request.url);
  const prefix = `/api/github/${orgSlug}`;
  if (url.pathname.startsWith(prefix)) {
    const suffix = url.pathname.slice(prefix.length);
    url.pathname = `/api/github${suffix}`;
  }
  url.searchParams.set("orgId", orgId);

  const proxyRequest = new Request(url.toString(), request);
  return githubDo.http.fetch(proxyRequest);
};

/**
 * Catch-all route that forwards all /api/github/:orgSlug/* requests to the GitHub Durable Object.
 * The org-specific prefix is stripped before the request reaches the fragment.
 */
export async function loader({ request, context, params }: Route.LoaderArgs) {
  return forwardToGitHub(request, context, params.orgSlug);
}

export async function action({ request, context, params }: Route.ActionArgs) {
  return forwardToGitHub(request, context, params.orgSlug);
}
