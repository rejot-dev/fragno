import System from "typebox/system";
import * as serverBuild from "virtual:react-router/server-build";

import { isBackofficeApiPath } from "../app/backoffice-api/api-path";
import { BackofficeKernel } from "../app/backoffice-runtime/kernel";
import { createCloudflareBackofficeRuntimeServices } from "../app/backoffice-runtime/runtime-services";
import { BackofficePostHogContext, captureBackofficeServerException } from "../app/posthog.server";
import { createBackofficeRouterContextProvider } from "../app/worker-runtime/router-context-provider.server";
import { createLazyRequestHandler } from "./lazy-request-handler";
import { createCloudflarePostHog, shutdownCloudflarePostHog } from "./lib/cloudflare-posthog";

System.Settings.Set({ useAcceleration: false });

const requestHandler = createLazyRequestHandler(serverBuild, import.meta.env.MODE);
// Imported on the first API request, so a cold Worker serving pages does not compile the API.
const loadBackofficeApiRouter = async () =>
  (await import("../app/backoffice-api/backoffice-api-router")).backofficeApiRouter;

export default {
  async fetch(request, env, ctx) {
    const requestId = crypto.randomUUID();

    return ctx.tracing.enterSpan("backoffice.request", async (span) => {
      span.setAttribute("backoffice.request_id", requestId);

      const runtime = createCloudflareBackofficeRuntimeServices(env);
      const kernel = new BackofficeKernel(runtime);
      const context = createBackofficeRouterContextProvider(request, {
        runtime,
        kernel,
        env,
        ctx,
      });
      const client = await createCloudflarePostHog(env);
      context.set(
        BackofficePostHogContext,
        client
          ? {
              client,
              requestId,
              userId: null,
              route: null,
              scope: null,
              capturedErrors: new WeakSet<Error>(),
              waitUntil: (promise) => {
                ctx.waitUntil(promise);
              },
            }
          : null,
      );
      const analytics = context.get(BackofficePostHogContext);
      const startedAt = performance.now();
      let statusCode = 500;

      try {
        const response = isBackofficeApiPath(new URL(request.url).pathname)
          ? await (await loadBackofficeApiRouter()).fetch(request, { runtime, kernel })
          : await requestHandler(request, context);
        statusCode = response.status;
        // A socket travels only with the response that accepted it, so it cannot be rebuilt.
        if (response.webSocket) {
          return response;
        }
        const headers = new Headers(response.headers);
        headers.set("backoffice-request-id", requestId);

        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      } catch (error) {
        if (!request.signal.aborted) {
          captureBackofficeServerException(context, error);
        }
        throw error;
      } finally {
        if (analytics) {
          try {
            analytics.client.capture({
              distinctId: analytics.userId ?? requestId,
              event: "backoffice_request_completed",
              properties: {
                request_id: requestId,
                source: "cloudflare-worker",
                release: env.CF_VERSION_METADATA.id,
                route: analytics.route,
                scope: analytics.scope?.scope ?? null,
                scope_kind: analytics.scope?.scopeKind ?? null,
                organization_id: analytics.scope?.orgId ?? null,
                ...(analytics.scope?.orgId
                  ? { $groups: { organization: analytics.scope.orgId } }
                  : {}),
                http_method: request.method,
                status_code: statusCode,
                handler_duration_ms: performance.now() - startedAt,
                aborted: request.signal.aborted,
                $process_person_profile: false,
              },
            });
          } catch {
            console.warn("PostHog backend request capture failed.");
          }
          ctx.waitUntil(shutdownCloudflarePostHog(analytics.client));
        }
      }
    });
  },
} satisfies ExportedHandler<CloudflareEnv>;
