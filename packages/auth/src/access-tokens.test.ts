import { afterAll, assert, describe, expect, it } from "vitest";

import { decodeJwt } from "jose";
import { z } from "zod";

import { instantiate } from "@fragno-dev/core";
import { buildDatabaseFragmentsTest } from "@fragno-dev/test";

import { authFragmentDefinition } from ".";
import { organizationRoutesFactory } from "./organization/routes";
import { authSchema } from "./schema";
import { sessionRoutesFactory } from "./session/session";
import { userActionsRoutesFactory } from "./user/user-actions";

const authHeaders = (token: string) => ({
  Cookie: `fragno_auth=${token}`,
});

const getSetCookieHeaders = (headers: Headers) =>
  (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [
    headers.get("Set-Cookie") ?? "",
  ];

describe("auth-fragment session-backed access tokens", async () => {
  const accessTokenConfig = {
    enabled: true as const,
    issuer: "https://auth.test",
    audience: "auth-tests",
    secret: "test-secret-with-enough-entropy",
  };

  const { fragments, test } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "kysely-sqlite" })
    .withFragment(
      "auth",
      instantiate(authFragmentDefinition)
        .withConfig({ authentication: { accessTokens: accessTokenConfig } })
        .withRoutes([userActionsRoutesFactory, sessionRoutesFactory]),
    )
    .build();

  const fragment = fragments.auth;

  afterAll(async () => {
    await test.cleanup();
  });

  it("issues access and refresh credentials on sign-up and accepts the access cookie", async () => {
    const response = await fragment.callRoute("POST", "/sign-up", {
      body: { email: "access-signup@test.com", password: "password123" },
    });

    assert(response.type === "json");
    assert(response.data.status === "authenticated");
    expect(response.data.auth).toMatchObject({
      token: expect.any(String),
      kind: "jwt",
      refreshToken: expect.any(String),
      activeOrganizationId: null,
    });
    const setCookie = getSetCookieHeaders(response.headers);
    expect(setCookie).toEqual(expect.arrayContaining([expect.stringContaining("fragno_auth=")]));
    expect(setCookie).toEqual(
      expect.arrayContaining([expect.stringContaining("fragno_auth_refresh=")]),
    );

    const meResponse = await fragment.callRoute("GET", "/me", {
      headers: authHeaders(response.data.auth.token),
    });

    assert(meResponse.type === "json");
    assert(meResponse.data.user.email === "access-signup@test.com");
  });

  it("issues access and refresh credentials on sign-in", async () => {
    const signUp = await fragment.callRoute("POST", "/sign-up", {
      body: { email: "access-signin@test.com", password: "password123" },
    });
    assert(signUp.type === "json");
    assert(signUp.data.status === "authenticated");

    const response = await fragment.callRoute("POST", "/sign-in", {
      body: { email: "access-signin@test.com", password: "password123" },
    });

    assert(response.type === "json");
    expect(response.data.auth).toMatchObject({
      token: expect.any(String),
      kind: "jwt",
      refreshToken: expect.any(String),
    });
    expect(response.headers.get("Set-Cookie") ?? "").toContain("fragno_auth_refresh=");
  });

  it("refreshes from the opaque session credential and rejects refresh after a ban", async () => {
    const signUp = await fragment.callRoute("POST", "/sign-up", {
      body: { email: "access-refresh@test.com", password: "password123" },
    });
    assert(signUp.type === "json");
    assert(signUp.data.status === "authenticated");

    const refresh = await fragment.callRoute("POST", "/token/refresh", {
      headers: { Authorization: `Bearer ${signUp.data.auth.refreshToken}` },
      body: {},
    });

    assert(refresh.type === "json");
    expect(refresh.data.auth).toMatchObject({
      kind: "jwt",
      refreshToken: signUp.data.auth.refreshToken,
    });

    await test.inContext(function () {
      return this.handlerTx()
        .mutate(({ forSchema }) => {
          forSchema(authSchema).update("user", signUp.data.userId, (b) =>
            b.set({ bannedAt: new Date() }),
          );
          return true;
        })
        .execute();
    });

    const bannedRefresh = await fragment.callRoute("POST", "/token/refresh", {
      headers: { Authorization: `Bearer ${signUp.data.auth.refreshToken}` },
      body: {},
    });

    assert(bannedRefresh.type === "error");
    assert(bannedRefresh.error.code === "credential_invalid");
    assert(bannedRefresh.status === 401);
  });

  it("rejects malformed, deleted, and expired refresh credentials", async () => {
    const malformed = await fragment.callRoute("POST", "/token/refresh", {
      headers: { Authorization: "Basic nope" },
      body: {},
    });
    assert(malformed.type === "error");
    assert(malformed.error.code === "credential_invalid");
    assert(malformed.status === 400);

    const deleted = await fragment.callRoute("POST", "/sign-up", {
      body: { email: "deleted-refresh@test.com", password: "password123" },
    });
    assert(deleted.type === "json");
    assert(deleted.data.status === "authenticated");
    const deletedRefreshToken = deleted.data.auth.refreshToken;
    if (!deletedRefreshToken) {
      throw new Error("Expected refresh token");
    }
    await test.inContext(function () {
      return this.handlerTx()
        .mutate(({ forSchema }) => {
          forSchema(authSchema).delete("session", deletedRefreshToken, (b) => b);
          return true;
        })
        .execute();
    });
    const deletedRefresh = await fragment.callRoute("POST", "/token/refresh", {
      headers: { Authorization: `Bearer ${deleted.data.auth.refreshToken}` },
      body: {},
    });
    assert(deletedRefresh.type === "error");
    assert(deletedRefresh.status === 401);

    const expired = await fragment.callRoute("POST", "/sign-up", {
      body: { email: "expired-refresh@test.com", password: "password123" },
    });
    assert(expired.type === "json");
    assert(expired.data.status === "authenticated");
    const expiredRefreshToken = expired.data.auth.refreshToken;
    if (!expiredRefreshToken) {
      throw new Error("Expected refresh token");
    }
    await test.inContext(function () {
      return this.handlerTx()
        .mutate(({ forSchema }) => {
          forSchema(authSchema).update("session", expiredRefreshToken, (b) =>
            b.set({ expiresAt: new Date(Date.now() - 60_000) }),
          );
          return true;
        })
        .execute();
    });
    const expiredRefresh = await fragment.callRoute("POST", "/token/refresh", {
      headers: { Authorization: `Bearer ${expired.data.auth.refreshToken}` },
      body: {},
    });
    assert(expiredRefresh.type === "error");
    assert(expiredRefresh.status === 401);

    const bodyOnly = await fragment.callRoute("POST", "/token/refresh", {
      body: { token: expired.data.auth.refreshToken } as never,
    });
    assert(bodyOnly.type === "error");
    assert(bodyOnly.error.code === "credential_invalid");
  });

  it("accepts the refresh cookie on authenticated routes when the access cookie is absent", async () => {
    const signUp = await fragment.callRoute("POST", "/sign-up", {
      body: { email: "refresh-cookie-me@test.com", password: "password123" },
    });
    assert(signUp.type === "json");
    assert(signUp.data.status === "authenticated");

    const meResponse = await fragment.callRoute("GET", "/me", {
      headers: { Cookie: `fragno_auth_refresh=${signUp.data.auth.refreshToken}` },
    });

    assert(meResponse.type === "json");
    assert(meResponse.data.user.email === "refresh-cookie-me@test.com");
  });

  it("rejects refresh requests with both refresh cookie and bearer credentials", async () => {
    const signUp = await fragment.callRoute("POST", "/sign-up", {
      body: { email: "refresh-cookie-over-bearer@test.com", password: "password123" },
    });
    assert(signUp.type === "json");
    assert(signUp.data.status === "authenticated");

    const refresh = await fragment.callRoute("POST", "/token/refresh", {
      headers: {
        Authorization: `Bearer ${signUp.data.auth.token}`,
        Cookie: `fragno_auth_refresh=${signUp.data.auth.refreshToken}`,
      },
      body: {},
    });

    assert(refresh.type === "error");
    assert(refresh.error.code === "credential_invalid");
  });

  it("signs out with a bearer refresh token", async () => {
    const signUp = await fragment.callRoute("POST", "/sign-up", {
      body: { email: "bearer-signout@test.com", password: "password123" },
    });
    assert(signUp.type === "json");
    assert(signUp.data.status === "authenticated");

    const signOut = await fragment.callRoute("POST", "/sign-out", {
      headers: { Authorization: `Bearer ${signUp.data.auth.refreshToken}` },
      body: {},
    });

    assert(signOut.type === "json");
    assert(signOut.data.success);
  });

  it("prefers the refresh cookie over access-token fallback on sign-out", async () => {
    const first = await fragment.callRoute("POST", "/sign-up", {
      body: { email: "refresh-preferred-a@test.com", password: "password123" },
    });
    const second = await fragment.callRoute("POST", "/sign-up", {
      body: { email: "refresh-preferred-b@test.com", password: "password123" },
    });
    assert(first.type === "json");
    assert(first.data.status === "authenticated");
    assert(second.type === "json");
    assert(second.data.status === "authenticated");

    const signOut = await fragment.callRoute("POST", "/sign-out", {
      headers: {
        Cookie: `fragno_auth=${first.data.auth.token}; fragno_auth_refresh=${second.data.auth.refreshToken}`,
      },
      body: {},
    });
    assert(signOut.type === "json");

    const firstRefresh = await fragment.callRoute("POST", "/token/refresh", {
      headers: { Authorization: `Bearer ${first.data.auth.refreshToken}` },
      body: {},
    });
    assert(firstRefresh.type === "json");

    const secondRefresh = await fragment.callRoute("POST", "/token/refresh", {
      headers: { Authorization: `Bearer ${second.data.auth.refreshToken}` },
      body: {},
    });
    assert(secondRefresh.type === "error");
  });

  it("rejects sign-out when only a malformed access token is available", async () => {
    const signOut = await fragment.callRoute("POST", "/sign-out", {
      headers: { Cookie: "fragno_auth=not-a-jwt" },
      body: {},
    });
    assert(signOut.type === "error");
    assert(signOut.error.code === "credential_invalid");
  });

  it("signs out by falling back to sid from a valid access token", async () => {
    const signUp = await fragment.callRoute("POST", "/sign-up", {
      body: { email: "access-signout@test.com", password: "password123" },
    });
    assert(signUp.type === "json");
    assert(signUp.data.status === "authenticated");

    const signOut = await fragment.callRoute("POST", "/sign-out", {
      headers: authHeaders(signUp.data.auth.token),
      body: {},
    });

    assert(signOut.type === "json");
    assert(signOut.data.success);
    const clearCookie = getSetCookieHeaders(signOut.headers);
    expect(clearCookie).toEqual(expect.arrayContaining([expect.stringContaining("fragno_auth=")]));
    expect(clearCookie).toEqual(
      expect.arrayContaining([expect.stringContaining("fragno_auth_refresh=")]),
    );

    const refresh = await fragment.callRoute("POST", "/token/refresh", {
      headers: { Authorization: `Bearer ${signUp.data.auth.refreshToken}` },
      body: {},
    });
    assert(refresh.type === "error");
    assert(refresh.error.code === "credential_invalid");
  });
});

