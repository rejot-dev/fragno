import { createRequestHandler, RouterContextProvider } from "react-router";
import System from "typebox/system";

import { CloudflareContext } from "../app/cloudflare/cloudflare-context";

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

System.Settings.Set({ useAcceleration: false });

export function handleReactRouterRequest(
  request: Request,
  env: CloudflareEnv,
  ctx: ExecutionContext,
) {
  const context = new RouterContextProvider();
  context.set(CloudflareContext, { env, ctx });
  return requestHandler(request, context);
}
