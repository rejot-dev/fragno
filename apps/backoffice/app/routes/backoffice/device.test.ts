import { assert, beforeEach, describe, expect, test, vi } from "vitest";

const { callBetterAuth, getAuthDurableObject, getBackofficeCliOAuthConfig } = vi.hoisted(() => ({
  callBetterAuth: vi.fn(),
  getAuthDurableObject: vi.fn(),
  getBackofficeCliOAuthConfig: vi.fn(),
}));

vi.mock("@/fragno/auth/auth-server", () => ({ callBetterAuth }));
vi.mock("@/worker-runtime/durable-objects", () => ({ getAuthDurableObject }));

import { action, loader } from "./device";

const context = {} as never;
const deviceUrl = "https://backoffice.example/backoffice/device?user_code=ABCD-EFGH";
const config = {
  clientId: "codemode-client",
  scope: "openid offline_access backoffice",
  deviceAuthorizationEndpoint: "https://backoffice.example/api/auth/device/code",
  tokenEndpoint: "https://backoffice.example/api/auth/oauth2/token",
  verificationUri: "https://backoffice.example/backoffice/device",
};

function routeArgs(request: Request) {
  return { request, context, url: new URL(request.url), params: {} } as never;
}

function authenticatedSessionResponse() {
  return Response.json({
    user: { id: "user-1", email: "user@example.com" },
    session: { id: "session-1" },
  });
}

function deviceAuthorizationResponse() {
  return Response.json({
    user_code: "ABCD-EFGH",
    status: "pending",
    client_id: config.clientId,
    scope: config.scope,
  });
}

beforeEach(() => {
  callBetterAuth.mockReset();
  getAuthDurableObject.mockReset();
  getBackofficeCliOAuthConfig.mockReset();
  getBackofficeCliOAuthConfig.mockResolvedValue(config);
  getAuthDurableObject.mockReturnValue({ commands: { getBackofficeCliOAuthConfig } });
});

describe("Backoffice device approval route", () => {
  test.each([
    "https://backoffice.example/backoffice/device",
    "https://backoffice.example/backoffice/device?user_code=invalid",
  ])("rejects a missing or invalid user code: %s", async (url) => {
    let thrown: unknown;
    try {
      await loader(routeArgs(new Request(url)));
    } catch (error) {
      thrown = error;
    }

    assert(thrown instanceof Response);
    assert(thrown.status === 400);
    expect(callBetterAuth).not.toHaveBeenCalled();
  });

  test("redirects signed-out users while preserving the device URL", async () => {
    callBetterAuth.mockResolvedValueOnce(Response.json(null));

    let thrown: unknown;
    try {
      await loader(routeArgs(new Request(deviceUrl)));
    } catch (error) {
      thrown = error;
    }

    assert(thrown instanceof Response);
    assert(thrown.status === 302);
    assert.equal(
      thrown.headers.get("location"),
      "/backoffice/login?returnTo=%2Fbackoffice%2Fdevice%3Fuser_code%3DABCD-EFGH",
    );
    expect(getBackofficeCliOAuthConfig).not.toHaveBeenCalled();
  });

  test("loads the first-party device authorization for review", async () => {
    callBetterAuth
      .mockResolvedValueOnce(authenticatedSessionResponse())
      .mockResolvedValueOnce(deviceAuthorizationResponse());

    const result = await loader(routeArgs(new Request(deviceUrl)));

    expect(result).toEqual({
      clientName: "Fragno Backoffice Codemode",
      userCode: "ABCD-EFGH",
      scopes: ["openid", "offline_access", "backoffice"],
    });
  });

  test("approves the claimed device code", async () => {
    callBetterAuth
      .mockResolvedValueOnce(authenticatedSessionResponse())
      .mockResolvedValueOnce(deviceAuthorizationResponse())
      .mockResolvedValueOnce(Response.json({ success: true }));
    const request = new Request(deviceUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ intent: "approve" }),
    });

    const result = await action(routeArgs(request));

    expect(result).toEqual({ status: "approved" });
    expect(callBetterAuth).toHaveBeenLastCalledWith(request, context, "/device/approve", {
      method: "POST",
      body: JSON.stringify({ userCode: "ABCD-EFGH" }),
    });
  });

  test("surfaces malformed Better Auth error responses", async () => {
    callBetterAuth
      .mockResolvedValueOnce(authenticatedSessionResponse())
      .mockResolvedValueOnce(deviceAuthorizationResponse())
      .mockResolvedValueOnce(
        new Response("not-json", {
          status: 502,
          headers: { "content-type": "application/json" },
        }),
      );
    const request = new Request(deviceUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ intent: "approve" }),
    });

    await expect(action(routeArgs(request))).rejects.toBeInstanceOf(SyntaxError);
  });

  test("denies the claimed device code", async () => {
    callBetterAuth
      .mockResolvedValueOnce(authenticatedSessionResponse())
      .mockResolvedValueOnce(deviceAuthorizationResponse())
      .mockResolvedValueOnce(Response.json({ success: true }));
    const request = new Request(deviceUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ intent: "deny" }),
    });

    const result = await action(routeArgs(request));

    expect(result).toEqual({ status: "denied" });
    expect(callBetterAuth).toHaveBeenLastCalledWith(request, context, "/device/deny", {
      method: "POST",
      body: JSON.stringify({ userCode: "ABCD-EFGH" }),
    });
  });
});