describe("auth-fragment access-token transport restrictions", async () => {
  const { fragments, test } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "kysely-sqlite" })
    .withFragment(
      "auth",
      instantiate(authFragmentDefinition)
        .withConfig({
          authentication: {
            accessTokens: {
              enabled: true,
              issuer: "https://auth.test",
              audience: "auth-tests",
              secret: "test-secret-with-enough-entropy",
              acceptBearer: false,
            },
          },
        })
        .withRoutes([userActionsRoutesFactory, sessionRoutesFactory]),
    )
    .build();

  afterAll(async () => {
    await test.cleanup();
  });

  it("rejects bearer access and refresh credentials when acceptBearer is false", async () => {
    const signUp = await fragments.auth.callRoute("POST", "/sign-up", {
      body: { email: "no-bearer@test.com", password: "password123" },
    });
    assert(signUp.type === "json");
    assert(signUp.data.status === "authenticated");

    const me = await fragments.auth.callRoute("GET", "/me", {
      headers: { Authorization: `Bearer ${signUp.data.auth.token}` },
    });
    assert(me.type === "error");
    assert(me.error.code === "credential_invalid");

    const refresh = await fragments.auth.callRoute("POST", "/token/refresh", {
      headers: { Authorization: `Bearer ${signUp.data.auth.refreshToken}` },
      body: {},
    });
    assert(refresh.type === "error");
    assert(refresh.error.code === "credential_invalid");

    const cookieMe = await fragments.auth.callRoute("GET", "/me", {
      headers: authHeaders(signUp.data.auth.token),
    });
    assert(cookieMe.type === "json");
    assert(cookieMe.data.user.email === "no-bearer@test.com");
  });
});

