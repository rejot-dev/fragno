import { assert, expect, test, vi } from "vitest";

import { Hono } from "hono";

import type { SandboxBridgeHonoEnv } from "./sandbox-bridge-http-env";
import { registerSandboxLifecycleHttpRoutes } from "./sandbox-lifecycle-http-routes";

function createSandboxLifecycleRouteTestApp() {
  const configurePool = vi.fn(async () => undefined);
  const getContainer = vi.fn(async () => "container-123");
  const configureSandbox = vi.fn(async () => undefined);
  const app = new Hono<SandboxBridgeHonoEnv>();
  registerSandboxLifecycleHttpRoutes(app);
  const env = {
    SANDBOX_API_KEY: "sandbox-api-key",
    WARM_POOL_TARGET: "0",
    WARM_POOL_REFRESH_INTERVAL: "10000",
    WarmPool: {
      idFromName: vi.fn(() => "pool-id"),
      get: vi.fn(() => ({ configure: configurePool, getContainer })),
    },
    Sandbox: {
      idFromName: vi.fn(() => "sandbox-id"),
      get: vi.fn(() => ({ configure: configureSandbox })),
    },
  } as unknown as Env;
  return { app, env, configurePool, getContainer, configureSandbox };
}

test("configures keepAlive and sleepAfter on the assigned bridge sandbox", async () => {
  const testApp = createSandboxLifecycleRouteTestApp();
  const response = await testApp.app.fetch(
    new Request("http://bridge.test/v1/sandbox/abc234/configuration", {
      method: "PUT",
      headers: {
        authorization: "Bearer sandbox-api-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({ keepAlive: true, sleepAfter: "15m" }),
    }),
    testApp.env,
  );

  assert(response.status === 200);
  expect(await response.json()).toEqual({ ok: true });
  expect(testApp.configurePool).toHaveBeenCalledWith({
    warmTarget: 0,
    refreshInterval: 10_000,
  });
  expect(testApp.getContainer).toHaveBeenCalledWith("abc234");
  expect(testApp.configureSandbox).toHaveBeenCalledWith({
    keepAlive: true,
    sleepAfter: "15m",
  });
});

test("rejects unauthenticated and malformed lifecycle configuration", async () => {
  const testApp = createSandboxLifecycleRouteTestApp();
  const unauthorized = await testApp.app.fetch(
    new Request("http://bridge.test/v1/sandbox/abc234/configuration", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keepAlive: true }),
    }),
    testApp.env,
  );
  assert(unauthorized.status === 401);
  expect(await unauthorized.json()).toEqual({ code: "unauthorized", error: "Unauthorized" });

  const malformed = await testApp.app.fetch(
    new Request("http://bridge.test/v1/sandbox/abc234/configuration", {
      method: "PUT",
      headers: {
        authorization: "Bearer sandbox-api-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({ sleepAfter: -1 }),
    }),
    testApp.env,
  );
  assert(malformed.status === 400);
  expect(await malformed.json()).toEqual({
    code: "invalid_request",
    error: "Lifecycle configuration requires keepAlive or sleepAfter with valid values.",
  });
  expect(testApp.getContainer).not.toHaveBeenCalled();
  expect(testApp.configureSandbox).not.toHaveBeenCalled();
});
