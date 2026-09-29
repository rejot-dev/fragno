import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { fileURLToPath, URL } from "node:url";

import { build } from "esbuild";
import { Miniflare, type WorkerOptions } from "miniflare";

/** Exercises the built bridge and its private compiler through a separate service-binding caller. */
export async function createCodemodeBridgeTestServer() {
  // Load the actual Wrangler-built bridge and its Wasm assets, without provisioning containers.
  const bridge = {
    name: "cf-sandbox-bridge",
    modules: true,
    scriptPath: fileURLToPath(new URL("../../dist/index.js", import.meta.url)),
    modulesRules: [{ type: "CompiledWasm", include: ["**/*.wasm"] }],
    compatibilityDate: "2026-08-06",
    compatibilityFlags: [
      "nodejs_compat",
      "global_fetch_strictly_public",
      "enable_request_signal",
      "request_signal_passthrough",
    ],
    bindings: { SANDBOX_API_KEY: "codemode-bridge-test-key" },
    durableObjects: { Sandbox: "Sandbox", WarmPool: "WarmPool" },
    workerLoaders: { LOADER: {} },
  } satisfies WorkerOptions;
  const caller = await build({
    stdin: {
      resolveDir: import.meta.dirname,
      contents: `
import { readCompileWorkerServiceResponse } from "@fragno-dev/codemode/compiler/compiler-service-protocol";
import { DynamicWorkerExecutor } from "@fragno-dev/codemode/worker/codemode-executor";
export default {
  async fetch(incoming, env) {
    // Production compiler clients construct fresh protocol requests, without an inbound HTTP AbortSignal.
    const request = new Request(incoming.url, { method: incoming.method, headers: incoming.headers, body: incoming.body });
    switch (new URL(request.url).pathname) {
      case "/compile": return await env.COMPILER.compileWorker(request);
      case "/typecheck": return await env.COMPILER.typeCheckFiles(request);
      case "/private-fetch": return await env.COMPILER.fetch(request);
      case "/execute": {
        const compiled = await readCompileWorkerServiceResponse(await env.COMPILER.compileWorker(request));
        const executor = new DynamicWorkerExecutor({ loader: env.LOADER });
        return Response.json(await executor.evaluateWorkerBundle(compiled.bundle, {}));
      }
      default: return new Response("Not Found", { status: 404 });
    }
  },
};`,
    },
    bundle: true,
    format: "esm",
    platform: "neutral",
    write: false,
    external: ["cloudflare:workers", "node:*"],
  });
  const runtime = new Miniflare({
    host: "127.0.0.1",
    port: 0,
    workers: [
      bridge,
      {
        name: "compiler-client",
        modules: true,
        script: caller.outputFiles[0].text,
        compatibilityDate: bridge.compatibilityDate,
        compatibilityFlags: bridge.compatibilityFlags,
        serviceBindings: { COMPILER: { name: bridge.name, entrypoint: "CodemodeCompiler" } },
        workerLoaders: { LOADER: {} },
      },
    ],
  });
  try {
    const ready = await runtime.ready;
    const compiler = await runtime.getWorker("compiler-client");
    return {
      url: ready.href,
      apiKey: bridge.bindings.SANDBOX_API_KEY,
      async requestCompiler(request: Request): Promise<Response> {
        // Miniflare's undici Request is distinct from Node's native Request; forward its stream explicitly.
        const response = await compiler.fetch(request.url, {
          method: request.method,
          headers: [...request.headers],
          body: request.body as NodeReadableStream<Uint8Array> | null,
          duplex: "half",
        });
        return response as unknown as Response;
      },
      close: () => runtime.dispose(),
    };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}