describe("auth-fragment active organization access-token refresh", async () => {
  const { fragments, test } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "kysely-sqlite" })
    .withFragment(
      "auth",
      instantiate(authFragmentDefinition)
        .withConfig({
          authentication: {
            accessTokens: {
              enabled: true,
              issuer: "https://auth.test",
              audience: "auth-tests",
              secret: "test-secret-with-enough-entropy",
            },
          },
        })
        .withRoutes([userActionsRoutesFactory, sessionRoutesFactory, organizationRoutesFactory]),
    )
    .build();

  afterAll(async () => {
    await test.cleanup();
  });

  it("returns a replacement access token with the updated active organization", async () => {
    const signUp = await fragments.auth.callRoute("POST", "/sign-up", {
      body: { email: "active-access@test.com", password: "password123" },
    });
    assert(signUp.type === "json");
    assert(signUp.data.status === "authenticated");
    const signUpAuth = signUp.data.auth;

    const [created] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragments.auth.services.createOrganizationForCredential({
            credentialToken: signUpAuth.refreshToken ?? "",
            input: { name: "Access Org", slug: "access-org" },
            inputError: null,
          }),
        ])
        .execute();
    });
    if (!created.ok) {
      throw new Error(`Failed to create organization: ${created.code}`);
    }

    const response = await fragments.auth.callRoute("POST", "/organizations/active", {
      headers: { Authorization: `Bearer ${signUp.data.auth.refreshToken}` },
      body: { organizationId: created.organization.id },
    });

    assert(response.type === "json");
    assert(response.data.auth?.kind === "jwt");
    expect(response.data.auth?.activeOrganizationId).toBe(created.organization.id);
    expect(decodeJwt(response.data.auth?.token ?? "")["aorg"]).toBe(created.organization.id);
    expect(decodeJwt(signUp.data.auth.token)["aorg"]).toBeNull();
  });
});

