import { runWithCodemodeCompilerAdmission } from "@fragno-dev/codemode/compiler/codemode-compiler-admission";
import {
  createCompileWorkerServiceResponse,
  createCompilerServiceErrorResponse,
  createTypeCheckFilesServiceResponse,
  readCompileWorkerServiceRequest,
  readTypeCheckFilesServiceRequest,
} from "@fragno-dev/codemode/compiler/compiler-service-protocol";
import { WorkerEntrypoint } from "cloudflare:workers";

/** Private named RPC entrypoint; shares compiler admission with the bridge's WebSocket activations. */
export class CodemodeCompiler extends WorkerEntrypoint {
  async compileWorker(request: Request): Promise<Response> {
    const compilation = runWithCodemodeCompilerAdmission(async () => {
      const { buildWorkerProject } = await import("./build-worker-project");
      return await buildWorkerProject(await readCompileWorkerServiceRequest(request));
    });
    // Keep cleanup alive after the RPC caller disconnects, just as for WebSocket activations.
    this.ctx.waitUntil(compilation.catch(() => {}));
    try {
      return createCompileWorkerServiceResponse(await compilation);
    } catch (error) {
      return createCompilerServiceErrorResponse(error);
    }
  }

  async typeCheckFiles(request: Request): Promise<Response> {
    const checking = runWithCodemodeCompilerAdmission(async () => {
      const { typeCheckProject } = await import("./type-check-project");
      return await typeCheckProject(await readTypeCheckFilesServiceRequest(request));
    });
    this.ctx.waitUntil(checking.catch(() => {}));
    try {
      return createTypeCheckFilesServiceResponse(await checking);
    } catch (error) {
      return createCompilerServiceErrorResponse(error);
    }
  }

  override fetch(): Response {
    return new Response("Not Found", { status: 404 });
  }
}
