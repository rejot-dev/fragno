import { afterAll, beforeAll, expect, test, assert } from "vitest";

import { readFile } from "node:fs/promises";
import path from "node:path";

import { createCodemodeNodeExecutor } from "@fragno-dev/codemode/transport/codemode-node-client";

import { createCodemodeBridgeTestServer } from "./testing/codemode-bridge-test-server";

let server: Awaited<ReturnType<typeof createCodemodeBridgeTestServer>>;
beforeAll(async () => {
  server = await createCodemodeBridgeTestServer();
});
afterAll(async () => {
  await server?.close();
});

test("the deployed container image matches the exact Sandbox SDK dependency", async () => {
  const [manifest, dockerfile] = await Promise.all([
    readFile(path.join(import.meta.dirname, "../package.json"), "utf8"),
    readFile(path.join(import.meta.dirname, "../Dockerfile"), "utf8"),
  ]);
  const { dependencies } = JSON.parse(manifest) as { dependencies: Record<string, string> };
  const imageVersion = /^FROM docker\.io\/cloudflare\/sandbox:(\S+)$/m.exec(dockerfile)?.[1];
  assert(imageVersion, "Dockerfile must pin a Cloudflare Sandbox image tag");
  expect(imageVersion).toBe(dependencies["@cloudflare/sandbox"]);
});

test("codemode is routed before the Sandbox SDK claims /v1", async () => {
  const execute = createCodemodeNodeExecutor(server);
  const result = await execute(
    { kind: "immediate", code: "42", dependencies: {}, providers: [], timeoutMs: 10_000 },
    {
      async handle() {
        throw new Error("No tools are exposed");
      },
      close() {},
      async settle() {
        return null;
      },
    },
  );
  expect(result).toEqual({ status: "completed", value: 42, logs: [], workflowDefinition: null });
});

test("Sandbox health and authentication routes retain SDK behavior", async () => {
  const url = server.url.replace(/^ws:/, "http:");
  const health = await fetch(new URL("/health", url));
  expect(await health.json()).toEqual({ ok: true });
  const sandbox = await fetch(new URL("/v1/sandbox", url), { method: "POST" });
  assert(sandbox.status === 401);
});

test("codemode rejects unauthenticated requests and non-WebSocket upgrades", async () => {
  const url = new URL("/v1/codemode/execute", server.url.replace(/^ws:/, "http:"));
  assert((await fetch(url)).status === 401);
  assert(
    (await fetch(url, { headers: { authorization: `Bearer ${server.apiKey}` } })).status === 426,
  );
});
