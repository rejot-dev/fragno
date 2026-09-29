import { afterAll, beforeAll, expect, test, assert } from "vitest";

import { CODEMODE_LIMITS } from "@fragno-dev/codemode/codemode-limits";
import { createCodemodeCompilerHttpClient } from "@fragno-dev/codemode/compiler/compiler-service-client";
import {
  createCompileWorkerServiceRequest,
  createTypeCheckFilesServiceRequest,
  readCompileWorkerServiceResponse,
  readTypeCheckFilesServiceResponse,
} from "@fragno-dev/codemode/compiler/compiler-service-protocol";
import { createCodemodeNodeExecutor } from "@fragno-dev/codemode/transport/codemode-node-client";

import { createCodemodeBridgeTestServer } from "../testing/codemode-bridge-test-server";

let server: Awaited<ReturnType<typeof createCodemodeBridgeTestServer>>;
beforeAll(async () => {
  server = await createCodemodeBridgeTestServer();
});
afterAll(async () => {
  await server?.close();
});

const runtime = { compatibilityDate: "2026-08-06", compatibilityFlags: ["nodejs_compat"] };

test("named compiler RPC streams TypeScript and returns a Worker bundle", async () => {
  const request = createCompileWorkerServiceRequest({
    files: { "worker.ts": "const value: number = 42; export default value;" },
    entryPoint: "worker.ts",
    dependencies: {},
    runtime,
  });
  const response = await server.requestCompiler(new Request("http://compiler/compile", request));
  const compiled = await readCompileWorkerServiceResponse(response);
  expect(compiled.bundle.modules[compiled.bundle.mainModule]).toContain("42");
});

test("a compiler caller executes the returned bundle with its own Worker Loader", async () => {
  const request = createCompileWorkerServiceRequest({
    files: {
      "worker.ts": `import { WorkerEntrypoint } from "cloudflare:workers";
export default class extends WorkerEntrypoint {
  evaluate() { const value: number = 42; return { result: value }; }
}`,
    },
    entryPoint: "worker.ts",
    dependencies: {},
    runtime,
  });
  const response = await server.requestCompiler(new Request("http://compiler/execute", request));
  expect(await response.json()).toEqual({ result: 42 });
});

test("named compiler RPC type-checks streamed JavaScript against caller declarations", async () => {
  const files = {
    "workspace/example.js": "const value = declaredValue; const invalid = value.missing;",
    "workspace/globals.d.ts": "declare const declaredValue: { name: string };",
  };
  const request = createTypeCheckFilesServiceRequest({
    files: Object.entries(files).map(([path, content]) => ({ path, read: async () => content })),
    sourcePaths: ["workspace/example.js"],
  });
  const response = await server.requestCompiler(new Request("http://compiler/typecheck", request));
  expect(await readTypeCheckFilesServiceResponse(response)).toEqual({
    diagnostics: [expect.objectContaining({ code: 2339, path: "workspace/example.js", line: 1 })],
  });
});

test("Node HTTP clients compile and type-check through the authenticated public API", async () => {
  const compiler = createCodemodeCompilerHttpClient({ url: server.url, apiKey: server.apiKey });
  const compiled = await compiler.compileWorker({
    files: { "worker.ts": "const value: number = 42; export default value;" },
    entryPoint: "worker.ts",
    dependencies: {},
    runtime,
  });
  expect(compiled.bundle.modules[compiled.bundle.mainModule]).toContain("42");

  const checked = await compiler.typeCheckFiles({
    files: [
      {
        path: "workspace/example.js",
        read: async () => "const value = declaredValue; const invalid = value.missing;",
      },
      {
        path: "workspace/globals.d.ts",
        read: async () => "declare const declaredValue: { name: string };",
      },
    ],
    sourcePaths: ["workspace/example.js"],
  });
  expect(checked).toEqual({
    diagnostics: [expect.objectContaining({ code: 2339, path: "workspace/example.js", line: 1 })],
  });
});

