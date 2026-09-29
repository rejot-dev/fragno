import { bridge } from "@cloudflare/sandbox/bridge";
import { Hono } from "hono";

import { registerCodemodeHttpRoutes, type SandboxBridgeHonoEnv } from "./codemode-http-routes";

// Wrangler discovers named RPC entrypoints and the existing container/pool classes here.
export { CodemodeCompiler } from "./compiler/codemode-compiler";
export { Sandbox } from "@cloudflare/sandbox";
export { WarmPool } from "@cloudflare/sandbox/bridge";

const sandboxBridge = bridge({
  async fetch(_request: Request, _env: Env, _ctx: ExecutionContext): Promise<Response> {
    return new Response("OK");
  },
}) as unknown as Required<Pick<ExportedHandler<Env>, "fetch" | "scheduled">>;

const app = new Hono<SandboxBridgeHonoEnv>();
registerCodemodeHttpRoutes(app);
app.notFound((context) => {
  const request = context.req.raw as Request<unknown, IncomingRequestCfProperties>;
  const executionCtx = context.executionCtx as unknown as ExecutionContext;
  return sandboxBridge.fetch(request, context.env, executionCtx);
});

export default {
  ...sandboxBridge,
  fetch: app.fetch,
};
