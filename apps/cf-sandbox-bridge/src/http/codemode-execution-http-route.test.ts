import { afterAll, beforeAll, test, assert } from "vitest";

import { CODEMODE_EXECUTION_HTTP_PATH } from "@fragno-dev/codemode/execution/codemode-activation-contract";

import { createCodemodeBridgeTestServer } from "../testing/codemode-bridge-test-server";

let server: Awaited<ReturnType<typeof createCodemodeBridgeTestServer>>;
beforeAll(async () => {
  server = await createCodemodeBridgeTestServer();
});
afterAll(async () => {
  await server?.close();
});

test("codemode rejects unauthenticated requests and non-WebSocket upgrades", async () => {
  const url = new URL(CODEMODE_EXECUTION_HTTP_PATH, server.url.replace(/^ws:/, "http:"));
  assert((await fetch(url)).status === 401);
  assert(
    (await fetch(url, { headers: { authorization: `Bearer ${server.apiKey}` } })).status === 426,
  );
});

test("authenticated execution requests require GET and reject query parameters", async () => {
  const url = new URL(CODEMODE_EXECUTION_HTTP_PATH, server.url.replace(/^ws:/, "http:"));
  const headers = { authorization: `Bearer ${server.apiKey}` };
  const wrongMethod = await fetch(url, { method: "POST", headers });
  assert(wrongMethod.status === 405);
  assert(wrongMethod.headers.get("allow") === "GET");
  url.search = "unexpected=value";
  assert((await fetch(url, { headers })).status === 404);
});
