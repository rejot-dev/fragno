import { describe, expect, it, vi, assert } from "vitest";

import { decodeJwt, SignJWT } from "jose";
import { z } from "zod";

import {
  buildIssuedCredentialHeaders,
  createSessionCredentialStrategy,
} from "./credential-strategy";
import {
  mintSessionAccessToken,
  resolveAccessTokenConfig,
  verifySessionAccessToken,
} from "./session-access-token";
import type { ValidatedCredential } from "./types";

const accessTokenConfig = resolveAccessTokenConfig({
  enabled: true,
  issuer: "https://auth.test",
  audience: "test-app",
  secret: "test-secret-with-enough-entropy",
});

const session: ValidatedCredential = {
  id: "session_123",
  expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  activeOrganizationId: "org_123",
  sessionContext: { tenant: "acme", secret: "do-not-copy" },
  user: {
    id: "user_123",
    email: "user@test.com",
    role: "admin",
  },
};

describe("session-backed access tokens", () => {
  it("validates required access-token config", () => {
    expect(() =>
      resolveAccessTokenConfig({
        enabled: true,
        issuer: "https://auth.test",
        audience: "test-app",
        secret: "test-secret-with-enough-entropy",
        acceptBearer: false,
        issueCookie: false,
      }),
    ).toThrow(/at least one transport/);

    expect(() =>
      resolveAccessTokenConfig({
        enabled: true,
        issuer: "",
        audience: "test-app",
        secret: "test-secret-with-enough-entropy",
      }),
    ).toThrow(/issuer, audience, and secret/);
  });
  it("mints and verifies a session-backed access token principal", async () => {
    if (!accessTokenConfig) {
      throw new Error("Expected config");
    }

    const issued = await mintSessionAccessToken({ config: accessTokenConfig, session });
    assert(issued.kind === "jwt");
    assert(issued.refreshToken === "session_123");
    expect(issued.refreshExpiresAt).toEqual(session.expiresAt);

    const principal = await verifySessionAccessToken({
      config: accessTokenConfig,
      token: issued.token,
      source: "authorization-header",
    });

    expect(principal).toMatchObject({
      user: {
        id: "user_123",
        email: "user@test.com",
        role: "admin",
      },
      auth: {
        strategy: "session",
        credentialKind: "jwt",
        credentialSource: "authorization-header",
        credentialId: "session_123",
        activeOrganizationId: "org_123",
        sessionContext: {},
      },
    });
  });

  it("caps access token expiry by the backing session expiry", async () => {
    const config = resolveAccessTokenConfig({
      enabled: true,
      issuer: "https://auth.test",
      audience: "test-app",
      secret: "test-secret-with-enough-entropy",
      expiresInSeconds: 60 * 60,
    });
    if (!config) {
      throw new Error("Expected config");
    }
    const expiresAt = new Date(Date.now() + 30_000);

    const issued = await mintSessionAccessToken({
      config,
      session: { ...session, expiresAt },
    });

    expect(decodeJwt(issued.token).exp).toBe(Math.floor(expiresAt.getTime() / 1000));
  });

  it("rejects access tokens with invalid issuer or audience", async () => {
    if (!accessTokenConfig) {
      throw new Error("Expected config");
    }
    const issued = await mintSessionAccessToken({ config: accessTokenConfig, session });
    const wrongAudience = resolveAccessTokenConfig({
      enabled: true,
      issuer: "https://auth.test",
      audience: "other-app",
      secret: "test-secret-with-enough-entropy",
    });
    if (!wrongAudience) {
      throw new Error("Expected config");
    }

    await expect(
      verifySessionAccessToken({
        config: wrongAudience,
        token: issued.token,
        source: "authorization-header",
      }),
    ).resolves.toBeNull();
  });

  it("rejects access tokens with invalid signature, expiry, type, or claim shape", async () => {
    if (!accessTokenConfig) {
      throw new Error("Expected config");
    }
    const issued = await mintSessionAccessToken({ config: accessTokenConfig, session });
    const wrongSecret = resolveAccessTokenConfig({
      enabled: true,
      issuer: "https://auth.test",
      audience: "test-app",
      secret: "different-secret-with-enough-entropy",
    });
    if (!wrongSecret) {
      throw new Error("Expected config");
    }

    await expect(
      verifySessionAccessToken({
        config: wrongSecret,
        token: issued.token,
        source: "authorization-header",
      }),
    ).resolves.toBeNull();

    const key = new TextEncoder().encode("test-secret-with-enough-entropy");
    const expired = await new SignJWT({
      typ: "fragno-auth-session-access",
      sid: "session_123",
      email: "user@test.com",
      role: "admin",
      aorg: null,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("https://auth.test")
      .setAudience("test-app")
      .setSubject("user_123")
      .setIssuedAt(Math.floor(Date.now() / 1000) - 120)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(key);

    await expect(
      verifySessionAccessToken({ config: accessTokenConfig, token: expired, source: "cookie" }),
    ).resolves.toBeNull();

    const wrongType = await new SignJWT({
      typ: "other-token",
      sid: "session_123",
      email: "user@test.com",
      role: "admin",
      aorg: null,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("https://auth.test")
      .setAudience("test-app")
      .setSubject("user_123")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(key);

    await expect(
      verifySessionAccessToken({ config: accessTokenConfig, token: wrongType, source: "cookie" }),
    ).resolves.toBeNull();

    const malformedClaims = await new SignJWT({
      typ: "fragno-auth-session-access",
      sid: "session_123",
      email: "user@test.com",
      role: "owner",
      aorg: null,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("https://auth.test")
      .setAudience("test-app")
      .setSubject("user_123")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(key);

    await expect(
      verifySessionAccessToken({
        config: accessTokenConfig,
        token: malformedClaims,
        source: "cookie",
      }),
    ).resolves.toBeNull();

    const missingSid = await new SignJWT({
      typ: "fragno-auth-session-access",
      email: "user@test.com",
      role: "admin",
      aorg: null,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("https://auth.test")
      .setAudience("test-app")
      .setSubject("user_123")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(key);

    await expect(
      verifySessionAccessToken({ config: accessTokenConfig, token: missingSid, source: "cookie" }),
    ).resolves.toBeNull();
  });

  it("projects, validates, sizes, and verifies ctx claims", async () => {
    const config = resolveAccessTokenConfig({
      enabled: true,
      issuer: "https://auth.test",
      audience: "test-app",
      secret: "test-secret-with-enough-entropy",
      context: {
        schema: z.object({ tenant: z.string() }),
        project: ({ snapshot }) => ({
          tenant: (snapshot.session.context as { tenant: string }).tenant,
        }),
        maxBytes: 64,
      },
    });
    if (!config) {
      throw new Error("Expected config");
    }

    const issued = await mintSessionAccessToken({ config, session });
    const principal = await verifySessionAccessToken({
      config,
      token: issued.token,
      source: "cookie",
    });

    expect(principal?.auth.sessionContext).toEqual({ tenant: "acme" });

    const tooSmall = resolveAccessTokenConfig({
      enabled: true,
      issuer: "https://auth.test",
      audience: "test-app",
      secret: "test-secret-with-enough-entropy",
      context: {
        schema: z.object({ tenant: z.string() }),
        project: () => ({ tenant: "value-too-large" }),
        maxBytes: 4,
      },
    });
    if (!tooSmall) {
      throw new Error("Expected config");
    }

    await expect(mintSessionAccessToken({ config: tooSmall, session })).rejects.toThrow(/maxBytes/);
  });

  it("omits null ctx and rejects undefined or schema-invalid projections", async () => {
    const nullConfig = resolveAccessTokenConfig({
      enabled: true,
      issuer: "https://auth.test",
      audience: "test-app",
      secret: "test-secret-with-enough-entropy",
      context: {
        schema: z.object({ tenant: z.string() }),
        project: () => null,
      },
    });
    if (!nullConfig) {
      throw new Error("Expected config");
    }
    expect(
      decodeJwt((await mintSessionAccessToken({ config: nullConfig, session })).token),
    ).not.toHaveProperty("ctx");

    const undefinedConfig = resolveAccessTokenConfig({
      enabled: true,
      issuer: "https://auth.test",
      audience: "test-app",
      secret: "test-secret-with-enough-entropy",
      context: {
        schema: z.unknown(),
        project: () => undefined as never,
      },
    });
    if (!undefinedConfig) {
      throw new Error("Expected config");
    }
    await expect(mintSessionAccessToken({ config: undefinedConfig, session })).rejects.toThrow(
      /projector/,
    );

    const invalidConfig = resolveAccessTokenConfig({
      enabled: true,
      issuer: "https://auth.test",
      audience: "test-app",
      secret: "test-secret-with-enough-entropy",
      context: {
        schema: z.object({ tenant: z.string() }),
        project: () => ({ tenant: 123 }) as never,
      },
    });
    if (!invalidConfig) {
      throw new Error("Expected config");
    }
    await expect(mintSessionAccessToken({ config: invalidConfig, session })).rejects.toThrow(
      /Invalid access token context/,
    );
  });

  it("rejects ctx claims that fail verification-time schema validation", async () => {
    const signingConfig = resolveAccessTokenConfig({
      enabled: true,
      issuer: "https://auth.test",
      audience: "test-app",
      secret: "test-secret-with-enough-entropy",
      context: {
        schema: z.object({ tenant: z.string() }),
        project: () => ({ tenant: "acme" }),
      },
    });
    const verifyingConfig = resolveAccessTokenConfig({
      enabled: true,
      issuer: "https://auth.test",
      audience: "test-app",
      secret: "test-secret-with-enough-entropy",
      context: {
        schema: z.object({ tenant: z.literal("other") }),
        project: () => ({ tenant: "other" }),
      },
    });
    if (!signingConfig || !verifyingConfig) {
      throw new Error("Expected config");
    }
    const issued = await mintSessionAccessToken({ config: signingConfig, session });

    await expect(
      verifySessionAccessToken({ config: verifyingConfig, token: issued.token, source: "cookie" }),
    ).resolves.toBeNull();
  });

  it("can suppress access and refresh cookies for bearer-only clients", async () => {
    if (!accessTokenConfig) {
      throw new Error("Expected config");
    }
    const issued = await mintSessionAccessToken({ config: accessTokenConfig, session });

    expect(buildIssuedCredentialHeaders(issued, undefined, { issueCookie: false })).toEqual([]);
  });

  it("normal request auth from access token does not validate the session row", async () => {
    const validateCredential = vi.fn(async () => null);
    const strategy = createSessionCredentialStrategy({
      accessTokens: {
        enabled: true,
        issuer: "https://auth.test",
        audience: "test-app",
        secret: "test-secret-with-enough-entropy",
      },
      validateCredential,
      issueCredential: vi.fn(),
      invalidateCredential: vi.fn(async () => true),
    });
    if (!accessTokenConfig) {
      throw new Error("Expected config");
    }
    const issued = await mintSessionAccessToken({ config: accessTokenConfig, session });

    const result = await strategy.resolveRequestAuth({
      headers: new Headers({ Authorization: `Bearer ${issued.token}` }),
    });

    assert(result.ok);
    expect(validateCredential).not.toHaveBeenCalled();
  });
});
