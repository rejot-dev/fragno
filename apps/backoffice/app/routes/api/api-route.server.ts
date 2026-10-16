import type { ApiObject } from "@/backoffice-runtime/object-registry";
import type { PublicFragmentRoute } from "@/fragno/public-fragment-route.server";
import { encodeApiConnectionId } from "@/fragno/runtime-tools/families/integrations/api-integration";
import {
  API_INTERNAL_OAUTH_CALLBACK_PATH,
  API_INTERNAL_PREFIX,
  API_PUBLIC_PREFIX,
} from "@/fragno/scoped-public-fragment-routes";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import { integrationOAuthReturn } from "../backoffice/integrations/connection-paths";

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
  publicIngress: { kind: "fragment", matches: isPublicWebhookReceiveRequest },
  oauth: {
    internalCallbackPath: API_INTERNAL_OAUTH_CALLBACK_PATH,
    invalidResponse: (message) => new Response(message, { status: 502 }),
    redirect: ({ request, pageScope, status, code, message }) => {
      const slug = new URL(request.url).searchParams.get("state")?.split(":")[0]?.trim();
      return integrationOAuthReturn({
        request,
        routeScope: pageScope,
        connectionId: slug ? encodeApiConnectionId(slug) : null,
        outcome:
          status === "success"
            ? { status }
            : {
                status,
                message: message ? (code ? `${message} (${code})` : message) : (code ?? null),
              },
      });
    },
  },
} satisfies PublicFragmentRoute<ApiObject>;
