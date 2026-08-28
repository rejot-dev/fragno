import { API_OAUTH_REDIRECT_URI_QUERY_PARAMETER } from "@fragno-dev/api-fragment/types";

import type { ApiObject } from "@/backoffice-runtime/object-registry";
import {
  forwardPublicFragmentRequest,
  type PublicFragmentRoute,
} from "@/fragno/public-fragment-route.server";
import { apiPublicAddress } from "@/fragno/scoped-public-fragment-routes";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import type { Route } from "./+types/api-oauth-start";
import { apiPublicRoute } from "./api-route.server";

const apiOAuthStartPublicRoute = {
  ...apiPublicRoute,
  forwardRequest: function forwardApiOAuthStart({ context, object, request, scopePathSegment }) {
    const publicOrigin = context.get(BackofficeWorkerContext).runtime.config.docsPublicBaseUrl;
    const internalUrl = new URL(request.url);
    internalUrl.searchParams.set(
      API_OAUTH_REDIRECT_URI_QUERY_PARAMETER,
      apiPublicAddress(publicOrigin, scopePathSegment).oauthRedirectUri,
    );
    return object.http.fetch(new Request(internalUrl, request));
  },
} satisfies PublicFragmentRoute<ApiObject>;

export async function action({ request, context, params }: Route.ActionArgs) {
  return forwardPublicFragmentRequest({
    request,
    context,
    scopePathSegment: params.scopeSegment,
    route: apiOAuthStartPublicRoute,
  });
}
