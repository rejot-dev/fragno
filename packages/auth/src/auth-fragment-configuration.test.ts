import { afterAll, assert, describe, expect, it } from "vitest";

import { instantiate } from "@fragno-dev/core";
import { buildDatabaseFragmentsTest } from "@fragno-dev/test";

import { authFragmentDefinition } from ".";
import { sessionRoutesFactory } from "./session/session";
import { hashPassword } from "./user/password";
import { userActionsRoutesFactory } from "./user/user-actions";
import { userOverviewRoutesFactory } from "./user/user-overview";

const authHeaders = (token: string) => ({
  Cookie: `fragno_auth=${token}`,
});

const getSetCookieHeaders = (headers: Headers) =>
  (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [
    headers.get("Set-Cookie") ?? "",
  ];

describe("auth-fragment with a custom auth cookie name", async () => {
  const { fragments, test } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "kysely-sqlite" })
    .withFragment(
      "auth",
      instantiate(authFragmentDefinition)
        .withConfig({ cookieOptions: { name: "custom_auth" } })
        .withRoutes([userActionsRoutesFactory, sessionRoutesFactory, userOverviewRoutesFactory]),
    )
    .build();

  const fragment = fragments.auth;

  afterAll(async () => {
    await test.cleanup();
  });

  it("accepts the configured auth cookie on authenticated routes", async () => {
    const response = await fragment.callRoute("POST", "/sign-up", {
      body: {
        email: "custom-cookie@test.com",
        password: "password123",
      },
    });

    assert(response.type === "json");
    assert(response.data.status === "authenticated");
    expect(response.headers.get("Set-Cookie")).toContain("custom_auth=");

    const meResponse = await fragment.callRoute("GET", "/me", {
      headers: {
        Cookie: `custom_auth=${response.data.auth.token}`,
      },
    });

    assert(meResponse.type === "json");
    assert(meResponse.data.user.email === "custom-cookie@test.com");
  });
});

describe("auth-fragment access tokens with a custom auth cookie name", async () => {
  const { fragments, test } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "kysely-sqlite" })
    .withFragment(
      "auth",
      instantiate(authFragmentDefinition)
        .withConfig({
          cookieOptions: { name: "custom_auth" },
          authentication: {
            accessTokens: {
              enabled: true,
              issuer: "https://auth.test",
              audience: "auth-tests",
              secret: "test-secret-with-enough-entropy",
            },
          },
        })
        .withRoutes([userActionsRoutesFactory, sessionRoutesFactory]),
    )
    .build();

  afterAll(async () => {
    await test.cleanup();
  });

  it("issues, reads, and clears the derived refresh cookie name", async () => {
    const response = await fragments.auth.callRoute("POST", "/sign-up", {
      body: { email: "custom-access-cookie@test.com", password: "password123" },
    });
    assert(response.type === "json");
    assert(response.data.status === "authenticated");
    const setCookie = getSetCookieHeaders(response.headers);
    expect(setCookie).toEqual(expect.arrayContaining([expect.stringContaining("custom_auth=")]));
    expect(setCookie).toEqual(
      expect.arrayContaining([expect.stringContaining("custom_auth_refresh=")]),
    );

    const refresh = await fragments.auth.callRoute("POST", "/token/refresh", {
      headers: { Cookie: `custom_auth_refresh=${response.data.auth.refreshToken}` },
      body: {},
    });
    assert(refresh.type === "json");
    assert(refresh.data.auth.kind === "jwt");

    const signOut = await fragments.auth.callRoute("POST", "/sign-out", {
      headers: { Cookie: `custom_auth_refresh=${response.data.auth.refreshToken}` },
      body: {},
    });
    assert(signOut.type === "json");
    const clearCookie = getSetCookieHeaders(signOut.headers);
    expect(clearCookie).toEqual(
      expect.arrayContaining([expect.stringContaining("custom_auth_refresh=")]),
    );
  });
});

