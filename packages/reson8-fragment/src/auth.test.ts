import { describe, expect, test, assert } from "vitest";

import { createJsonResponse, createReson8TestContext } from "./test-context";

describe("reson8 auth routes", () => {
  test("requests a token with the configured API key when no request Authorization header is provided", async () => {
    const ctx = createReson8TestContext();
    ctx.fetchMock.mockResolvedValue(
      createJsonResponse({
        access_token: "token_123",
        token_type: "Bearer",
        expires_in: 600,
      }),
    );

    const response = await ctx.fragment.callRoute("POST", "/auth/token");

    expect(ctx.fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = ctx.fetchMock.mock.calls[0];
    const headers = new Headers(init?.headers);

    expect(url).toBe("https://api.reson8.dev/v1/auth/token");
    assert(init?.method === "POST");
    assert(headers.get("authorization") === "ApiKey test-api-key");

    assert(response.type === "json");
    if (response.type !== "json") {
      return;
    }

    expect(response.data).toEqual({
      access_token: "token_123",
      token_type: "Bearer",
      expires_in: 600,
    });
  });

  test("returns UNAUTHORIZED before hitting the upstream API when no credentials are configured", async () => {
    const ctx = createReson8TestContext({
      apiKey: undefined,
      defaultAuthorization: undefined,
    });

    const response = await ctx.fragment.callRoute("POST", "/auth/token");

    expect(ctx.fetchMock).not.toHaveBeenCalled();
    assert(response.type === "error");
    if (response.type !== "error") {
      return;
    }

    assert(response.status === 401);
    expect(response.error).toEqual({
      code: "UNAUTHORIZED",
      message:
        "Missing Reson8 credentials. Provide an Authorization header or configure apiKey/defaultAuthorization.",
    });
  });
});
