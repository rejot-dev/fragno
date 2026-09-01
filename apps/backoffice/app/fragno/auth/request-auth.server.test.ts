import { beforeEach, describe, expect, test, vi, assert } from "vitest";

import { exportJWK, generateKeyPair, SignJWT } from "jose";

const { authObject } = vi.hoisted(() => ({
  authObject: { http: { fetch: vi.fn() } },
}));

import { createBackofficeRouterContextProvider } from "@/worker-runtime/router-context-provider.server";

import { BACKOFFICE_AUTH_ERROR_HEADER, BACKOFFICE_TOKEN_EXPIRED_CODE } from "./contracts";
import { resolveBackofficeJwtTransport } from "./jwt-transport";
import { authorizeBackofficePrincipal, requireBackofficePrincipal } from "./request-auth.server";
import { backofficeAccessTokenCookieName } from "./token-lifecycle";

const issueJwt = async (expirationTime: string | number = "15m") => {
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  const publicJwk = await exportJWK(publicKey);
  const token = await new SignJWT({
    email: "user@example.com",
    globalRole: "admin",
    organization: { id: "org-1", slug: "acme", roles: ["owner"] },
    jti: crypto.randomUUID(),
  })
    .setProtectedHeader({ alg: "ES256", kid: crypto.randomUUID() })
    .setSubject("user-1")
    .setIssuer("fragno-backoffice-auth")
    .setAudience("fragno-backoffice")
    .setIssuedAt()
    .setExpirationTime(expirationTime)
    .sign(privateKey);
  const protectedHeader = JSON.parse(atob(token.split(".")[0]!)) as { kid: string };
  return {
    token,
    publicJwk: { ...publicJwk, alg: "ES256", kid: protectedHeader.kid, use: "sig" },
  };
};

function createRequestContext(request: Request) {
  return createBackofficeRouterContextProvider(request, {
    runtime: {
      objects: { auth: { singleton: () => authObject } },
    } as never,
    kernel: {} as never,
    env: {} as CloudflareEnv,
    ctx: {} as ExecutionContext,
  });
}

function requirePrincipalForRequest(request: Request) {
  return requireBackofficePrincipal(request, createRequestContext(request));
}

function authorizePrincipalForRequest(request: Request) {
  return authorizeBackofficePrincipal(request, createRequestContext(request));
}

describe("Backoffice request authentication", () => {
  beforeEach(() => {
    authObject.http.fetch.mockReset();
  });

  test("authenticates the same JWT from a bearer header", async () => {
    const { token, publicJwk } = await issueJwt();
    authObject.http.fetch.mockResolvedValue(Response.json({ keys: [publicJwk] }));

    await expect(
      requirePrincipalForRequest(
        new Request("https://backoffice.example/private", {
          headers: { authorization: `Bearer ${token}`, cookie: "unrelated=value" },
        }),
      ),
    ).resolves.toMatchObject({
      user: { id: "user-1", role: "admin" },
      auth: {
        transport: "bearer",
        organization: { id: "org-1", slug: "acme", roles: ["owner"] },
      },
    });
  });

  test("authenticates the browser JWT while ignoring Better Auth cookies", async () => {
    const { token, publicJwk } = await issueJwt();
    authObject.http.fetch.mockResolvedValue(Response.json({ keys: [publicJwk] }));

    await expect(
      requirePrincipalForRequest(
        new Request("https://backoffice.example/private", {
          headers: {
            cookie: `${backofficeAccessTokenCookieName(false)}=${token}; better-auth.session_token=session`,
          },
        }),
      ),
    ).resolves.toMatchObject({
      auth: {
        transport: "cookie",
        organization: { id: "org-1", slug: "acme", roles: ["owner"] },
      },
    });
  });

  test("does not fall back to a valid cookie after malformed authorization", () => {
    const request = new Request("https://backoffice.example/private", {
      headers: {
        authorization: "Basic opaque-session",
        cookie: `${backofficeAccessTokenCookieName(false)}=valid-looking-cookie`,
      },
    });
    expect(resolveBackofficeJwtTransport(request)).toEqual({ ok: false, reason: "invalid" });
  });

  test("does not authorize a Better Auth session cookie", async () => {
    await expect(
      requirePrincipalForRequest(
        new Request("https://backoffice.example/private", {
          headers: { cookie: "better-auth.session_token=opaque-session" },
        }),
      ),
    ).rejects.toMatchObject({ status: 401 });
    expect(authObject.http.fetch).not.toHaveBeenCalled();
  });

  test("rejects opaque bearer session tokens", async () => {
    await expect(
      requirePrincipalForRequest(
        new Request("https://backoffice.example/private", {
          headers: { authorization: "Bearer opaque-better-auth-session" },
        }),
      ),
    ).rejects.toMatchObject({ status: 401 });
  });

  test("marks expired authorization responses for browser token recovery", async () => {
    const { token, publicJwk } = await issueJwt(Math.floor(Date.now() / 1_000) - 1);
    authObject.http.fetch.mockResolvedValue(Response.json({ keys: [publicJwk] }));

    const authorization = await authorizePrincipalForRequest(
      new Request("https://backoffice.example/private", {
        headers: { cookie: `${backofficeAccessTokenCookieName(false)}=${token}` },
      }),
    );

    assert(!authorization.ok);
    assert(authorization.response.status === 401);
    expect(authorization.response.headers.get(BACKOFFICE_AUTH_ERROR_HEADER)).toBe(
      BACKOFFICE_TOKEN_EXPIRED_CODE,
    );
    expect(authorization.response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  test("reports expired cookie and bearer JWTs consistently", async () => {
    const { token, publicJwk } = await issueJwt(Math.floor(Date.now() / 1_000) - 1);
    authObject.http.fetch.mockResolvedValue(Response.json({ keys: [publicJwk] }));
    const requests = [
      new Request("https://backoffice.example/private", {
        headers: { authorization: `Bearer ${token}` },
      }),
      new Request("https://backoffice.example/private", {
        headers: { cookie: `${backofficeAccessTokenCookieName(false)}=${token}` },
      }),
    ];

    for (const request of requests) {
      await expect(requirePrincipalForRequest(request)).rejects.toMatchObject({ status: 401 });
    }
  });
});
