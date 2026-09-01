import { createRequestHandler, RouterContextProvider } from "react-router";
import System from "typebox/system";
import * as serverBuild from "virtual:react-router/server-build";

import { BackofficeKernel } from "../app/backoffice-runtime/kernel";
import { createCloudflareBackofficeRuntimeServices } from "../app/backoffice-runtime/runtime-services";
import { BackofficeWorkerContext } from "../app/worker-runtime/router-context";

System.Settings.Set({ useAcceleration: false });

const requestHandler = createRequestHandler(serverBuild, import.meta.env.MODE);

export default {
  async fetch(request, env, ctx) {
    const requestId = crypto.randomUUID();

    return ctx.tracing.enterSpan("backoffice.request", async (span) => {
      span.setAttribute("backoffice.request_id", requestId);

      const runtime = createCloudflareBackofficeRuntimeServices(env);
      const context = new RouterContextProvider();
      context.set(BackofficeWorkerContext, {
        runtime,
        kernel: new BackofficeKernel(runtime),
        env,
        ctx,
      });
      const response = await requestHandler(request, context);
      const headers = new Headers(response.headers);
      headers.set("backoffice-request-id", requestId);

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    });
  },
} satisfies ExportedHandler<CloudflareEnv>;
