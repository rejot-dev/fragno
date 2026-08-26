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

const createRequestUrl = (): string =>
  `https://${crypto.randomUUID()}.backoffice.example/api/backoffice/me`;

const cookieRequest = (token: string, requestUrl: string) =>
  new Request(requestUrl, {
    headers: { cookie: `${backofficeAccessTokenCookieName(false)}=${token}` },
  });

describe("Backoffice JWT verification", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  test("reuses cached JWKS across Durable Object stub instances", async () => {
    const requestUrl = createRequestUrl();
    const pair = await generateKeyPair("ES256");
    const publicJwk = await exportJWK(pair.publicKey);
    const firstFetch = vi
      .fn()
      .mockResolvedValue(Response.json({ keys: [{ ...publicJwk, kid: "key-1", alg: "ES256" }] }));
    const secondFetch = vi.fn().mockRejectedValue(new Error("cached JWKS was not reused"));
    const durableObjectId = { toString: () => "AUTH:singleton" };
    const firstAuthObject = { id: durableObjectId, fetch: firstFetch };
    const secondAuthObject = { id: durableObjectId, fetch: secondFetch };
    const token = await issueJwt(pair.privateKey, "key-1");

    await expect(
      verifyBackofficeJwtRequest(cookieRequest(token, requestUrl), firstAuthObject),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      verifyBackofficeJwtRequest(cookieRequest(token, requestUrl), secondAuthObject),
    ).resolves.toMatchObject({ ok: true });

    expect(firstFetch).toHaveBeenCalledOnce();
    expect(secondFetch).not.toHaveBeenCalled();
  });

  test("refreshes cached JWKS once when a token uses a rotated key", async () => {
    const requestUrl = createRequestUrl();
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
      verifyBackofficeJwtRequest(cookieRequest(firstToken, requestUrl), authObject),
    ).resolves.toEqual({
      ok: true,
      payload: expect.objectContaining({ sub: "user-1" }),
    });

    const secondToken = await issueJwt(secondPair.privateKey, "key-2");
    await expect(
      verifyBackofficeJwtRequest(cookieRequest(secondToken, requestUrl), authObject),
    ).resolves.toEqual({
      ok: true,
      payload: expect.objectContaining({
        organization: { id: "org-1", slug: "acme", roles: ["owner"] },
      }),
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test("limits refreshes for attacker-controlled unknown key ids", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T12:00:00Z"));

    const requestUrl = createRequestUrl();
    const trustedPair = await generateKeyPair("ES256");
    const firstUnknownPair = await generateKeyPair("ES256");
    const secondUnknownPair = await generateKeyPair("ES256");
    const trustedPublicJwk = await exportJWK(trustedPair.publicKey);
    const fetch = vi.fn().mockImplementation(async () =>
      Response.json({
        keys: [{ ...trustedPublicJwk, kid: "trusted-key", alg: "ES256" }],
      }),
    );
    const authObject = { fetch };

    const trustedToken = await issueJwt(trustedPair.privateKey, "trusted-key");
    await expect(
      verifyBackofficeJwtRequest(cookieRequest(trustedToken, requestUrl), authObject),
    ).resolves.toMatchObject({ ok: true });

    const firstUnknownToken = await issueJwt(firstUnknownPair.privateKey, "unknown-key-1");
    await expect(
      verifyBackofficeJwtRequest(cookieRequest(firstUnknownToken, requestUrl), authObject),
    ).resolves.toEqual({ ok: false, reason: "invalid" });

    const secondUnknownToken = await issueJwt(secondUnknownPair.privateKey, "unknown-key-2");
    await expect(
      verifyBackofficeJwtRequest(cookieRequest(secondUnknownToken, requestUrl), authObject),
    ).resolves.toEqual({ ok: false, reason: "invalid" });
    expect(fetch).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(30 * 1_000);
    await expect(
      verifyBackofficeJwtRequest(cookieRequest(secondUnknownToken, requestUrl), authObject),
    ).resolves.toEqual({ ok: false, reason: "invalid" });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  test("coalesces concurrent JWKS cache loads", async () => {
    const requestUrl = createRequestUrl();
    const pair = await generateKeyPair("ES256");
    const publicJwk = await exportJWK(pair.publicKey);
    let resolveJwksResponse!: (response: Response) => void;
    const jwksResponse = new Promise<Response>((resolve) => {
      resolveJwksResponse = resolve;
    });
    const fetch = vi.fn().mockImplementation(async () => await jwksResponse);
    const durableObjectId = { toString: () => "AUTH:singleton" };
    const firstAuthObject = { id: durableObjectId, fetch };
    const secondAuthObject = { id: durableObjectId, fetch };
    const token = await issueJwt(pair.privateKey, "key-1");

    const firstVerification = verifyBackofficeJwtRequest(
      cookieRequest(token, requestUrl),
      firstAuthObject,
    );
    const secondVerification = verifyBackofficeJwtRequest(
      cookieRequest(token, requestUrl),
      secondAuthObject,
    );
    expect(fetch).toHaveBeenCalledOnce();

    resolveJwksResponse(Response.json({ keys: [{ ...publicJwk, kid: "key-1", alg: "ES256" }] }));
    await expect(Promise.all([firstVerification, secondVerification])).resolves.toEqual([
      expect.objectContaining({ ok: true }),
      expect.objectContaining({ ok: true }),
    ]);
    expect(fetch).toHaveBeenCalledOnce();
  });

  test("reloads JWKS after the cache lifetime", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T12:00:00Z"));

    const requestUrl = createRequestUrl();
    const pair = await generateKeyPair("ES256");
    const publicJwk = await exportJWK(pair.publicKey);
    const fetch = vi
      .fn()
      .mockImplementation(async () =>
        Response.json({ keys: [{ ...publicJwk, kid: "key-1", alg: "ES256" }] }),
      );
    const authObject = { fetch };
    const token = await issueJwt(pair.privateKey, "key-1");

    await expect(
      verifyBackofficeJwtRequest(cookieRequest(token, requestUrl), authObject),
    ).resolves.toMatchObject({ ok: true });
    vi.advanceTimersByTime(10 * 60 * 1_000);
    await expect(
      verifyBackofficeJwtRequest(cookieRequest(token, requestUrl), authObject),
    ).resolves.toMatchObject({ ok: true });

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test("propagates JWKS availability failures", async () => {
    const unavailableRequestUrl = createRequestUrl();
    const unavailableAuthObject = {
      fetch: vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 })),
    };

    await expect(
      verifyBackofficeJwtRequest(
        cookieRequest("not-a-jwt", unavailableRequestUrl),
        unavailableAuthObject,
      ),
    ).rejects.toThrow("Better Auth JWKS request failed with status 503.");

    const failedRefreshRequestUrl = createRequestUrl();
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
      verifyBackofficeJwtRequest(
        cookieRequest(firstToken, failedRefreshRequestUrl),
        authObjectWithFailedRefresh,
      ),
    ).resolves.toMatchObject({ ok: true });

    const rotatedToken = await issueJwt(secondPair.privateKey, "key-2");
    await expect(
      verifyBackofficeJwtRequest(
        cookieRequest(rotatedToken, failedRefreshRequestUrl),
        authObjectWithFailedRefresh,
      ),
    ).rejects.toThrow("Better Auth JWKS request failed with status 503.");
  });

  test("distinguishes missing, expired, and invalid credentials", async () => {
    const requestUrl = createRequestUrl();
    const pair = await generateKeyPair("ES256");
    const publicJwk = await exportJWK(pair.publicKey);
    const authObject = {
      fetch: vi
        .fn()
        .mockImplementation(async () =>
          Response.json({ keys: [{ ...publicJwk, kid: "key-1", alg: "ES256" }] }),
        ),
    };

    await expect(verifyBackofficeJwtRequest(new Request(requestUrl), authObject)).resolves.toEqual({
      ok: false,
      reason: "missing",
    });

    const expiredToken = await issueJwt(pair.privateKey, "key-1", 1);
    await expect(
      verifyBackofficeJwtRequest(cookieRequest(expiredToken, requestUrl), authObject),
    ).resolves.toEqual({ ok: false, reason: "expired" });

    await expect(
      verifyBackofficeJwtRequest(cookieRequest("not-a-jwt", requestUrl), authObject),
    ).resolves.toEqual({ ok: false, reason: "invalid" });
  });
});
