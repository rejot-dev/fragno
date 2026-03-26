import { describe, expect, test } from "vitest";

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
    expect(init?.method).toBe("POST");
    expect(headers.get("authorization")).toBe("ApiKey test-api-key");

    expect(response.type).toBe("json");
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
    expect(response.type).toBe("error");
    if (response.type !== "error") {
      return;
    }

    expect(response.status).toBe(401);
    expect(response.error).toEqual({
      code: "UNAUTHORIZED",
      message:
        "Missing Reson8 credentials. Provide an Authorization header or configure apiKey/defaultAuthorization.",
    });
  });
});
