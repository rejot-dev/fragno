import { CODEMODE_COMPILER_HTTP_PATHS } from "@fragno-dev/codemode/compiler/compiler-service-protocol";
import { authenticateCodemodeHttpRequest } from "@fragno-dev/codemode/transport/codemode-http-authentication";
import type { Context, Hono } from "hono";

import {
  compileCodemodeWorkerRequest,
  typeCheckCodemodeFilesRequest,
} from "../compiler/codemode-compiler-operations";
import type { SandboxBridgeHonoEnv } from "./sandbox-bridge-http-env";

/** Handles authenticated compiler HTTP requests without claiming unrelated paths. */
export async function handleCodemodeCompilerHttpRequest(
  request: Request,
  apiKey: string | undefined,
  ctx: Pick<ExecutionContext, "waitUntil">,
): Promise<Response | null> {
  const url = new URL(request.url);
  const operation =
    url.pathname === CODEMODE_COMPILER_HTTP_PATHS.compileWorker
      ? compileCodemodeWorkerRequest
      : url.pathname === CODEMODE_COMPILER_HTTP_PATHS.typeCheckFiles
        ? typeCheckCodemodeFilesRequest
        : null;
  if (operation === null) {
    return null;
  }

  try {
    const authenticationError = await authenticateCodemodeHttpRequest(request, apiKey);
    if (authenticationError) {
      return authenticationError;
    }
    if (url.search) {
      return new Response("Not found", { status: 404 });
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });
    }
    return await operation(request, ctx);
  } finally {
    // Returning before an unread HTTP upload finishes can replace the error response with
    // write EPIPE in streaming Node clients. Discard it without buffering or compiling it.
    if (request.body && !request.bodyUsed) {
      await request.body.pipeTo(new WritableStream());
    }
  }
}

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

/** Registers compiler HTTP endpoints before the Sandbox SDK fallback router. */
export function registerCodemodeCompilerHttpRoutes(app: Hono<SandboxBridgeHonoEnv>): void {
  app.all(CODEMODE_COMPILER_HTTP_PATHS.compileWorker, handleCompilerHttpRoute);
  app.all(CODEMODE_COMPILER_HTTP_PATHS.typeCheckFiles, handleCompilerHttpRoute);
}
