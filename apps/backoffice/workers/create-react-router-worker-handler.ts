import { createRequestHandler, RouterContextProvider, type ServerBuild } from "react-router";
import System from "typebox/system";

import { BackofficeKernel } from "../app/backoffice-runtime/kernel";
import { createCloudflareBackofficeRuntimeServices } from "../app/backoffice-runtime/runtime-services";
import { BackofficeWorkerContext } from "../app/worker-runtime/router-context";

System.Settings.Set({ useAcceleration: false });

/** Creates an isolated Worker service for one statically loaded React Router server bundle. */
export function createReactRouterRouteService(
  serverBuild: ServerBuild,
): ExportedHandler<CloudflareEnv> {
  const requestHandler = createRequestHandler(serverBuild, import.meta.env.MODE);

  return {
    async fetch(request, env, ctx) {
      const runtime = createCloudflareBackofficeRuntimeServices(env);
      const context = new RouterContextProvider();
      context.set(BackofficeWorkerContext, {
        runtime,
        kernel: new BackofficeKernel(runtime),
        env,
        ctx,
      });
      return requestHandler(request, context);
    },
  };
}
