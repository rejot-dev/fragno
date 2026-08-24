import { beforeEach, describe, expect, test, vi } from "vitest";

import { exportJWK, generateKeyPair, SignJWT } from "jose";

import {
  ACCESS_TOKEN_AUDIENCE,
  ACCESS_TOKEN_ISSUER,
  backofficeAccessTokenCookieName,
  verifyBackofficeJwtRequest,
} from "./token-lifecycle";

const issueJwt = async (
  privateKey: CryptoKey,
  kid: string,
  expirationTime: string | number = "15m",
) =>
  await new SignJWT({
    email: "user@example.com",
    globalRole: "admin",
    organization: { id: "org-1", slug: "acme", roles: ["owner"] },
    jti: crypto.randomUUID(),
  })
    .setProtectedHeader({ alg: "ES256", kid })
    .setSubject("user-1")
    .setIssuer(ACCESS_TOKEN_ISSUER)
    .setAudience(ACCESS_TOKEN_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(expirationTime)
    .sign(privateKey);

const cookieRequest = (token: string) =>
  new Request("https://backoffice.example/api/backoffice/me", {
    headers: { cookie: `${backofficeAccessTokenCookieName(false)}=${token}` },
  });

describe("Backoffice JWT verification", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  test("refreshes cached JWKS once when a token uses a rotated key", async () => {
    const firstPair = await generateKeyPair("ES256");
    const secondPair = await generateKeyPair("ES256");
    const firstPublicJwk = await exportJWK(firstPair.publicKey);
    const secondPublicJwk = await exportJWK(secondPair.publicKey);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ keys: [{ ...firstPublicJwk, kid: "key-1", alg: "ES256" }] }),
      )
      .mockResolvedValueOnce(
        Response.json({ keys: [{ ...secondPublicJwk, kid: "key-2", alg: "ES256" }] }),
      );
    const authObject = { fetch };

    const firstToken = await issueJwt(firstPair.privateKey, "key-1");
    await expect(
      verifyBackofficeJwtRequest(cookieRequest(firstToken), authObject),
    ).resolves.toEqual({
      ok: true,
      payload: expect.objectContaining({ sub: "user-1" }),
    });

    const secondToken = await issueJwt(secondPair.privateKey, "key-2");
    await expect(
      verifyBackofficeJwtRequest(cookieRequest(secondToken), authObject),
    ).resolves.toEqual({
      ok: true,
      payload: expect.objectContaining({
        organization: { id: "org-1", slug: "acme", roles: ["owner"] },
      }),
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test("propagates JWKS availability failures", async () => {
    const unavailableAuthObject = {
      fetch: vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 })),
    };

    await expect(
      verifyBackofficeJwtRequest(cookieRequest("not-a-jwt"), unavailableAuthObject),
    ).rejects.toThrow("Better Auth JWKS request failed with status 503.");

    const firstPair = await generateKeyPair("ES256");
    const secondPair = await generateKeyPair("ES256");
    const firstPublicJwk = await exportJWK(firstPair.publicKey);
    const authObjectWithFailedRefresh = {
      fetch: vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({ keys: [{ ...firstPublicJwk, kid: "key-1", alg: "ES256" }] }),
        )
        .mockResolvedValueOnce(new Response("unavailable", { status: 503 })),
    };

    const firstToken = await issueJwt(firstPair.privateKey, "key-1");
    await expect(
      verifyBackofficeJwtRequest(cookieRequest(firstToken), authObjectWithFailedRefresh),
    ).resolves.toMatchObject({ ok: true });

    const rotatedToken = await issueJwt(secondPair.privateKey, "key-2");
    await expect(
      verifyBackofficeJwtRequest(cookieRequest(rotatedToken), authObjectWithFailedRefresh),
    ).rejects.toThrow("Better Auth JWKS request failed with status 503.");
  });

  test("distinguishes missing, expired, and invalid credentials", async () => {
    const pair = await generateKeyPair("ES256");
    const publicJwk = await exportJWK(pair.publicKey);
    const authObject = {
      fetch: vi
        .fn()
        .mockResolvedValue(Response.json({ keys: [{ ...publicJwk, kid: "key-1", alg: "ES256" }] })),
    };

    await expect(
      verifyBackofficeJwtRequest(
        new Request("https://backoffice.example/api/backoffice/me"),
        authObject,
      ),
    ).resolves.toEqual({ ok: false, reason: "missing" });

    const expiredToken = await issueJwt(pair.privateKey, "key-1", 1);
    await expect(
      verifyBackofficeJwtRequest(cookieRequest(expiredToken), authObject),
    ).resolves.toEqual({ ok: false, reason: "expired" });

    await expect(
      verifyBackofficeJwtRequest(cookieRequest("not-a-jwt"), authObject),
    ).resolves.toEqual({ ok: false, reason: "invalid" });
  });
});
