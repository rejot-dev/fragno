import { describe, expect, it } from "vitest";

import { getRequestAuth, parseBearerToken, resolveRequestCredential } from "./request-auth";

describe("request auth helpers", () => {
  it("parses bearer tokens and rejects malformed authorization headers", () => {
    expect(parseBearerToken(null)).toBeNull();
    expect(parseBearerToken("Bearer token-123")).toBe("token-123");
    expect(parseBearerToken("Basic token-123")).toBe("malformed");
    expect(parseBearerToken("Bearer   ")).toBe("malformed");
  });

  it("prefers authorization headers over cookies", () => {
    const result = resolveRequestCredential(
      new Headers({
        Authorization: "Bearer bearer-token",
        Cookie: "fragno_auth=cookie-token",
      }),
    );

    expect(result).toEqual({
      ok: true,
      credential: {
        token: "bearer-token",
        source: "authorization-header",
      },
    });
  });

  it("falls back to the auth cookie when no authorization header is present", () => {
    const result = resolveRequestCredential(new Headers({ Cookie: "fragno_auth=cookie-token" }));

    expect(result).toEqual({
      ok: true,
      credential: {
        token: "cookie-token",
        source: "cookie",
      },
    });
  });

  it("supports a configured auth cookie name", () => {
    const result = resolveRequestCredential(new Headers({ Cookie: "custom_auth=cookie-token" }), {
      name: "custom_auth",
    });

    expect(result).toEqual({
      ok: true,
      credential: {
        token: "cookie-token",
        source: "cookie",
      },
    });
  });

  it("treats malformed authorization headers as errors even when a cookie exists", () => {
    const result = resolveRequestCredential(
      new Headers({
        Authorization: "Token nope",
        Cookie: "fragno_auth=cookie-token",
      }),
    );

    expect(result).toEqual({ ok: false, reason: "malformed" });
  });

  it("reports missing credentials when no supported transport is present", () => {
    expect(resolveRequestCredential(new Headers())).toEqual({ ok: false, reason: "missing" });
  });

  it("delegates request auth resolution through the configured strategy", async () => {
    const strategy = {
      name: "session" as const,
      resolveRequestAuth: async () => ({ ok: false as const, reason: "invalid" as const }),
      issueCredential: async () => {
        throw new Error("not implemented in test");
      },
      clearCredential: async () => ({ headers: {} }),
    };

    await expect(
      getRequestAuth({
        headers: new Headers({ Authorization: "Bearer ignored" }),
        strategy,
      }),
    ).resolves.toEqual({ ok: false, reason: "invalid" });
  });
});
