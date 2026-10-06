import { readFile, readdir } from "node:fs/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { URL } from "node:url";

import { build } from "esbuild";
import { Miniflare, type WorkerOptions } from "miniflare";

/** Exercises the built bridge and its private compiler through a separate service-binding caller. */
export async function createCodemodeBridgeTestServer() {
  // Load the actual Wrangler-built bridge and its Wasm assets, without provisioning containers.
  const bridgeBuildDirectory = new URL("../../dist/", import.meta.url);
  const wasmModules = await Promise.all(
    (await readdir(bridgeBuildDirectory))
      .filter((moduleName) => moduleName.endsWith(".wasm"))
      .map(
        async (moduleName) =>
          [
            moduleName,
            {
              type: "wasm",
              contents: new Uint8Array(await readFile(new URL(moduleName, bridgeBuildDirectory))),
            },
          ] as const,
      ),
  );
  const apiKey = "codemode-bridge-test-key";
  const bridge = {
    config: {
      name: "cf-sandbox-bridge",
      compatibilityDate: "2026-08-06",
      compatibilityFlags: [
        "nodejs_compat",
        "global_fetch_strictly_public",
        "enable_request_signal",
        "request_signal_passthrough",
      ],
      manifest: {
        mainModule: "index.js",
        modules: {
          "index.js": {
            type: "esm",
            contents: await readFile(new URL("index.js", bridgeBuildDirectory), "utf8"),
          },
          ...Object.fromEntries(wasmModules),
        },
      },
      exports: {
        Sandbox: { type: "durable-object", storage: "legacy-kv" },
        WarmPool: { type: "durable-object", storage: "legacy-kv" },
        CodemodeCompiler: { type: "worker" },
      },
      env: {
        SANDBOX_API_KEY: { type: "text", value: apiKey },
        Sandbox: { type: "durable-object", worker: "cf-sandbox-bridge", exportName: "Sandbox" },
        WarmPool: { type: "durable-object", worker: "cf-sandbox-bridge", exportName: "WarmPool" },
        LOADER: { type: "worker-loader" },
      },
    },
  } satisfies WorkerOptions;
  const caller = await build({
    stdin: {
      resolveDir: import.meta.dirname,
      contents: `
import { readCompileWorkerServiceResponse } from "@fragno-dev/codemode/compiler/compiler-service-protocol";
import { DynamicWorkerExecutor } from "@fragno-dev/codemode/guest/codemode-worker-executor";
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
        // Compiler callers can use arbitrary Worker RPC methods, not just the Codemode evaluation protocol.
        return Response.json(await executor.runEntrypoint({
          bundle: compiled.bundle,
          run: (entrypoint) => entrypoint.evaluate({}),
        }));
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
        config: {
          name: "compiler-client",
          compatibilityDate: bridge.config.compatibilityDate,
          compatibilityFlags: bridge.config.compatibilityFlags,
          manifest: {
            mainModule: "compiler-client.js",
            modules: {
              "compiler-client.js": { type: "esm", contents: caller.outputFiles[0].text },
            },
          },
          env: {
            COMPILER: {
              type: "worker",
              worker: bridge.config.name,
              exportName: "CodemodeCompiler",
            },
            LOADER: { type: "worker-loader" },
          },
        },
      },
    ],
  });
  try {
    const ready = await runtime.ready;
    const compiler = await runtime.getWorker("compiler-client");
    return {
      url: ready.href,
      apiKey,
      async requestBridge(request: Request): Promise<Response> {
        const response = await runtime.dispatchFetch(request.url, {
          method: request.method,
          headers: [...request.headers],
          body: request.body as NodeReadableStream<Uint8Array> | null,
          duplex: "half",
        });
        return response as unknown as Response;
      },
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
