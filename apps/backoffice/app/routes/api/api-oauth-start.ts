import { API_OAUTH_REDIRECT_URI_QUERY_PARAMETER } from "@fragno-dev/api-fragment/types";

import { forwardPublicFragmentRequest } from "@/fragno/public-fragment-route.server";
import { apiPublicAddress } from "@/fragno/scoped-public-fragment-routes";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import type { Route } from "./+types/api-oauth-start";
import { apiPublicRoute } from "./api-route.server";

export async function action({ request, context, params }: Route.ActionArgs) {
  const url = new URL(request.url);
  url.searchParams.set(
    API_OAUTH_REDIRECT_URI_QUERY_PARAMETER,
    apiPublicAddress(
      context.get(BackofficeWorkerContext).runtime.config.docsPublicBaseUrl,
      params.scopeSegment,
    ).oauthRedirectUri,
  );
  return forwardPublicFragmentRequest({
    request: new Request(url, request),
    context,
    scopePathSegment: params.scopeSegment,
    route: apiPublicRoute,
  });
}
