import { runWithCodemodeCompilerAdmission } from "@fragno-dev/codemode/compiler/codemode-compiler-admission";
import {
  CODEMODE_COMPILER_HTTP_PATHS,
  createCompileWorkerServiceResponse,
  createCompilerServiceErrorResponse,
  createTypeCheckFilesServiceResponse,
  readCompileWorkerServiceRequest,
  readTypeCheckFilesServiceRequest,
} from "@fragno-dev/codemode/compiler/compiler-service-protocol";
import { authenticateCodemodeHttpRequest } from "@fragno-dev/codemode/transport/codemode-http-authentication";
import { WorkerEntrypoint } from "cloudflare:workers";

type CompilerExecutionContext = Pick<ExecutionContext, "waitUntil">;

async function compileWorkerRequest(
  request: Request,
  ctx: CompilerExecutionContext,
): Promise<Response> {
  const compilation = runWithCodemodeCompilerAdmission(async () => {
    const { buildWorkerProject } = await import("./build-worker-project");
    return await buildWorkerProject(await readCompileWorkerServiceRequest(request));
  });
  // Keep cleanup alive after the caller disconnects, just as for WebSocket activations.
  ctx.waitUntil(compilation.catch(() => {}));
  try {
    return createCompileWorkerServiceResponse(await compilation);
  } catch (error) {
    return createCompilerServiceErrorResponse(error);
  }
}

async function typeCheckFilesRequest(
  request: Request,
  ctx: CompilerExecutionContext,
): Promise<Response> {
  const checking = runWithCodemodeCompilerAdmission(async () => {
    const { typeCheckProject } = await import("./type-check-project");
    return await typeCheckProject(await readTypeCheckFilesServiceRequest(request));
  });
  ctx.waitUntil(checking.catch(() => {}));
  try {
    return createTypeCheckFilesServiceResponse(await checking);
  } catch (error) {
    return createCompilerServiceErrorResponse(error);
  }
}

/** Handles authenticated public HTTP compilation and type-checking without claiming other routes. */
export async function handleCodemodeCompilerHttpRequest(
  request: Request,
  apiKey: string | undefined,
  ctx: CompilerExecutionContext,
): Promise<Response | null> {
  const url = new URL(request.url);
  const operation =
    url.pathname === CODEMODE_COMPILER_HTTP_PATHS.compileWorker
      ? compileWorkerRequest
      : url.pathname === CODEMODE_COMPILER_HTTP_PATHS.typeCheckFiles
        ? typeCheckFilesRequest
        : null;
  if (operation === null) {
    return null;
  }

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
}

/** Named RPC entrypoint sharing compiler admission with HTTP and WebSocket activations. */
export class CodemodeCompiler extends WorkerEntrypoint<Env> {
  async compileWorker(request: Request): Promise<Response> {
    return await compileWorkerRequest(request, this.ctx);
  }

  async typeCheckFiles(request: Request): Promise<Response> {
    return await typeCheckFilesRequest(request, this.ctx);
  }

  override async fetch(request: Request): Promise<Response> {
    return (
      (await handleCodemodeCompilerHttpRequest(request, this.env.SANDBOX_API_KEY, this.ctx)) ??
      new Response("Not Found", { status: 404 })
    );
  }
}
