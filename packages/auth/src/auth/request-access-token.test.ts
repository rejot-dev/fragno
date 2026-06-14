import { describe, expect, it } from "vitest";

import { verifyAuthAccessTokenFromRequest } from "./request-access-token";
import { mintSessionAccessToken, resolveAccessTokenConfig } from "./session-access-token";
import type { ValidatedCredential } from "./types";

const accessTokenConfig = resolveAccessTokenConfig({
  enabled: true,
  issuer: "https://auth.test",
  audience: "test-app",
  secret: "test-secret-with-enough-entropy",
  issueCookie: true,
  acceptBearer: true,
});

const session: ValidatedCredential = {
  id: "session_123",
  expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  activeOrganizationId: "org_123",
  user: {
    id: "user_123",
    email: "user@test.com",
    role: "admin",
  },
};

describe("verifyAuthAccessTokenFromRequest", () => {
  it("rejects requests with both cookie and bearer access credentials", async () => {
    if (!accessTokenConfig) {
      throw new Error("Expected access token config");
    }

    const issued = await mintSessionAccessToken({ config: accessTokenConfig, session });
    const result = await verifyAuthAccessTokenFromRequest({
      headers: new Headers({
        Cookie: "fragno_auth=not-a-jwt",
        Authorization: `Bearer ${issued.token}`,
      }),
      accessTokens: accessTokenConfig,
    });

    expect(result).toEqual({ ok: false, reason: "multiple" });
  });

  it("does not accept bearer fallback when bearer transport is disabled", async () => {
    const cookieOnlyConfig = resolveAccessTokenConfig({
      enabled: true,
      issuer: "https://auth.test",
      audience: "test-app",
      secret: "test-secret-with-enough-entropy",
      issueCookie: true,
      acceptBearer: false,
    });
    if (!cookieOnlyConfig) {
      throw new Error("Expected access token config");
    }

    const issued = await mintSessionAccessToken({ config: cookieOnlyConfig, session });
    await expect(
      verifyAuthAccessTokenFromRequest({
        headers: new Headers({
          Cookie: "fragno_auth=not-a-jwt",
          Authorization: `Bearer ${issued.token}`,
        }),
        accessTokens: cookieOnlyConfig,
      }),
    ).resolves.toEqual({ ok: false, reason: "multiple" });
  });
});
