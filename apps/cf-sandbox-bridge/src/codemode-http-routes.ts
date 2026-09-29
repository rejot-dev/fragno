import { CODEMODE_COMPILER_HTTP_PATHS } from "@fragno-dev/codemode/compiler/compiler-service-protocol";
import { handleCodemodeWorkerRequest } from "@fragno-dev/codemode/worker/codemode-worker-session";
import type { Context, Hono } from "hono";

import { handleCodemodeCompilerHttpRequest } from "./compiler/codemode-compiler";

/** Hono bindings available to the Cloudflare Sandbox bridge routes. */
export type SandboxBridgeHonoEnv = { Bindings: Env };

async function handleCompilerHttpRoute(context: Context<SandboxBridgeHonoEnv>): Promise<Response> {
  const executionCtx = context.executionCtx as unknown as ExecutionContext;
  return (
    (await handleCodemodeCompilerHttpRequest(
      context.req.raw,
      context.env.SANDBOX_API_KEY,
      executionCtx,
    )) ?? context.notFound()
  );
}

async function handleCodemodeExecutionRoute(
  context: Context<SandboxBridgeHonoEnv>,
): Promise<Response> {
  const executionCtx = context.executionCtx as unknown as ExecutionContext;
  return await handleCodemodeWorkerRequest(
    context.req.raw,
    context.env.SANDBOX_API_KEY,
    {
      loader: context.env.LOADER,
      async compile(input) {
        // Sandbox-only requests should not initialize the compiler runtime.
        const { buildWorkerProject } = await import("./compiler/build-worker-project");
        return await buildWorkerProject(input);
      },
    },
    executionCtx,
  );
}

/** Registers codemode HTTP routes before the Sandbox SDK claims the /v1 namespace. */
export function registerCodemodeHttpRoutes(app: Hono<SandboxBridgeHonoEnv>): void {
  app.all(CODEMODE_COMPILER_HTTP_PATHS.compileWorker, handleCompilerHttpRoute);
  app.all(CODEMODE_COMPILER_HTTP_PATHS.typeCheckFiles, handleCompilerHttpRoute);
  app.all("/v1/codemode/execute", handleCodemodeExecutionRoute);
}