test("public compiler HTTP routes require bearer authentication and POST", async () => {
  const url = server.url.replace(/^ws:/, "http:");
  const compileUrl = new URL("/v1/codemode/compile-worker", url);
  const unauthorizedResponse = await fetch(compileUrl);
  assert(unauthorizedResponse.status === 401);
  assert.deepEqual(await unauthorizedResponse.json(), {
    code: "AUTHENTICATION_FAILED",
    message: "Codemode HTTP authentication failed.",
  });
  assert(
    (
      await fetch(compileUrl, {
        headers: { authorization: `Bearer ${server.apiKey}` },
      })
    ).status === 405,
  );

  const unauthorizedClient = createCodemodeCompilerHttpClient({
    url: server.url,
    apiKey: "incorrect",
  });
  await expect(
    unauthorizedClient.compileWorker({
      files: { "worker.ts": "export default 42;" },
      entryPoint: "worker.ts",
      dependencies: {},
      runtime,
    }),
  ).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
});

test("RPC, HTTP, and WebSocket compilation share compiler admission and recover", async () => {
  let releaseFiles!: () => void;
  const filesReady = new Promise<void>((resolve) => {
    releaseFiles = resolve;
  });
  const pending = Array.from({ length: CODEMODE_LIMITS.maxBridgeCompilations + 1 }, () => {
    const request = createTypeCheckFilesServiceRequest({
      files: [
        {
          path: "script.js",
          async read() {
            await filesReady;
            return "const value = 42;";
          },
        },
      ],
      sourcePaths: ["script.js"],
    });
    return server
      .requestCompiler(new Request("http://compiler/typecheck", request))
      .then(readTypeCheckFilesServiceResponse)
      .then(
        (result) => ({ status: "checked" as const, result }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );
  });
  const execute = createCodemodeNodeExecutor(server);
  const activation = {
    kind: "immediate" as const,
    code: "42",
    dependencies: {},
    providers: [],
    timeoutMs: 10_000,
  };
  const host = {
    async handle() {
      throw new Error("No tools are exposed");
    },
    close() {},
    async settle() {
      return null;
    },
  };
  try {
    // The ninth RPC returns only once all eight admitted calls are waiting for file contents.
    await expect(Promise.race(pending)).resolves.toMatchObject({
      status: "rejected",
      error: { message: "CODEMODE_COMPILATION_LIMIT_EXCEEDED" },
    });
    const compileRequest = createCompileWorkerServiceRequest({
      files: { "worker.ts": "export default 42;" },
      entryPoint: "worker.ts",
      dependencies: {},
      runtime,
    });
    const response = await server.requestCompiler(
      new Request("http://compiler/compile", compileRequest),
    );
    await expect(readCompileWorkerServiceResponse(response)).rejects.toThrow(
      "CODEMODE_COMPILATION_LIMIT_EXCEEDED",
    );
    const httpCompiler = createCodemodeCompilerHttpClient({
      url: server.url,
      apiKey: server.apiKey,
    });
    await expect(
      httpCompiler.compileWorker({
        files: { "worker.ts": "export default 42;" },
        entryPoint: "worker.ts",
        dependencies: {},
        runtime,
      }),
    ).rejects.toThrow("CODEMODE_COMPILATION_LIMIT_EXCEEDED");
    await expect(execute(activation, host)).resolves.toMatchObject({
      status: "failed",
      error: { message: "CODEMODE_COMPILATION_LIMIT_EXCEEDED" },
    });
  } finally {
    releaseFiles();
    await Promise.all(pending);
  }
  const outcomes = await Promise.all(pending);
  expect(outcomes.filter((outcome) => outcome.status === "checked")).toHaveLength(
    CODEMODE_LIMITS.maxBridgeCompilations,
  );
  await expect(execute(activation, host)).resolves.toMatchObject({
    status: "completed",
    value: 42,
  });
});

test("named compiler RPC preserves invalid-project errors and unrelated HTTP paths", async () => {
  const request = createCompileWorkerServiceRequest({
    files: { "worker.ts": "export default {};", "package.json": "{}" },
    entryPoint: "worker.ts",
    dependencies: {},
    runtime,
  });
  const response = await server.requestCompiler(new Request("http://compiler/compile", request));
  await expect(readCompileWorkerServiceResponse(response)).rejects.toMatchObject({
    code: "INVALID_INPUT",
  });
  assert(
    (await server.requestCompiler(new Request("http://compiler/private-fetch"))).status === 404,
  );
  const publicResponse = await fetch(new URL("/compile", server.url.replace(/^ws:/, "http:")), {
    method: "POST",
  });
  assert((await publicResponse.text()) === "OK");
});
