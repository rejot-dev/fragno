import {
  handleBackofficeApiOAuthCallback,
  isBackofficeApiOAuthCallbackRequest,
} from "@/fragno/api-oauth-proxy";
import { authorizeAccessTokenForOrganization } from "@/fragno/auth/access-token.server";
import { getApiDurableObject } from "@/worker-runtime/durable-objects";

import type { Route } from "./+types/api";

type RouteContext = Route.LoaderArgs["context"];

const API_INTERNAL_PREFIX = "/api/api";
const API_PUBLIC_PREFIX = "/api/http";

const forwardToApi = async (request: Request, context: RouteContext, orgId: string | undefined) => {
  if (!orgId) {
    return new Response("Missing organisation id", { status: 400 });
  }

  if (isBackofficeApiOAuthCallbackRequest(request, orgId)) {
    return handleBackofficeApiOAuthCallback(request, context, orgId);
  }

  const auth = await authorizeAccessTokenForOrganization(request, context, orgId);
  if (!auth.ok) {
    return auth.response;
  }

  const apiDo = getApiDurableObject(context, orgId);
  const url = new URL(request.url);
  const prefix = `${API_PUBLIC_PREFIX}/${orgId}`;
  if (url.pathname.startsWith(prefix)) {
    const suffix = url.pathname.slice(prefix.length);
    url.pathname = `${API_INTERNAL_PREFIX}${suffix}`;
  }
  url.searchParams.set("orgId", orgId);

  const response = await apiDo.fetch(new Request(url.toString(), request));
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

export async function loader({ request, context, params }: Route.LoaderArgs) {
  return forwardToApi(request, context, params.orgId);
}

export async function action({ request, context, params }: Route.ActionArgs) {
  return forwardToApi(request, context, params.orgId);
}
