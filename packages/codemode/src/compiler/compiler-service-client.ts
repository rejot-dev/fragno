import { CODEMODE_LIMITS } from "../codemode-limits";
import { createCodemodeBridgeHttpUrl } from "../transport/codemode-bridge-url";
import { readCodemodeHttpAuthenticationError } from "../transport/codemode-http-authentication";
import type { WorkerCompiler, WorkerCompilerService, WorkerTypeChecker } from "./compile-worker";
import {
  CODEMODE_COMPILER_HTTP_PATHS,
  createCompileWorkerServiceRequest,
  createTypeCheckFilesServiceRequest,
  readCompileWorkerServiceResponse,
  readTypeCheckFilesServiceResponse,
} from "./compiler-service-protocol";

function castWorkerCompilerService(binding: Fetcher) {
  return binding as Fetcher & WorkerCompilerService;
}

export type CodemodeCompilerHttpErrorCode = "REQUEST_TIMED_OUT" | "UNEXPECTED_HTTP_RESPONSE";

/** Stable transport failure raised before a compiler protocol response can be read. */
export class CodemodeCompilerHttpError extends Error {
  readonly code: CodemodeCompilerHttpErrorCode;

  constructor(code: CodemodeCompilerHttpErrorCode, message: string) {
    super(message);
    this.name = "CodemodeCompilerHttpError";
    this.code = code;
  }
}

async function runCompilerHttpRequest<T>(
  endpoint: URL,
  apiKey: string,
  request: Request,
  readResponse: (response: Response) => Promise<T>,
): Promise<T> {
  const headers = new Headers(request.headers);
  headers.set("authorization", `Bearer ${apiKey}`);
  const controller = new AbortController();
  const timeoutError = new CodemodeCompilerHttpError(
    "REQUEST_TIMED_OUT",
    `Codemode compiler request exceeded ${CODEMODE_LIMITS.compileTimeoutMs}ms.`,
  );
  const deadline = setTimeout(() => {
    controller.abort(timeoutError);
  }, CODEMODE_LIMITS.compileTimeoutMs);
  try {
    const response = await fetch(
      new Request(endpoint, {
        method: request.method,
        headers,
        body: request.body,
        duplex: "half",
        redirect: "error",
        signal: controller.signal,
      } as RequestInit & { duplex: "half" }),
    );
    if (response.status === 401 || response.status === 503) {
      const authenticationError = await readCodemodeHttpAuthenticationError(response.clone());
      if (authenticationError) {
        throw authenticationError;
      }
      throw new CodemodeCompilerHttpError(
        "UNEXPECTED_HTTP_RESPONSE",
        `Codemode compiler returned unexpected HTTP status ${response.status}.`,
      );
    }
    return await readResponse(response);
  } catch (error) {
    if (controller.signal.aborted) {
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(deadline);
  }
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

/** Compiler operations available to Node processes over the bridge's authenticated HTTP API. */
export type CodemodeCompilerHttpClient = {
  compileWorker: WorkerCompiler;
  typeCheckFiles: WorkerTypeChecker;
};

/** Creates authenticated HTTP compiler clients for Node processes outside Cloudflare service bindings. */
export function createCodemodeCompilerHttpClient(config: {
  url: string;
  apiKey: string;
}): CodemodeCompilerHttpClient {
  if (!config.apiKey.trim()) {
    throw new Error("Codemode compiler API key must not be empty.");
  }
  const compileEndpoint = createCodemodeBridgeHttpUrl(
    config.url,
    CODEMODE_COMPILER_HTTP_PATHS.compileWorker,
  );
  const typeCheckEndpoint = createCodemodeBridgeHttpUrl(
    config.url,
    CODEMODE_COMPILER_HTTP_PATHS.typeCheckFiles,
  );
  return {
    async compileWorker(input) {
      return await runCompilerHttpRequest(
        compileEndpoint,
        config.apiKey,
        createCompileWorkerServiceRequest(input),
        readCompileWorkerServiceResponse,
      );
    },
    async typeCheckFiles(input) {
      return await runCompilerHttpRequest(
        typeCheckEndpoint,
        config.apiKey,
        createTypeCheckFilesServiceRequest(input),
        readTypeCheckFilesServiceResponse,
      );
    },
  };
}
