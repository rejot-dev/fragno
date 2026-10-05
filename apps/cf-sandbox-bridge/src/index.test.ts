import { afterAll, beforeAll, expect, test, assert } from "vitest";

import { readFile } from "node:fs/promises";
import path from "node:path";

import { createCodemodeHost } from "@fragno-dev/codemode/host/codemode-host-capabilities";
import { createCodemodeNodeExecutor } from "@fragno-dev/codemode/remote/codemode-node-executor";

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

test("codemode execution is routed before the Sandbox SDK fallback", async () => {
  const execute = createCodemodeNodeExecutor(server);
  const result = await execute(
    { kind: "immediate", code: "42", dependencies: {}, providers: [], timeoutMs: 10_000 },
    createCodemodeHost([], null),
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
