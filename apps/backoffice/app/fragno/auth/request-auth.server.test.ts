import { beforeEach, describe, expect, test, vi, assert } from "vitest";

import { exportJWK, generateKeyPair, SignJWT } from "jose";

const { authObject, getAuthDurableObjectMock } = vi.hoisted(() => ({
  authObject: { fetch: vi.fn() },
  getAuthDurableObjectMock: vi.fn(),
}));

vi.mock("@/worker-runtime/durable-objects", () => ({
  getAuthDurableObject: getAuthDurableObjectMock,
}));

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
    scope: { kind: "org", orgId: "org-1" },
    organizationRoles: ["owner"],
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

describe("Backoffice request authentication", () => {
  beforeEach(() => {
    authObject.fetch.mockReset();
    getAuthDurableObjectMock.mockReturnValue(authObject);
  });

  test("authenticates the same JWT from a bearer header", async () => {
    const { token, publicJwk } = await issueJwt();
    authObject.fetch.mockResolvedValue(Response.json({ keys: [publicJwk] }));

    await expect(
      requireBackofficePrincipal(
        new Request("https://backoffice.example/private", {
          headers: { authorization: `Bearer ${token}`, cookie: "unrelated=value" },
        }),
        {} as never,
      ),
    ).resolves.toMatchObject({
      user: { id: "user-1", role: "admin" },
      auth: {
        transport: "bearer",
        scope: { kind: "org", orgId: "org-1" },
        organizationRoles: ["owner"],
      },
    });
  });

  test("authenticates the browser JWT while ignoring Better Auth cookies", async () => {
    const { token, publicJwk } = await issueJwt();
    authObject.fetch.mockResolvedValue(Response.json({ keys: [publicJwk] }));

    await expect(
      requireBackofficePrincipal(
        new Request("https://backoffice.example/private", {
          headers: {
            cookie: `${backofficeAccessTokenCookieName(false)}=${token}; better-auth.session_token=session`,
          },
        }),
        {} as never,
      ),
    ).resolves.toMatchObject({
      auth: { transport: "cookie", scope: { kind: "org", orgId: "org-1" } },
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
      requireBackofficePrincipal(
        new Request("https://backoffice.example/private", {
          headers: { cookie: "better-auth.session_token=opaque-session" },
        }),
        {} as never,
      ),
    ).rejects.toMatchObject({ status: 401 });
    expect(authObject.fetch).not.toHaveBeenCalled();
  });

  test("rejects opaque bearer session tokens", async () => {
    await expect(
      requireBackofficePrincipal(
        new Request("https://backoffice.example/private", {
          headers: { authorization: "Bearer opaque-better-auth-session" },
        }),
        {} as never,
      ),
    ).rejects.toMatchObject({ status: 401 });
  });

  test("marks expired authorization responses for browser token recovery", async () => {
    const { token, publicJwk } = await issueJwt(Math.floor(Date.now() / 1_000) - 1);
    authObject.fetch.mockResolvedValue(Response.json({ keys: [publicJwk] }));

    const authorization = await authorizeBackofficePrincipal(
      new Request("https://backoffice.example/private", {
        headers: { cookie: `${backofficeAccessTokenCookieName(false)}=${token}` },
      }),
      {} as never,
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
    authObject.fetch.mockResolvedValue(Response.json({ keys: [publicJwk] }));
    const requests = [
      new Request("https://backoffice.example/private", {
        headers: { authorization: `Bearer ${token}` },
      }),
      new Request("https://backoffice.example/private", {
        headers: { cookie: `${backofficeAccessTokenCookieName(false)}=${token}` },
      }),
    ];

    for (const request of requests) {
      await expect(requireBackofficePrincipal(request, {} as never)).rejects.toMatchObject({
        status: 401,
      });
    }
  });
});
