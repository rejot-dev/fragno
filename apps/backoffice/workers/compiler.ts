import { WorkerEntrypoint } from "cloudflare:workers";

import {
  createCompileWorkerServiceResponse,
  createCompilerServiceErrorResponse,
  createTypeCheckFilesServiceResponse,
  readCompileWorkerServiceRequest,
  readTypeCheckFilesServiceRequest,
} from "@/backoffice-runtime/dynamic-workers/compiler-service-protocol";

/** Stateless private service that owns TypeScript and esbuild's complete module graph. */
export default class CodemodeCompilerWorker extends WorkerEntrypoint {
  async compileWorker(request: Request): Promise<Response> {
    try {
      const { buildWorkerProject } = await import("./compiler/build-worker-project");
      return createCompileWorkerServiceResponse(
        await buildWorkerProject(await readCompileWorkerServiceRequest(request)),
      );
    } catch (error) {
      return createCompilerServiceErrorResponse(error);
    }
  }

  async typeCheckFiles(request: Request): Promise<Response> {
    try {
      const { typeCheckProject } = await import("./compiler/type-check-project");
      return createTypeCheckFilesServiceResponse(
        await typeCheckProject(await readTypeCheckFilesServiceRequest(request)),
      );
    } catch (error) {
      return createCompilerServiceErrorResponse(error);
    }
  }

  fetch(): Response {
    return new Response("Not Found", { status: 404 });
  }
}
