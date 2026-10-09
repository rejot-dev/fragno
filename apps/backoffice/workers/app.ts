import { createRequestHandler } from "react-router";
import System from "typebox/system";
import * as serverBuild from "virtual:react-router/server-build";

import {
  backofficeApiRouter,
  isBackofficeApiPath,
} from "../app/backoffice-api/backoffice-api-router";
import { BackofficeKernel } from "../app/backoffice-runtime/kernel";
import { createCloudflareBackofficeRuntimeServices } from "../app/backoffice-runtime/runtime-services";
import { BackofficePostHogContext, captureBackofficeServerException } from "../app/posthog.server";
import { createBackofficeRouterContextProvider } from "../app/worker-runtime/router-context-provider.server";
import { createCloudflarePostHog, shutdownCloudflarePostHog } from "./lib/cloudflare-posthog";

System.Settings.Set({ useAcceleration: false });

const requestHandler = createRequestHandler(serverBuild, import.meta.env.MODE);

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
          ? await backofficeApiRouter.fetch(request, { runtime, kernel })
          : await requestHandler(request, context);
        statusCode = response.status;
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