describe("auth-fragment access token organization context", async () => {
  const { fragments, test } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "kysely-sqlite" })
    .withFragment(
      "auth",
      instantiate(authFragmentDefinition)
        .withConfig({
          authentication: {
            accessTokens: {
              enabled: true,
              issuer: "https://auth.test",
              audience: "auth-tests",
              secret: "test-secret-with-enough-entropy",
              context: {
                schema: z.object({ organizationIds: z.array(z.string()) }),
                project: ({ snapshot }) => ({ organizationIds: snapshot.organizationIds }),
              },
            },
          },
          organizations: { autoCreateOrganization: {} },
        })
        .withRoutes([userActionsRoutesFactory, sessionRoutesFactory, organizationRoutesFactory]),
    )
    .build();

  afterAll(async () => {
    await test.cleanup();
  });

  it("projects organization membership ids into access token context", async () => {
    const signUp = await fragments.auth.callRoute("POST", "/sign-up", {
      body: { email: "org-context@test.com", password: "password123" },
    });
    assert(signUp.type === "json");
    assert(signUp.data.status === "authenticated");
    const signUpAuth = signUp.data.auth;

    const initialClaims = decodeJwt(signUpAuth.token) as {
      ctx?: { organizationIds?: string[] };
    };
    expect(initialClaims.ctx?.organizationIds).toEqual([signUpAuth.activeOrganizationId]);

    const [created] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragments.auth.services.createOrganizationForCredential({
            credentialToken: signUpAuth.refreshToken ?? "",
            input: { name: "Second Context Org", slug: "second-context-org" },
            inputError: null,
          }),
        ])
        .execute();
    });
    if (!created.ok) {
      throw new Error(`Failed to create organization: ${created.code}`);
    }

    const refresh = await fragments.auth.callRoute("POST", "/token/refresh", {
      headers: { Cookie: `fragno_auth_refresh=${signUpAuth.refreshToken}` },
      body: {},
    });
    assert(refresh.type === "json");

    const refreshedClaims = decodeJwt(refresh.data.auth.token) as {
      ctx?: { organizationIds?: string[] };
    };
    expect(refreshedClaims.ctx?.organizationIds).toEqual(
      expect.arrayContaining([signUpAuth.activeOrganizationId, created.organization.id]),
    );
  });
});

describe("auth-fragment bearer-only access tokens", async () => {
  const { fragments, test } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "kysely-sqlite" })
    .withFragment(
      "auth",
      instantiate(authFragmentDefinition)
        .withConfig({
          authentication: {
            accessTokens: {
              enabled: true,
              issuer: "https://auth.test",
              audience: "auth-tests",
              secret: "test-secret-with-enough-entropy",
              issueCookie: false,
            },
          },
        })
        .withRoutes([userActionsRoutesFactory, sessionRoutesFactory]),
    )
    .build();

  afterAll(async () => {
    await test.cleanup();
  });

  it("returns bearer credentials without setting auth cookies", async () => {
    const response = await fragments.auth.callRoute("POST", "/sign-up", {
      body: { email: "bearer-only@test.com", password: "password123" },
    });

    assert(response.type === "json");
    assert(response.data.status === "authenticated");
    assert(response.data.auth.kind === "jwt");
    expect(response.data.auth.refreshToken).toEqual(expect.any(String));
    assert(response.headers.get("Set-Cookie") ?? "" === "");

    const refresh = await fragments.auth.callRoute("POST", "/token/refresh", {
      headers: { Authorization: `Bearer ${response.data.auth.refreshToken}` },
      body: {},
    });

    assert(refresh.type === "json");
    assert(refresh.headers.get("Set-Cookie") ?? "" === "");

    const cookieMe = await fragments.auth.callRoute("GET", "/me", {
      headers: authHeaders(response.data.auth.token),
    });
    assert(cookieMe.type === "error");
    assert(cookieMe.error.code === "credential_invalid");

    const cookieRefresh = await fragments.auth.callRoute("POST", "/token/refresh", {
      headers: { Cookie: `fragno_auth_refresh=${response.data.auth.refreshToken}` },
      body: {},
    });
    assert(cookieRefresh.type === "error");
    assert(cookieRefresh.error.code === "credential_invalid");
  });
});