describe("auth-fragment email/password disabled", async () => {
  const { fragments, test } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "kysely-sqlite" })
    .withFragment(
      "auth",
      instantiate(authFragmentDefinition)
        .withConfig({
          emailAndPassword: {
            enabled: false,
          },
        })
        .withRoutes([userActionsRoutesFactory]),
    )
    .build();

  const fragment = fragments.auth;

  afterAll(async () => {
    await test.cleanup();
  });

  it("blocks email/password sign-up when disabled", async () => {
    const response = await fragment.callRoute("POST", "/sign-up", {
      body: {
        email: "disabled@test.com",
        password: "password",
      },
    });

    assert(response.type === "error");
    assert(response.error.code === "email_password_disabled");
    assert(response.status === 403);
  });

  it("blocks email/password sign-in when disabled", async () => {
    const response = await fragment.callRoute("POST", "/sign-in", {
      body: {
        email: "disabled@test.com",
        password: "password",
      },
    });

    assert(response.type === "error");
    assert(response.error.code === "email_password_disabled");
    assert(response.status === 403);
  });
});

describe("auth-fragment auto-create organizations", async () => {
  const { fragments, test } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "kysely-sqlite" })
    .withFragment(
      "auth",
      instantiate(authFragmentDefinition)
        .withConfig({
          organizations: {
            autoCreateOrganization: {
              name: ({ email }) => `${email.split("@")[0] ?? "user"} Workspace`,
              slug: ({ email }) => `${email.split("@")[0] ?? "user"}-workspace`,
            },
          },
        })
        .withRoutes([userActionsRoutesFactory, sessionRoutesFactory]),
    )
    .build();

  const fragment = fragments.auth;

  afterAll(async () => {
    await test.cleanup();
  });

  it("creates a default organization on sign up", async () => {
    const signUpResponse = await fragment.callRoute("POST", "/sign-up", {
      body: { email: "auto-org-user@test.com", password: "password" },
    });

    assert(signUpResponse.type === "json");
    assert(signUpResponse.data.status === "authenticated");
    const credentialToken = signUpResponse.data.auth.token as string;

    const meResponse = await fragment.callRoute("GET", "/me", {
      headers: authHeaders(credentialToken),
    });

    assert(meResponse.type === "json");
    expect(meResponse.data.organizations).toHaveLength(1);
    assert(meResponse.data.organizations[0]?.organization.slug === "auto-org-user-workspace");
    expect(meResponse.data.activeOrganization?.organization.id).toBe(
      meResponse.data.organizations[0]?.organization.id ?? null,
    );
  });
});

describe("auth-fragment default auto-create organization slugs", async () => {
  const { fragments, test } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "kysely-sqlite" })
    .withFragment(
      "auth",
      instantiate(authFragmentDefinition)
        .withConfig({
          organizations: {
            autoCreateOrganization: {},
          },
        })
        .withRoutes([userActionsRoutesFactory, sessionRoutesFactory]),
    )
    .build();

  const fragment = fragments.auth;

  afterAll(async () => {
    await test.cleanup();
  });

  it("scopes generated slugs by user so matching email local parts can sign up", async () => {
    const firstSignUpResponse = await fragment.callRoute("POST", "/sign-up", {
      body: { email: "wilco@rejot.dev", password: "password" },
    });
    const secondSignUpResponse = await fragment.callRoute("POST", "/sign-up", {
      body: { email: "wilco@is3a.nl", password: "password" },
    });

    assert(firstSignUpResponse.type === "json");
    assert(firstSignUpResponse.data.status === "authenticated");
    assert(secondSignUpResponse.type === "json");
    assert(secondSignUpResponse.data.status === "authenticated");

    const firstMeResponse = await fragment.callRoute("GET", "/me", {
      headers: authHeaders(firstSignUpResponse.data.auth.token as string),
    });
    const secondMeResponse = await fragment.callRoute("GET", "/me", {
      headers: authHeaders(secondSignUpResponse.data.auth.token as string),
    });

    assert(firstMeResponse.type === "json");
    assert(secondMeResponse.type === "json");

    const firstSlug = firstMeResponse.data.organizations[0]?.organization.slug;
    const secondSlug = secondMeResponse.data.organizations[0]?.organization.slug;

    expect(firstSlug).toMatch(/^wilcos-organization-[a-z0-9]{8}$/);
    expect(secondSlug).toMatch(/^wilcos-organization-[a-z0-9]{8}$/);
    expect(secondSlug).not.toBe(firstSlug);
  });
});

