import { assert, beforeEach, describe, expect, test, vi } from "vitest";

const { exchangeBackofficeOAuthAccessToken, getAuthDurableObject } = vi.hoisted(() => ({
  exchangeBackofficeOAuthAccessToken: vi.fn(),
  getAuthDurableObject: vi.fn(),
}));

vi.mock("@/worker-runtime/durable-objects", () => ({ getAuthDurableObject }));

import {
  BackofficeCliScopeAuthorizationError,
  BackofficeCliOAuthAuthenticationError,
} from "@/fragno/auth/contracts";

import { action } from "./backoffice-cli-token";

const context = {} as never;
const validResult = {
  accessToken: "backoffice-jwt",
  expiresAt: "2026-08-22T12:15:00.000Z",
  scope: { kind: "org", orgId: "org-1" },
};

function request(authorization: string | null, body: unknown = { scope: null }) {
  return new Request("https://backoffice.example/api/backoffice/cli-token", {
    method: "POST",
    headers: {
      ...(authorization ? { authorization } : {}),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  exchangeBackofficeOAuthAccessToken.mockReset();
  getAuthDurableObject.mockReset();
  getAuthDurableObject.mockReturnValue({ commands: { exchangeBackofficeOAuthAccessToken } });
});

describe("Backoffice CLI token route", () => {
  test.each([null, "Basic credential", "Bearer", "Bearer token with-space"])(
    "rejects malformed authorization header %s",
    async (authorization) => {
      const response = await action({ request: request(authorization), context } as never);

      assert(response.status === 401);
      expect(exchangeBackofficeOAuthAccessToken).not.toHaveBeenCalled();
    },
  );

  test("maps an invalid OAuth token to 401", async () => {
    exchangeBackofficeOAuthAccessToken.mockRejectedValue(
      new BackofficeCliOAuthAuthenticationError("invalid token"),
    );

    const response = await action({ request: request("Bearer oauth-token"), context } as never);

    assert(response.status === 401);
    expect(await response.json()).toMatchObject({ error: "authentication_failed" });
  });

  test("returns the scope-authorized Backoffice bearer token", async () => {
    exchangeBackofficeOAuthAccessToken.mockResolvedValue(validResult);

    const response = await action({ request: request("Bearer oauth-token"), context } as never);

    assert(response.status === 200);
    expect(await response.json()).toEqual(validResult);
    expect(exchangeBackofficeOAuthAccessToken).toHaveBeenCalledWith({
      requestUrl: "https://backoffice.example/api/backoffice/cli-token",
      oauthAccessToken: "oauth-token",
      scope: null,
    });
  });

  test("maps an unavailable scope to 403", async () => {
    exchangeBackofficeOAuthAccessToken.mockRejectedValue(
      new BackofficeCliScopeAuthorizationError(
        "The requested scope is not available to this user.",
      ),
    );

    const response = await action({
      request: request("Bearer oauth-token", { scope: { kind: "org", orgId: "org-missing" } }),
      context,
    } as never);

    assert(response.status === 403);
    expect(await response.json()).toMatchObject({ error: "scope_unavailable" });
  });
});
