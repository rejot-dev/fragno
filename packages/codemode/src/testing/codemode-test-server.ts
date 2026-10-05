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

/** Real local workerd bridge with WebSocket execution and an authenticated HTTP type-check seam. */
export async function createCodemodeTestServer(
  wrapCompiler: (compile: WorkerCompiler) => WorkerCompiler = (compile) => compile,
) {
  const compile = wrapCompiler(compileCodemodeTestWorker);
  const resolveDir = import.meta.dirname;
  const worker = await build({
    stdin: {
      resolveDir,
      contents: `
import { createWorkerCompilerServiceClient } from "../compiler/compiler-service-client";
import {
  createTypeCheckFilesServiceResponse,
  readTypeCheckFilesServiceRequest,
} from "../compiler/compiler-service-protocol";
import { authenticateCodemodeHttpRequest } from "../transport/codemode-http-authentication";
import { handleCodemodeWorkerRequest } from "../worker/codemode-worker-session";
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/v1/codemode/type-check-files") {
      const authenticationError = await authenticateCodemodeHttpRequest(request, env.API_KEY);
      if (authenticationError) return authenticationError;
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
      const project = await readTypeCheckFilesServiceRequest(request);
      for await (const file of project.files) {
        void file;
      }
      return createTypeCheckFilesServiceResponse({ diagnostics: [] });
    }
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
        config: {
          name: "executor",
          compatibilityDate: "2026-08-01",
          compatibilityFlags: ["nodejs_compat"],
          manifest: {
            mainModule: "executor.js",
            modules: { "executor.js": { type: "esm", contents: worker.outputFiles[0].text } },
          },
          env: {
            API_KEY: { type: "text", value: apiKey },
            LOADER: { type: "worker-loader" },
            COMPILER: { type: "worker", worker: "compiler" },
          },
        },
      },
      {
        config: {
          name: "compiler",
          compatibilityDate: "2026-08-01",
          compatibilityFlags: ["nodejs_compat"],
          manifest: {
            mainModule: "compiler.js",
            modules: { "compiler.js": { type: "esm", contents: compiler.outputFiles[0].text } },
          },
          env: {
            BUILD: {
              type: "fetcher",
              async handler(request) {
                const input = await readCompileWorkerServiceRequest(request as unknown as Request);
                const response = createCompileWorkerServiceResponse(await compile(input));
                return new MiniflareResponse(await response.arrayBuffer(), {
                  headers: { "content-type": response.headers.get("content-type")! },
                });
              },
            },
          },
        },
      },
    ],
  });
  try {
    const ready = await runtime.ready;
    return { url: ready.href, apiKey, close: () => runtime.dispose() };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}
