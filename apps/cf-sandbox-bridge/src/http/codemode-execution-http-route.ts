import { CODEMODE_EXECUTION_HTTP_PATH } from "@fragno-dev/codemode/execution/codemode-activation-contract";
import { acceptCodemodeBridgeSession } from "@fragno-dev/codemode/remote/codemode-bridge-session";
import { authenticateCodemodeHttpRequest } from "@fragno-dev/codemode/transport/codemode-http-authentication";
import type { Hono } from "hono";

import type { SandboxBridgeHonoEnv } from "./sandbox-bridge-http-env";

/** Authenticates and upgrades execution requests before the Sandbox SDK fallback router. */
export function registerCodemodeExecutionHttpRoute(app: Hono<SandboxBridgeHonoEnv>): void {
  app.all(CODEMODE_EXECUTION_HTTP_PATH, async function handleCodemodeExecutionHttpRoute(context) {
    const request = context.req.raw;
    const authenticationError = await authenticateCodemodeHttpRequest(
      request,
      context.env.SANDBOX_API_KEY,
    );
    if (authenticationError) {
      return authenticationError;
    }
    const url = new URL(request.url);
    if (url.pathname !== CODEMODE_EXECUTION_HTTP_PATH || url.search) {
      return new Response("Not found", { status: 404 });
    }
    if (request.method !== "GET") {
      return new Response("Method not allowed", { status: 405, headers: { allow: "GET" } });
    }
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required", { status: 426 });
    }
    const pair = new WebSocketPair();
    const executionCtx = context.executionCtx as unknown as ExecutionContext;
    acceptCodemodeBridgeSession(
      pair[1],
      {
        loader: context.env.LOADER,
        async compile(input) {
          // Sandbox-only requests should not initialize the compiler runtime.
          const { buildWorkerProject } = await import("../compiler/build-worker-project");
          return await buildWorkerProject(input);
        },
      },
      executionCtx,
    );
    return new Response(null, { status: 101, webSocket: pair[0] });
  });
}
