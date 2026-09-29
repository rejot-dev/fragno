import { build } from "esbuild";
import { Miniflare, Response as MiniflareResponse } from "miniflare";

import type {
  CompiledWorker,
  CompileWorkerInput,
  WorkerCompiler,
} from "../compiler/compile-worker";
import {
  createCompileWorkerServiceResponse,
  readCompileWorkerServiceRequest,
} from "../compiler/compiler-service-protocol";
import { createWorkerBundle } from "../compiler/worker-bundle";

async function compileCodemodeTestWorker(input: CompileWorkerInput): Promise<CompiledWorker> {
  if (Object.keys(input.dependencies).length) {
    throw new Error("Test compiler does not install npm dependencies.");
  }
  const compiled = await build({
    entryPoints: [input.entryPoint],
    bundle: true,
    format: "esm",
    platform: "neutral",
    write: false,
    external: ["cloudflare:workers", "node:*"],
    plugins: [
      {
        name: "codemode-test-files",
        setup(build) {
          build.onResolve({ filter: /.*/ }, ({ path }) =>
            path.startsWith("cloudflare:") || path.startsWith("node:")
              ? { path, external: true }
              : { path: path.replace(/^\.\//, ""), namespace: "codemode" },
          );
          build.onLoad({ filter: /.*/, namespace: "codemode" }, ({ path }) => ({
            contents: input.files[path],
            loader: "js",
          }));
        },
      },
    ],
  });
  return {
    bundle: createWorkerBundle({
      mainModule: "executor.js",
      modules: { "executor.js": compiled.outputFiles[0].text },
      runtime: input.runtime,
    }),
    warnings: [],
  };
}

/** Real local workerd + WebSocket executor; wrap its JS compiler to control latency or diagnostics. */
export async function createCodemodeTestServer(
  wrapCompiler: (compile: WorkerCompiler) => WorkerCompiler = (compile) => compile,
) {
  const compile = wrapCompiler(compileCodemodeTestWorker);
  const resolveDir = import.meta.dirname;
  const worker = await build({
    stdin: {
      resolveDir,
      contents: `
import { handleCodemodeWorkerRequest } from "../worker/codemode-worker-session";
import { createWorkerCompilerServiceClient } from "../compiler/compiler-service-client";
export default {
  async fetch(request, env, ctx) {
    return await handleCodemodeWorkerRequest(request, env.API_KEY, {
      loader: env.LOADER, compile: createWorkerCompilerServiceClient(env.COMPILER),
    }, ctx);
  },
};`,
    },
    bundle: true,
    format: "esm",
    platform: "neutral",
    write: false,
    external: ["cloudflare:workers", "node:*"],
  });
  const compiler = await build({
    stdin: {
      resolveDir,
      contents: `
import { WorkerEntrypoint } from "cloudflare:workers";
export default class JavaScriptTestCompiler extends WorkerEntrypoint {
  async compileWorker(request) {
    return await this.env.BUILD.fetch(request);
  }
}`,
    },
    bundle: true,
    format: "esm",
    platform: "neutral",
    write: false,
    external: ["cloudflare:workers", "node:*"],
  });
  const apiKey = "local-codemode-test-key";
  const runtime = new Miniflare({
    host: "127.0.0.1",
    port: 0,
    workers: [
      {
        name: "executor",
        modules: true,
        script: worker.outputFiles[0].text,
        compatibilityDate: "2026-08-01",
        compatibilityFlags: ["nodejs_compat"],
        bindings: { API_KEY: apiKey },
        workerLoaders: { LOADER: {} },
        serviceBindings: { COMPILER: "compiler" },
      },
      {
        name: "compiler",
        modules: true,
        script: compiler.outputFiles[0].text,
        compatibilityDate: "2026-08-01",
        compatibilityFlags: ["nodejs_compat"],
        serviceBindings: {
          BUILD: async (request) => {
            const input = await readCompileWorkerServiceRequest(request as unknown as Request);
            const response = createCompileWorkerServiceResponse(await compile(input));
            return new MiniflareResponse(await response.arrayBuffer(), {
              headers: { "content-type": response.headers.get("content-type")! },
            });
          },
        },
      },
    ],
  });
  try {
    const ready = await runtime.ready;
    return { url: ready.href.replace(/^http:/, "ws:"), apiKey, close: () => runtime.dispose() };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}
