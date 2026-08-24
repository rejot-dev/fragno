import type { ApiObject } from "@/backoffice-runtime/object-registry";
import { backofficeRouteScopePath } from "@/backoffice-runtime/route-scope";
import type { PublicFragmentRoute } from "@/fragno/public-fragment-route.server";
import {
  API_INTERNAL_OAUTH_CALLBACK_PATH,
  API_INTERNAL_PREFIX,
  API_PUBLIC_PREFIX,
} from "@/fragno/scoped-public-fragment-routes";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

function isPublicWebhookReceiveRequest(request: Request, _scope: unknown, suffix: string) {
  if (request.method !== "GET" && request.method !== "POST") {
    return false;
  }
  if (!suffix.startsWith("/webhooks/endpoints/")) {
    return false;
  }
  const [endpointId, tail, ...rest] = suffix.slice("/webhooks/endpoints/".length).split("/");
  return Boolean(endpointId) && tail === "events" && rest.length === 0;
}

export const apiPublicRoute = {
  publicPrefix: API_PUBLIC_PREFIX,
  internalPrefix: API_INTERNAL_PREFIX,
  getObjectForScope: (context, scope) =>
    context.get(BackofficeWorkerContext).runtime.objects.api.for(scope),
  forwardRequest: ({ object, request }) => object.fetch(request),
  isAnonymousRequest: isPublicWebhookReceiveRequest,
  oauth: {
    internalCallbackPath: API_INTERNAL_OAUTH_CALLBACK_PATH,
    invalidResponse: (message) => new Response(message, { status: 502 }),
    redirect: ({ request, routeScope, status, code, message }) => {
      const redirectUrl = new URL(
        `/backoffice/automations/${backofficeRouteScopePath(routeScope)}/api`,
        request.url,
      );
      redirectUrl.searchParams.set("tab", "connections");
      redirectUrl.searchParams.set("oauth", status);

      const connectionSlug = new URL(request.url).searchParams.get("state")?.split(":")[0]?.trim();
      if (connectionSlug) {
        redirectUrl.searchParams.set("connection", connectionSlug);
      }
      if (code) {
        redirectUrl.searchParams.set("code", code);
      }
      if (message) {
        redirectUrl.searchParams.set("message", message);
      }

      return Response.redirect(redirectUrl, 302);
    },
  },
} satisfies PublicFragmentRoute<ApiObject>;
