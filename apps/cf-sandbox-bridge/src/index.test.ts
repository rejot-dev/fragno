import { afterAll, beforeAll, expect, test, assert } from "vitest";

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

test("codemode execution is routed alongside the sandbox API", async () => {
  const execute = createCodemodeNodeExecutor(server);
  const result = await execute(
    {
      kind: "immediate",
      code: "42",
      dependencies: {},
      modules: {},
      providers: [],
      timeoutMs: 10_000,
    },
    createCodemodeHost([], null),
  );
  expect(result).toEqual({ status: "completed", value: 42, logs: [], workflowDefinition: null });
});

test("the health route is public and sandbox routes require the bridge API key", async () => {
  const url = server.url.replace(/^ws:/, "http:");
  const health = await fetch(new URL("/health", url));
  expect(await health.json()).toEqual({ ok: true });
  const sandbox = await fetch(new URL("/v1/sandbox/abc234/snapshot", url), { method: "POST" });
  assert(sandbox.status === 401);
});

test("sandbox routes reject malformed sandbox IDs and start requests before reaching a container", async () => {
  const url = server.url.replace(/^ws:/, "http:");
  const headers = { authorization: `Bearer ${server.apiKey}`, "content-type": "application/json" };
  const invalidId = await fetch(new URL("/v1/sandbox/Not-Base32/snapshot", url), {
    method: "POST",
    headers,
  });
  assert(invalidId.status === 400);
  const invalidStart = await fetch(new URL("/v1/sandbox/abc234/start", url), {
    method: "POST",
    headers,
    body: JSON.stringify({ source: { kind: "image", image: "ubuntu" }, instanceType: "lite" }),
  });
  assert(invalidStart.status === 400);
  expect(await invalidStart.json()).toMatchObject({ code: "invalid_request" });
});
