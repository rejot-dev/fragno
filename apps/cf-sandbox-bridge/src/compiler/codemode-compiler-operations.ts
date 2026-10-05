import { runWithCodemodeCompilerAdmission } from "@fragno-dev/codemode/compiler/codemode-compiler-admission";
import {
  createCompileWorkerServiceResponse,
  createCompilerServiceErrorResponse,
  createTypeCheckFilesServiceResponse,
  readCompileWorkerServiceRequest,
  readTypeCheckFilesServiceRequest,
} from "@fragno-dev/codemode/compiler/compiler-service-protocol";

type CompilerExecutionContext = Pick<ExecutionContext, "waitUntil">;

/** Compiles a streamed project; HTTP and service-binding RPC share admission and disconnect cleanup. */
export async function compileCodemodeWorkerRequest(
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

/** Type checks a streamed project using the same compiler admission as Worker builds. */
export async function typeCheckCodemodeFilesRequest(
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