describe("auth-fragment auto-create organization slug collisions", async () => {
  const { fragments, test } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "kysely-sqlite" })
    .withFragment(
      "auth",
      instantiate(authFragmentDefinition)
        .withConfig({
          organizations: {
            autoCreateOrganization: {
              slug: () => "shared-workspace",
            },
          },
        })
        .withRoutes([userActionsRoutesFactory, sessionRoutesFactory]),
    )
    .build();

  const fragment = fragments.auth;

  afterAll(async () => {
    await test.cleanup();
  });

  it("returns a typed error instead of surfacing a database constraint error", async () => {
    const firstSignUpResponse = await fragment.callRoute("POST", "/sign-up", {
      body: { email: "shared-one@test.com", password: "password" },
    });
    const secondSignUpResponse = await fragment.callRoute("POST", "/sign-up", {
      body: { email: "shared-two@test.com", password: "password" },
    });

    assert(firstSignUpResponse.type === "json");
    assert(firstSignUpResponse.data.status === "authenticated");
    assert(secondSignUpResponse.type === "error");
    assert(secondSignUpResponse.status === 400);
    assert(secondSignUpResponse.error.code === "organization_slug_taken");
  });
});

describe("auth-fragment beforeCreateUser hook", async () => {
  const blockedDomain = "blocked.test";
  const hookCalls: string[] = [];
  const { fragments, test } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "kysely-sqlite" })
    .withFragment(
      "auth",
      instantiate(authFragmentDefinition)
        .withConfig({
          beforeCreateUser: ({ email }) => {
            hookCalls.push(email);
            if (email.endsWith(`@${blockedDomain}`)) {
              throw new Error("blocked_domain");
            }
          },
        })
        .withRoutes([]),
    )
    .build();

  const fragment = fragments.auth;

  afterAll(async () => {
    await test.cleanup();
  });

  it("invokes beforeCreateUser and blocks matching domains", async () => {
    const passwordHash = await hashPassword("hookspassword123");
    await expect(
      test.inContext(function () {
        return this.handlerTx()
          .withServiceCalls(() => [
            fragment.services.createUserUnvalidated(`user@${blockedDomain}`, passwordHash, "user"),
          ])
          .execute();
      }),
    ).rejects.toThrow(/blocked_domain/);
  });

  it("blocks sign-up flows when beforeCreateUser throws", async () => {
    const passwordHash = await hashPassword("hookspassword789");
    await expect(
      test.inContext(function () {
        return this.handlerTx()
          .withServiceCalls(() => [
            fragment.services.signUp(`blocked@${blockedDomain}`, passwordHash),
          ])
          .execute();
      }),
    ).rejects.toThrow(/blocked_domain/);
  });

  it("allows user creation when hook passes", async () => {
    const passwordHash = await hashPassword("hookspassword456");
    const [user] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createUserUnvalidated("allowed@test.com", passwordHash),
        ])
        .execute();
    });

    assert(user.email === "allowed@test.com");
    expect(hookCalls).toContain("allowed@test.com");
  });
});

describe("auth-fragment beforeCreateUser role override", async () => {
  const { fragments, test } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "kysely-sqlite" })
    .withFragment(
      "auth",
      instantiate(authFragmentDefinition)
        .withConfig({
          beforeCreateUser: ({ email }) =>
            email.endsWith("@admins.test") ? { role: "admin" } : undefined,
        })
        .withRoutes([userActionsRoutesFactory, sessionRoutesFactory]),
    )
    .build();

  const fragment = fragments.auth;

  afterAll(async () => {
    await test.cleanup();
  });

  it("can promote users during email/password sign-up", async () => {
    const response = await fragment.callRoute("POST", "/sign-up", {
      body: { email: "ada@admins.test", password: "password" },
    });

    assert(response.type === "json");
    assert(response.data.status === "authenticated");
    const meResponse = await fragment.callRoute("GET", "/me", {
      headers: authHeaders(response.data.auth.token as string),
    });

    assert(meResponse.type === "json");
    assert(meResponse.data.user.role === "admin");
  });
});
