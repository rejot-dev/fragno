import type { WorkerCompiler, WorkerCompilerService, WorkerTypeChecker } from "./compile-worker";
import {
  createCompileWorkerServiceRequest,
  createTypeCheckFilesServiceRequest,
  readCompileWorkerServiceResponse,
  readTypeCheckFilesServiceResponse,
} from "./compiler-service-protocol";

function castWorkerCompilerService(binding: Fetcher) {
  return binding as Fetcher & WorkerCompilerService;
}

/** Adapts the authoritative compiler service binding to the application compiler contract. */
export function createWorkerCompilerServiceClient(binding: Fetcher): WorkerCompiler {
  const service = castWorkerCompilerService(binding);
  return async function compileWorkerThroughService(input) {
    return await readCompileWorkerServiceResponse(
      await service.compileWorker(createCompileWorkerServiceRequest(input)),
    );
  };
}

/** Adapts the authoritative compiler service binding to the application type-checking contract. */
export function createWorkerTypeCheckerServiceClient(binding: Fetcher): WorkerTypeChecker {
  const service = castWorkerCompilerService(binding);
  return async function typeCheckFilesThroughService(input) {
    return await readTypeCheckFilesServiceResponse(
      await service.typeCheckFiles(createTypeCheckFilesServiceRequest(input)),
    );
  };
}
