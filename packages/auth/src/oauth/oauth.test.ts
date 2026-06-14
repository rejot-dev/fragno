import { afterAll, assert, describe, expect, it } from "vitest";

import { instantiate } from "@fragno-dev/core";
import { buildDatabaseFragmentsTest } from "@fragno-dev/test";

import { authFragmentDefinition } from "..";
import { authSchema } from "../schema";
import { sessionRoutesFactory } from "../session/session";
import { hashPassword } from "../user/password";
import { oauthRoutesFactory } from "./routes";
import type { OAuthProvider, ProviderOptions } from "./types";

const redirectURI = "http://localhost:3000/api/auth/oauth/test/callback";

const authHeaders = (token: string) => ({
  Cookie: `fragno_auth=${token}`,
});

const createTestProvider = (options: {
  id: string;
  name?: string;
  newEmail?: string;
  linkedEmail?: string;
  providerOptions?: Partial<ProviderOptions>;
  createAuthorizationURL?: OAuthProvider["createAuthorizationURL"];
  validateAuthorizationCode?: OAuthProvider["validateAuthorizationCode"];
  getUserInfo?: OAuthProvider["getUserInfo"];
}): OAuthProvider => {
  const providerId = options.id;
  const newEmail = options.newEmail ?? `${providerId}-new@test.com`;
  const linkedEmail = options.linkedEmail ?? `${providerId}-linked@test.com`;

  const defaultCreateAuthorizationURL: OAuthProvider["createAuthorizationURL"] = ({
    state,
    redirectURI: redirect,
  }) => {
    const url = new URL("https://example.com/oauth/authorize");
    url.searchParams.set("state", state);
    url.searchParams.set("redirect_uri", redirect);
    return url;
  };

  const defaultValidateAuthorizationCode: OAuthProvider["validateAuthorizationCode"] = async ({
    code,
  }) => {
    if (!code || code === "invalid") {
      return null;
    }
    return {
      accessToken: code,
      tokenType: "bearer",
    };
  };

  const defaultGetUserInfo: OAuthProvider["getUserInfo"] = async (token) => {
    const accessToken = token.accessToken;
    if (!accessToken) {
      return null;
    }

    if (accessToken === "linked") {
      return {
        user: {
          id: `provider-linked-${providerId}`,
          email: linkedEmail,
          emailVerified: true,
          name: "Linked User",
        },
        data: { id: `provider-linked-${providerId}`, email: linkedEmail },
      };
    }

    return {
      user: {
        id: `provider-new-${providerId}`,
        email: newEmail,
        emailVerified: true,
        name: "New User",
      },
      data: { id: `provider-new-${providerId}`, email: newEmail },
    };
  };

  return {
    id: providerId,
    name: options.name ?? "Test",
    options: {
      redirectURI,
      ...options.providerOptions,
    },
    createAuthorizationURL: options.createAuthorizationURL ?? defaultCreateAuthorizationURL,
    validateAuthorizationCode:
      options.validateAuthorizationCode ?? defaultValidateAuthorizationCode,
    getUserInfo: options.getUserInfo ?? defaultGetUserInfo,
  };
};

const testProvider = createTestProvider({
  id: "test",
  newEmail: "new@test.com",
  linkedEmail: "linked@test.com",
});
const disableSignUpProvider = createTestProvider({
  id: "test-disable-signup",
  providerOptions: {
    disableSignUp: true,
  },
});
const disableImplicitProvider = createTestProvider({
  id: "test-disable-implicit",
  providerOptions: {
    disableImplicitSignUp: true,
  },
});
const disableImplicitExistingProvider = createTestProvider({
  id: "test-disable-implicit-existing",
  newEmail: "implicit-existing@test.com",
  providerOptions: {
    disableImplicitSignUp: true,
  },
});
const returnToProvider = createTestProvider({
  id: "test-returnto",
});
const linkProvider = createTestProvider({
  id: "test-link",
});
const scopeProvider = createTestProvider({
  id: "test-scope",
  createAuthorizationURL: ({ state, redirectURI, scopes, loginHint }) => {
    const url = new URL("https://example.com/oauth/authorize");
    url.searchParams.set("state", state);
    url.searchParams.set("redirect_uri", redirectURI);
    if (scopes?.length) {
      url.searchParams.set("scope", scopes.join("|"));
    }
    if (loginHint) {
      url.searchParams.set("login_hint", loginHint);
    }
    return url;
  },
});
const nullUserProvider = createTestProvider({
  id: "test-null-user",
  getUserInfo: async () => null,
});
const noEmailProvider = createTestProvider({
  id: "test-no-email",
  getUserInfo: async () => {
    return {
      user: {
        id: "provider-no-email",
        email: null,
        emailVerified: false,
        name: "No Email",
      },
      data: { id: "provider-no-email" },
    };
  },
});
const unverifiedEmailProvider = createTestProvider({
  id: "test-unverified-email",
  getUserInfo: async (token) => {
    const accessToken = token.accessToken ?? "unknown";
    return {
      user: {
        id: `provider-unverified-${accessToken}`,
        email: "unverified@test.com",
        emailVerified: false,
        name: "Unverified User",
      },
      data: { id: `provider-unverified-${accessToken}`, email: "unverified@test.com" },
    };
  },
});
const unverifiedImplicitProvider = createTestProvider({
  id: "test-unverified-implicit",
  providerOptions: {
    disableImplicitSignUp: true,
  },
  getUserInfo: async () => {
    return {
      user: {
        id: "provider-unverified-implicit",
        email: "unverified-implicit@test.com",
        emailVerified: false,
        name: "Unverified Implicit User",
      },
      data: { id: "provider-unverified-implicit", email: "unverified-implicit@test.com" },
    };
  },
});
const bannedProvider = createTestProvider({
  id: "test-banned",
  newEmail: "banned@test.com",
});
const tokenProvider = createTestProvider({
  id: "test-token",
  validateAuthorizationCode: async () => {
    return {
      accessToken: "access-1",
      refreshToken: "refresh-1",
      idToken: "id-1",
      tokenType: "bearer",
      accessTokenExpiresAt: new Date(0),
      scopes: ["read", "write"],
    };
  },
});
const getSetCookieHeaders = (headers: Headers) =>
  (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [
    headers.get("Set-Cookie") ?? "",
  ];

const tokenUpdateProvider = createTestProvider({
  id: "test-token-update",
  validateAuthorizationCode: async () => {
    return {
      accessToken: "access-updated",
      refreshToken: "refresh-updated",
      idToken: "id-updated",
      tokenType: "bearer",
      accessTokenExpiresAt: new Date(10),
      scopes: ["repo"],
    };
  },
});

describe("auth oauth access tokens", async () => {
  const { fragments, test } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "kysely-sqlite" })
    .withFragment(
      "auth",
      instantiate(authFragmentDefinition)
        .withConfig({
          organizations: false,
          authentication: {
            accessTokens: {
              enabled: true,
              issuer: "https://auth.test",
              audience: "auth-tests",
              secret: "test-secret-with-enough-entropy",
            },
          },
          oauth: {
            providers: {
              test: createTestProvider({
                id: "test-oauth-access",
                newEmail: "oauth-access@test.com",
              }),
            },
          },
        })
        .withRoutes([oauthRoutesFactory]),
    )
    .build();

  afterAll(async () => {
    await test.cleanup();
  });

  it("issues access and refresh credentials on callback", async () => {
    const authorize = await fragments.auth.callRoute("GET", "/oauth/:provider/authorize", {
      pathParams: { provider: "test" },
      query: {},
    });
    assert(authorize.type === "json");
    const state = new URL(authorize.data.url).searchParams.get("state") ?? "";

    const callback = await fragments.auth.callRoute("GET", "/oauth/:provider/callback", {
      pathParams: { provider: "test" },
      query: { code: "oauth-code", state },
    });

    assert(callback.type === "json");
    assert(callback.data.email === "oauth-access@test.com");
    expect(callback.data.auth).toMatchObject({
      kind: "jwt",
      token: expect.any(String),
      refreshToken: expect.any(String),
    });
    const setCookie = getSetCookieHeaders(callback.headers);
    expect(setCookie).toEqual(expect.arrayContaining([expect.stringContaining("fragno_auth=")]));
    expect(setCookie).toEqual(
      expect.arrayContaining([expect.stringContaining("fragno_auth_refresh=")]),
    );
  });

  it("sets access and refresh cookies on redirect callbacks", async () => {
    const authorize = await fragments.auth.callRoute("GET", "/oauth/:provider/authorize", {
      pathParams: { provider: "test" },
      query: { returnTo: "/app" },
    });
    assert(authorize.type === "json");
    const state = new URL(authorize.data.url).searchParams.get("state") ?? "";

    const callback = await fragments.auth.callRoute("GET", "/oauth/:provider/callback", {
      pathParams: { provider: "test" },
      query: { code: "oauth-redirect-code", state },
    });

    assert(callback.type === "empty");
    assert(callback.status === 302);
    assert(callback.headers.get("Location") === "/app");
    const setCookie = getSetCookieHeaders(callback.headers);
    expect(setCookie).toEqual(expect.arrayContaining([expect.stringContaining("fragno_auth=")]));
    expect(setCookie).toEqual(
      expect.arrayContaining([expect.stringContaining("fragno_auth_refresh=")]),
    );
  });
});

describe("auth oauth", async () => {
  const { fragments, test } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "kysely-sqlite" })
    .withFragment(
      "auth",
      instantiate(authFragmentDefinition)
        .withConfig({
          organizations: false,
          oauth: {
            providers: {
              test: testProvider,
              "test-disable-signup": disableSignUpProvider,
              "test-disable-implicit": disableImplicitProvider,
              "test-disable-implicit-existing": disableImplicitExistingProvider,
              "test-returnto": returnToProvider,
              "test-link": linkProvider,
              "test-scope": scopeProvider,
              "test-null-user": nullUserProvider,
              "test-no-email": noEmailProvider,
              "test-unverified-email": unverifiedEmailProvider,
              "test-unverified-implicit": unverifiedImplicitProvider,
              "test-banned": bannedProvider,
            },
          },
        })
        .withRoutes([oauthRoutesFactory]),
    )
    .build();

  const fragment = fragments.auth;

  afterAll(async () => {
    await test.cleanup();
  });

  const getState = async (
    providerId: string,
    query: Record<string, string> = {},
  ): Promise<string> => {
    const response = await fragment.callRoute("GET", "/oauth/:provider/authorize", {
      pathParams: { provider: providerId },
      query,
    });

    assert(response.type === "json");
    const state = new URL(response.data.url).searchParams.get("state");
    return state ?? "";
  };

  it("/oauth/:provider/authorize returns an authorization url", async () => {
    const response = await fragment.callRoute("GET", "/oauth/:provider/authorize", {
      pathParams: { provider: "test" },
      query: {},
    });

    assert(response.type === "json");
    const url = new URL(response.data.url);
    assert(url.hostname === "example.com");
    expect(url.searchParams.get("redirect_uri")).toBe(redirectURI);
    const state = url.searchParams.get("state");
    expect(state).toBeTruthy();
  });

  it("/oauth/:provider/callback creates a user + session", async () => {
    const authorizeResponse = await fragment.callRoute("GET", "/oauth/:provider/authorize", {
      pathParams: { provider: "test" },
      query: {},
    });

    assert(authorizeResponse.type === "json");
    const state = new URL(authorizeResponse.data.url).searchParams.get("state");
    expect(state).toBeTruthy();

    const response = await fragment.callRoute("GET", "/oauth/:provider/callback", {
      pathParams: { provider: "test" },
      query: {
        code: "new",
        state: state ?? "",
      },
    });

    assert(response.type === "json");
    assert(response.data.email === "new@test.com");
    expect(response.data.auth.token).toBeTruthy();
  });

  it("links oauth account by email when user exists", async () => {
    const passwordHash = await hashPassword("password-123");
    const [existingUser] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createUserUnvalidated("linked@test.com", passwordHash),
        ])
        .execute();
    });

    const authorizeResponse = await fragment.callRoute("GET", "/oauth/:provider/authorize", {
      pathParams: { provider: "test" },
      query: {},
    });

    assert(authorizeResponse.type === "json");
    const state = new URL(authorizeResponse.data.url).searchParams.get("state");
    expect(state).toBeTruthy();

    const callbackResponse = await fragment.callRoute("GET", "/oauth/:provider/callback", {
      pathParams: { provider: "test" },
      query: {
        code: "linked",
        state: state ?? "",
      },
    });

    assert(callbackResponse.type === "json");
    expect(callbackResponse.data.userId).toBe(existingUser.id);
    assert(callbackResponse.data.email === "linked@test.com");

    expect(callbackResponse.data.userId).toBe(existingUser.id);
  });

  it("does not link oauth accounts when provider email is unverified", async () => {
    const passwordHash = await hashPassword("password-123");
    const [existingUser] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createUserUnvalidated("unverified@test.com", passwordHash),
        ])
        .execute();
    });

    const authorizeResponse = await fragment.callRoute("GET", "/oauth/:provider/authorize", {
      pathParams: { provider: "test-unverified-email" },
      query: {},
    });

    assert(authorizeResponse.type === "json");
    const state = new URL(authorizeResponse.data.url).searchParams.get("state");
    expect(state).toBeTruthy();

    const callbackResponse = await fragment.callRoute("GET", "/oauth/:provider/callback", {
      pathParams: { provider: "test-unverified-email" },
      query: {
        code: "link-session",
        state: state ?? "",
      },
    });

    assert(callbackResponse.type === "json");
    assert(callbackResponse.data.email === "unverified@test.com");
    expect(callbackResponse.data.userId).not.toBe(existingUser.id);
  });

  it("requires signup when email is unverified and implicit sign up is disabled", async () => {
    const passwordHash = await hashPassword("password-123");
    await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createUserUnvalidated("unverified-implicit@test.com", passwordHash),
        ])
        .execute();
    });

    const state = await getState("test-unverified-implicit");
    const response = await fragment.callRoute("GET", "/oauth/:provider/callback", {
      pathParams: { provider: "test-unverified-implicit" },
      query: {
        code: "new",
        state,
      },
    });

    assert(response.type === "error");
    assert(response.error.code === "signup_required");
    assert(response.status === 403);
  });

  it("links providers via session even when provider email is unverified", async () => {
    const passwordHash = await hashPassword("password-123");
    const [user] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createUserUnvalidated("link-unverified@test.com", passwordHash),
        ])
        .execute();
    });

    const [sessionResult] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [fragment.services.issueCredential(user.id)])
        .execute();
    });

    assert(sessionResult.ok);

    const authorizeResponse = await fragment.callRoute("GET", "/oauth/:provider/authorize", {
      pathParams: { provider: "test-unverified-email" },
      query: {
        link: "true",
      },
      headers: authHeaders(sessionResult.credential.id),
    });

    assert(authorizeResponse.type === "json");
    const state = new URL(authorizeResponse.data.url).searchParams.get("state");
    expect(state).toBeTruthy();

    const callbackResponse = await fragment.callRoute("GET", "/oauth/:provider/callback", {
      pathParams: { provider: "test-unverified-email" },
      query: {
        code: "new",
        state: state ?? "",
      },
    });

    assert(callbackResponse.type === "json");
    expect(callbackResponse.data.userId).toBe(user.id);
    assert(callbackResponse.data.email === "link-unverified@test.com");
  });

  it("respects disableSignUp from provider options", async () => {
    const authorizeResponse = await fragment.callRoute("GET", "/oauth/:provider/authorize", {
      pathParams: { provider: "test-disable-signup" },
      query: {},
    });

    assert(authorizeResponse.type === "json");
    const state = new URL(authorizeResponse.data.url).searchParams.get("state");
    expect(state).toBeTruthy();

    const callbackResponse = await fragment.callRoute("GET", "/oauth/:provider/callback", {
      pathParams: { provider: "test-disable-signup" },
      query: {
        code: "new",
        state: state ?? "",
      },
    });

    assert(callbackResponse.type === "error");
    assert(callbackResponse.error.code === "signup_disabled");
    assert(callbackResponse.status === 403);
  });

  it("respects disableImplicitSignUp from provider options", async () => {
    const authorizeResponse = await fragment.callRoute("GET", "/oauth/:provider/authorize", {
      pathParams: { provider: "test-disable-implicit" },
      query: {},
    });

    assert(authorizeResponse.type === "json");
    const state = new URL(authorizeResponse.data.url).searchParams.get("state");
    expect(state).toBeTruthy();

    const callbackResponse = await fragment.callRoute("GET", "/oauth/:provider/callback", {
      pathParams: { provider: "test-disable-implicit" },
      query: {
        code: "new",
        state: state ?? "",
      },
    });

    assert(callbackResponse.type === "error");
    assert(callbackResponse.error.code === "signup_required");
    assert(callbackResponse.status === 403);

    const authorizeResponseWithSignup = await fragment.callRoute(
      "GET",
      "/oauth/:provider/authorize",
      {
        pathParams: { provider: "test-disable-implicit" },
        query: {},
      },
    );

    assert(authorizeResponseWithSignup.type === "json");
    const stateWithSignup = new URL(authorizeResponseWithSignup.data.url).searchParams.get("state");
    expect(stateWithSignup).toBeTruthy();

    const callbackResponseWithSignup = await fragment.callRoute(
      "GET",
      "/oauth/:provider/callback",
      {
        pathParams: { provider: "test-disable-implicit" },
        query: {
          code: "new",
          state: stateWithSignup ?? "",
          requestSignUp: "true",
        },
      },
    );

    assert(callbackResponseWithSignup.type === "json");
    assert(callbackResponseWithSignup.data.email === "test-disable-implicit-new@test.com");
  });

  it("requires a session when linking providers", async () => {
    const unauthorizedResponse = await fragment.callRoute("GET", "/oauth/:provider/authorize", {
      pathParams: { provider: "test-link" },
      query: {
        link: "true",
      },
    });

    assert(unauthorizedResponse.type === "error");
    assert(unauthorizedResponse.error.code === "credential_invalid");
    assert(unauthorizedResponse.status === 400);

    const passwordHash = await hashPassword("password-123");
    const [user] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createUserUnvalidated("link@test.com", passwordHash),
        ])
        .execute();
    });

    const [sessionResult] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [fragment.services.issueCredential(user.id)])
        .execute();
    });

    assert(sessionResult.ok);

    const authorizedResponse = await fragment.callRoute("GET", "/oauth/:provider/authorize", {
      pathParams: { provider: "test-link" },
      query: {
        link: "true",
      },
      headers: {
        Cookie: `fragno_auth=${sessionResult.credential.id}`,
      },
    });

    assert(authorizedResponse.type === "json");
    expect(authorizedResponse.data.url).toContain("example.com");
  });

  it("sanitizes returnTo to relative paths", async () => {
    const authorizeResponse = await fragment.callRoute("GET", "/oauth/:provider/authorize", {
      pathParams: { provider: "test-returnto" },
      query: {
        returnTo: "https://evil.com/steal",
      },
    });

    assert(authorizeResponse.type === "json");
    const state = new URL(authorizeResponse.data.url).searchParams.get("state");
    expect(state).toBeTruthy();

    const callbackResponse = await fragment.callRoute("GET", "/oauth/:provider/callback", {
      pathParams: { provider: "test-returnto" },
      query: {
        code: "new",
        state: state ?? "",
      },
    });

    assert(callbackResponse.type === "json");
    expect(callbackResponse.data.returnTo).toBeNull();
  });

  it("returns a relative returnTo and redirects", async () => {
    const authorizeResponse = await fragment.callRoute("GET", "/oauth/:provider/authorize", {
      pathParams: { provider: "test-returnto" },
      query: {
        returnTo: "/app",
      },
    });

    assert(authorizeResponse.type === "json");
    const state = new URL(authorizeResponse.data.url).searchParams.get("state");
    expect(state).toBeTruthy();

    const callbackResponse = await fragment.callRoute("GET", "/oauth/:provider/callback", {
      pathParams: { provider: "test-returnto" },
      query: {
        code: "new",
        state: state ?? "",
      },
    });

    assert(callbackResponse.type === "empty");
    assert(callbackResponse.status === 302);
    assert(callbackResponse.headers.get("Location") === "/app");
  });

  it("rejects protocol-relative returnTo paths", async () => {
    const authorizeResponse = await fragment.callRoute("GET", "/oauth/:provider/authorize", {
      pathParams: { provider: "test-returnto" },
      query: {
        returnTo: "//evil.com",
      },
    });

    assert(authorizeResponse.type === "json");
    const state = new URL(authorizeResponse.data.url).searchParams.get("state");
    expect(state).toBeTruthy();

    const callbackResponse = await fragment.callRoute("GET", "/oauth/:provider/callback", {
      pathParams: { provider: "test-returnto" },
      query: {
        code: "new",
        state: state ?? "",
      },
    });

    assert(callbackResponse.type === "json");
    expect(callbackResponse.data.returnTo).toBeNull();
  });

  it("passes parsed scopes and loginHint to the provider", async () => {
    const response = await fragment.callRoute("GET", "/oauth/:provider/authorize", {
      pathParams: { provider: "test-scope" },
      query: {
        scope: "read,write openid",
        loginHint: "user@test.com",
      },
    });

    assert(response.type === "json");
    const url = new URL(response.data.url);
    assert(url.searchParams.get("scope") === "read|write|openid");
    assert(url.searchParams.get("login_hint") === "user@test.com");
  });

  it("returns provider_not_found for unknown providers", async () => {
    const authorizeResponse = await fragment.callRoute("GET", "/oauth/:provider/authorize", {
      pathParams: { provider: "missing" },
      query: {},
    });

    assert(authorizeResponse.type === "error");
    assert(authorizeResponse.error.code === "provider_not_found");
    assert(authorizeResponse.status === 404);

    const callbackResponse = await fragment.callRoute("GET", "/oauth/:provider/callback", {
      pathParams: { provider: "missing" },
      query: {
        code: "new",
        state: "missing-state",
      },
    });

    assert(callbackResponse.type === "error");
    assert(callbackResponse.error.code === "provider_not_found");
    assert(callbackResponse.status === 404);
  });

  it("rejects redirectUri mismatches on authorize", async () => {
    const response = await fragment.callRoute("GET", "/oauth/:provider/authorize", {
      pathParams: { provider: "test" },
      query: {
        redirectUri: "http://localhost:3000/api/auth/oauth/other/callback",
      },
    });

    assert(response.type === "error");
    assert(response.error.code === "redirect_uri_mismatch");
    assert(response.status === 400);
  });

  it("requires code and state on callback", async () => {
    const missingCode = await fragment.callRoute("GET", "/oauth/:provider/callback", {
      pathParams: { provider: "test" },
      query: {
        state: "state",
      },
    });

    assert(missingCode.type === "error");
    assert(missingCode.error.code === "invalid_code");
    assert(missingCode.status === 400);

    const missingState = await fragment.callRoute("GET", "/oauth/:provider/callback", {
      pathParams: { provider: "test" },
      query: {
        code: "new",
      },
    });

    assert(missingState.type === "error");
    assert(missingState.error.code === "invalid_state");
    assert(missingState.status === 400);
  });

  it("returns invalid_code when the token exchange fails", async () => {
    const state = await getState("test");
    const response = await fragment.callRoute("GET", "/oauth/:provider/callback", {
      pathParams: { provider: "test" },
      query: {
        code: "invalid",
        state,
      },
    });

    assert(response.type === "error");
    assert(response.error.code === "invalid_code");
    assert(response.status === 401);
  });

  it("returns invalid_code when the provider returns no profile", async () => {
    const state = await getState("test-null-user");
    const response = await fragment.callRoute("GET", "/oauth/:provider/callback", {
      pathParams: { provider: "test-null-user" },
      query: {
        code: "new",
        state,
      },
    });

    assert(response.type === "error");
    assert(response.error.code === "invalid_code");
    assert(response.status === 401);
  });

  it("requires an email in the provider profile", async () => {
    const state = await getState("test-no-email");
    const response = await fragment.callRoute("GET", "/oauth/:provider/callback", {
      pathParams: { provider: "test-no-email" },
      query: {
        code: "new",
        state,
      },
    });

    assert(response.type === "error");
    assert(response.error.code === "email_required");
    assert(response.status === 400);
  });

  it("consumes oauth state when email is missing", async () => {
    const state = await getState("test-no-email");
    const response = await fragment.callRoute("GET", "/oauth/:provider/callback", {
      pathParams: { provider: "test-no-email" },
      query: {
        code: "new",
        state,
      },
    });

    assert(response.type === "error");
    assert(response.error.code === "email_required");
    assert(response.status === 400);

    const oauthState = await test.inContext(function () {
      return this.handlerTx()
        .retrieve(({ forSchema }) =>
          forSchema(authSchema).findFirst("oauthState", (b) =>
            b.whereIndex("idx_oauth_state_state", (eb) => eb("state", "=", state)),
          ),
        )
        .transformRetrieve(([result]) => result)
        .execute();
    });

    expect(oauthState).toBeNull();
  });

  it("returns invalid_state for missing or mismatched state", async () => {
    const missingState = await fragment.callRoute("GET", "/oauth/:provider/callback", {
      pathParams: { provider: "test" },
      query: {
        code: "new",
        state: "missing-state",
      },
    });

    assert(missingState.type === "error");
    assert(missingState.error.code === "invalid_state");
    assert(missingState.status === 400);

    const mismatchedState = await getState("test");
    const mismatchResponse = await fragment.callRoute("GET", "/oauth/:provider/callback", {
      pathParams: { provider: "test-returnto" },
      query: {
        code: "new",
        state: mismatchedState,
      },
    });

    assert(mismatchResponse.type === "error");
    assert(mismatchResponse.error.code === "invalid_state");
    assert(mismatchResponse.status === 400);
  });

  it("rejects reused oauth states", async () => {
    const state = await getState("test");
    const first = await fragment.callRoute("GET", "/oauth/:provider/callback", {
      pathParams: { provider: "test" },
      query: {
        code: "new",
        state,
      },
    });

    assert(first.type === "json");

    const second = await fragment.callRoute("GET", "/oauth/:provider/callback", {
      pathParams: { provider: "test" },
      query: {
        code: "new",
        state,
      },
    });

    assert(second.type === "error");
    assert(second.error.code === "invalid_state");
    assert(second.status === 400);
  });

  it("denies oauth callbacks for banned users", async () => {
    const passwordHash = await hashPassword("password-123");
    const [bannedUser] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createUserUnvalidated("banned@test.com", passwordHash),
        ])
        .execute();
    });

    await test.inContext(function () {
      return this.handlerTx()
        .mutate(({ forSchema }) => {
          forSchema(authSchema).update("user", bannedUser.id, (b) =>
            b.set({ bannedAt: new Date() }),
          );
          return true;
        })
        .execute();
    });

    const state = await getState("test-banned");
    const response = await fragment.callRoute("GET", "/oauth/:provider/callback", {
      pathParams: { provider: "test-banned" },
      query: {
        code: "new",
        state,
      },
    });

    assert(response.type === "error");
    assert(response.error.code === "user_banned");
    assert(response.status === 403);
  });

  it("links providers using cookie auth when link=true", async () => {
    const passwordHash = await hashPassword("password-123");
    const [user] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createUserUnvalidated("link-user@test.com", passwordHash),
        ])
        .execute();
    });

    const [sessionResult] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [fragment.services.issueCredential(user.id)])
        .execute();
    });

    assert(sessionResult.ok);

    const authorizeResponse = await fragment.callRoute("GET", "/oauth/:provider/authorize", {
      pathParams: { provider: "test-link" },
      query: {
        link: "true",
      },
      headers: authHeaders(sessionResult.credential.id),
    });

    assert(authorizeResponse.type === "json");
    const state = new URL(authorizeResponse.data.url).searchParams.get("state");
    expect(state).toBeTruthy();

    const callbackResponse = await fragment.callRoute("GET", "/oauth/:provider/callback", {
      pathParams: { provider: "test-link" },
      query: {
        code: "new",
        state: state ?? "",
      },
    });

    assert(callbackResponse.type === "json");
    expect(callbackResponse.data.userId).toBe(user.id);
    assert(callbackResponse.data.email === "link-user@test.com");
  });

  it("rejects linking with expired sessions", async () => {
    const passwordHash = await hashPassword("password-123");
    const [user] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createUserUnvalidated("expired@test.com", passwordHash),
        ])
        .execute();
    });

    const [sessionResult] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [fragment.services.issueCredential(user.id)])
        .execute();
    });

    assert(sessionResult.ok);

    await test.inContext(function () {
      return this.handlerTx()
        .mutate(({ forSchema }) => {
          forSchema(authSchema).update("session", sessionResult.credential.id, (b) =>
            b.set({ expiresAt: new Date(0) }),
          );
          return true;
        })
        .execute();
    });

    const response = await fragment.callRoute("GET", "/oauth/:provider/authorize", {
      pathParams: { provider: "test-link" },
      query: {
        link: "true",
      },
      headers: authHeaders(sessionResult.credential.id),
    });

    assert(response.type === "error");
    assert(response.error.code === "credential_invalid");
    assert(response.status === 401);
  });

  it("allows existing oauth accounts when disableSignUp is set", async () => {
    const passwordHash = await hashPassword("password-123");
    const [user] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createUserUnvalidated("existing@test.com", passwordHash),
        ])
        .execute();
    });

    await test.inContext(function () {
      return this.handlerTx()
        .mutate(({ forSchema }) => {
          forSchema(authSchema).create("oauthAccount", {
            userId: user.id,
            provider: "test-disable-signup",
            providerAccountId: "provider-new-test-disable-signup",
            email: "existing@test.com",
            emailVerified: true,
            image: null,
            accessToken: null,
            refreshToken: null,
            idToken: null,
            tokenType: null,
            tokenExpiresAt: null,
            scopes: null,
            rawProfile: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          });
          return true;
        })
        .execute();
    });

    const state = await getState("test-disable-signup");
    const response = await fragment.callRoute("GET", "/oauth/:provider/callback", {
      pathParams: { provider: "test-disable-signup" },
      query: {
        code: "new",
        state,
      },
    });

    assert(response.type === "json");
    expect(response.data.userId).toBe(user.id);
  });

  it("allows existing users when disableImplicitSignUp is set", async () => {
    const passwordHash = await hashPassword("password-123");
    const [user] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createUserUnvalidated("implicit-existing@test.com", passwordHash),
        ])
        .execute();
    });

    const state = await getState("test-disable-implicit-existing");
    const response = await fragment.callRoute("GET", "/oauth/:provider/callback", {
      pathParams: { provider: "test-disable-implicit-existing" },
      query: {
        code: "new",
        state,
      },
    });

    assert(response.type === "json");
    expect(response.data.userId).toBe(user.id);
  });
});

describe("auth oauth credential seeds", async () => {
  const { fragments, test } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "kysely-sqlite" })
    .withFragment(
      "auth",
      instantiate(authFragmentDefinition)
        .withConfig({
          organizations: {},
          oauth: {
            providers: {
              test: testProvider,
            },
          },
        })
        .withRoutes([oauthRoutesFactory, sessionRoutesFactory]),
    )
    .build();

  const fragment = fragments.auth;

  afterAll(async () => {
    await test.cleanup();
  });

  it("persists credential seed through authorize and applies it on callback", async () => {
    const passwordHash = await hashPassword("password-123");
    const [user] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createUserUnvalidated("linked@test.com", passwordHash),
        ])
        .execute();
    });

    const [firstOrg, secondOrg] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createOrganization({
            name: "Org A",
            slug: "org-a",
            creatorUserId: user.id,
            creatorUserRole: "user",
          }),
          fragment.services.createOrganization({
            name: "Org B",
            slug: "org-b",
            creatorUserId: user.id,
            creatorUserRole: "user",
          }),
        ])
        .execute();
    });

    assert(firstOrg.ok);
    assert(secondOrg.ok);

    const authorizeResponse = await fragment.callRoute("GET", "/oauth/:provider/authorize", {
      pathParams: { provider: "test" },
      query: {
        auth: JSON.stringify({
          activeOrganizationId: secondOrg.organization.id,
        }),
      },
    });

    assert(authorizeResponse.type === "json");
    const state = new URL(authorizeResponse.data.url).searchParams.get("state");
    expect(state).toBeTruthy();

    const oauthState = await test.inContext(function () {
      return this.handlerTx()
        .retrieve(({ forSchema }) =>
          forSchema(authSchema).findFirst("oauthState", (b) =>
            b.whereIndex("idx_oauth_state_state", (eb) => eb("state", "=", state ?? "")),
          ),
        )
        .transformRetrieve(([result]) => result)
        .execute();
    });

    expect(oauthState?.sessionSeed).toEqual({
      activeOrganizationId: secondOrg.organization.id,
    });

    const callbackResponse = await fragment.callRoute("GET", "/oauth/:provider/callback", {
      pathParams: { provider: "test" },
      query: {
        code: "linked",
        state: state ?? "",
      },
    });

    assert(callbackResponse.type === "json");
    expect(callbackResponse.data.userId).toBe(user.id);

    const meResponse = await fragment.callRoute("GET", "/me", {
      headers: authHeaders(callbackResponse.data.auth.token),
    });

    assert(meResponse.type === "json");
    expect(meResponse.data.organizations).toHaveLength(2);
    expect(meResponse.data.organizations[0]?.organization.id).toBe(firstOrg.organization.id);
    expect(meResponse.data.activeOrganization?.organization.id).toBe(secondOrg.organization.id);
  });
});

describe("auth oauth disabled", async () => {
  const { fragments, test } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "kysely-sqlite" })
    .withFragment(
      "auth",
      instantiate(authFragmentDefinition)
        .withConfig({
          organizations: false,
        })
        .withRoutes([oauthRoutesFactory]),
    )
    .build();

  const fragment = fragments.auth;

  afterAll(async () => {
    await test.cleanup();
  });

  it("returns oauth_disabled for authorize and callback", async () => {
    const authorizeResponse = await fragment.callRoute("GET", "/oauth/:provider/authorize", {
      pathParams: { provider: "test" },
      query: {},
    });

    assert(authorizeResponse.type === "error");
    assert(authorizeResponse.error.code === "oauth_disabled");
    assert(authorizeResponse.status === 400);

    const callbackResponse = await fragment.callRoute("GET", "/oauth/:provider/callback", {
      pathParams: { provider: "test" },
      query: {
        code: "new",
        state: "state",
      },
    });

    assert(callbackResponse.type === "error");
    assert(callbackResponse.error.code === "oauth_disabled");
    assert(callbackResponse.status === 400);
  });
});

describe("auth oauth missing redirect uri", async () => {
  const missingRedirectProvider = createTestProvider({
    id: "test-missing-redirect",
    providerOptions: {
      redirectURI: undefined,
    },
  });

  const { fragments, test } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "kysely-sqlite" })
    .withFragment(
      "auth",
      instantiate(authFragmentDefinition)
        .withConfig({
          organizations: false,
          oauth: {
            providers: {
              "test-missing-redirect": missingRedirectProvider,
            },
          },
        })
        .withRoutes([oauthRoutesFactory]),
    )
    .build();

  const fragment = fragments.auth;

  afterAll(async () => {
    await test.cleanup();
  });

  it("returns missing_redirect_uri for authorize and callback", async () => {
    const authorizeResponse = await fragment.callRoute("GET", "/oauth/:provider/authorize", {
      pathParams: { provider: "test-missing-redirect" },
      query: {},
    });

    assert(authorizeResponse.type === "error");
    assert(authorizeResponse.error.code === "missing_redirect_uri");
    assert(authorizeResponse.status === 400);

    const callbackResponse = await fragment.callRoute("GET", "/oauth/:provider/callback", {
      pathParams: { provider: "test-missing-redirect" },
      query: {
        code: "new",
        state: "state",
      },
    });

    assert(callbackResponse.type === "error");
    assert(callbackResponse.error.code === "missing_redirect_uri");
    assert(callbackResponse.status === 400);
  });
});

describe("auth oauth expired state", async () => {
  const { fragments, test } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "kysely-sqlite" })
    .withFragment(
      "auth",
      instantiate(authFragmentDefinition)
        .withConfig({
          organizations: false,
          oauth: {
            stateTtlMs: -1,
            providers: {
              test: testProvider,
            },
          },
        })
        .withRoutes([oauthRoutesFactory]),
    )
    .build();

  const fragment = fragments.auth;

  afterAll(async () => {
    await test.cleanup();
  });

  it("returns invalid_state for expired states", async () => {
    const authorizeResponse = await fragment.callRoute("GET", "/oauth/:provider/authorize", {
      pathParams: { provider: "test" },
      query: {},
    });

    assert(authorizeResponse.type === "json");
    const state = new URL(authorizeResponse.data.url).searchParams.get("state");
    expect(state).toBeTruthy();

    const callbackResponse = await fragment.callRoute("GET", "/oauth/:provider/callback", {
      pathParams: { provider: "test" },
      query: {
        code: "new",
        state: state ?? "",
      },
    });

    assert(callbackResponse.type === "error");
    assert(callbackResponse.error.code === "invalid_state");
    assert(callbackResponse.status === 400);
  });
});

describe("auth oauth linkByEmail false", async () => {
  const { fragments, test } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "kysely-sqlite" })
    .withFragment(
      "auth",
      instantiate(authFragmentDefinition)
        .withConfig({
          organizations: false,
          oauth: {
            linkByEmail: false,
            providers: {
              test: testProvider,
            },
          },
        })
        .withRoutes([oauthRoutesFactory]),
    )
    .build();

  const fragment = fragments.auth;

  afterAll(async () => {
    await test.cleanup();
  });

  it("does not link users by email when linkByEmail is false", async () => {
    const passwordHash = await hashPassword("password-123");
    const [existingUser] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createUserUnvalidated("new@test.com", passwordHash),
        ])
        .execute();
    });

    const authorizeResponse = await fragment.callRoute("GET", "/oauth/:provider/authorize", {
      pathParams: { provider: "test" },
      query: {},
    });

    assert(authorizeResponse.type === "json");
    const state = new URL(authorizeResponse.data.url).searchParams.get("state");
    expect(state).toBeTruthy();

    const callbackResponse = await fragment.callRoute("GET", "/oauth/:provider/callback", {
      pathParams: { provider: "test" },
      query: {
        code: "new",
        state: state ?? "",
      },
    });

    assert(callbackResponse.type === "json");
    assert(callbackResponse.data.email === "new@test.com");
    expect(callbackResponse.data.userId).not.toBe(existingUser.id);
  });
});

describe("auth oauth token storage", async () => {
  const buildTokenStorage = async (
    tokenStorage: "none" | "refresh" | "all",
    provider: OAuthProvider,
  ) => {
    const { fragments, test } = await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "kysely-sqlite" })
      .withFragment(
        "auth",
        instantiate(authFragmentDefinition)
          .withConfig({
            organizations: false,
            oauth: {
              tokenStorage,
              providers: {
                [provider.id]: provider,
              },
            },
          })
          .withRoutes([oauthRoutesFactory]),
      )
      .build();

    return { fragment: fragments.auth, test };
  };

  const noneSetup = await buildTokenStorage("none", tokenProvider);
  const refreshSetup = await buildTokenStorage("refresh", tokenProvider);
  const allSetup = await buildTokenStorage("all", tokenProvider);
  const updateSetup = await buildTokenStorage("all", tokenUpdateProvider);

  afterAll(async () => {
    await noneSetup.test.cleanup();
    await refreshSetup.test.cleanup();
    await allSetup.test.cleanup();
    await updateSetup.test.cleanup();
  });

  const getState = async (fragment: typeof noneSetup.fragment, providerId: string) => {
    const authorizeResponse = await fragment.callRoute("GET", "/oauth/:provider/authorize", {
      pathParams: { provider: providerId },
      query: {},
    });

    assert(authorizeResponse.type === "json");
    const state = new URL(authorizeResponse.data.url).searchParams.get("state");
    return state ?? "";
  };

  const getOauthAccount = async (
    testContext: typeof noneSetup.test,
    providerId: string,
    providerAccountId: string,
  ) => {
    return testContext.inContext(function () {
      return this.handlerTx()
        .retrieve(({ forSchema }) =>
          forSchema(authSchema).findFirst("oauthAccount", (b) =>
            b.whereIndex("idx_oauth_account_provider_account", (eb) =>
              eb.and(
                eb("provider", "=", providerId),
                eb("providerAccountId", "=", providerAccountId),
              ),
            ),
          ),
        )
        .transformRetrieve(([result]) => result)
        .execute();
    });
  };

  it("stores no tokens when tokenStorage=none", async () => {
    const state = await getState(noneSetup.fragment, "test-token");
    const response = await noneSetup.fragment.callRoute("GET", "/oauth/:provider/callback", {
      pathParams: { provider: "test-token" },
      query: {
        code: "new",
        state,
      },
    });

    assert(response.type === "json");

    const account = await getOauthAccount(noneSetup.test, "test-token", "provider-new-test-token");
    expect(account?.accessToken).toBeNull();
    expect(account?.refreshToken).toBeNull();
    expect(account?.idToken).toBeNull();
    expect(account?.tokenType).toBeNull();
    expect(account?.tokenExpiresAt).toBeNull();
    expect(account?.scopes).toBeNull();
  });

  it("stores refresh tokens only when tokenStorage=refresh", async () => {
    const state = await getState(refreshSetup.fragment, "test-token");
    const response = await refreshSetup.fragment.callRoute("GET", "/oauth/:provider/callback", {
      pathParams: { provider: "test-token" },
      query: {
        code: "new",
        state,
      },
    });

    assert(response.type === "json");

    const account = await getOauthAccount(
      refreshSetup.test,
      "test-token",
      "provider-new-test-token",
    );
    expect(account?.accessToken).toBeNull();
    assert(account?.refreshToken === "refresh-1");
    expect(account?.idToken).toBeNull();
    assert(account?.tokenType === "bearer");
    expect(account?.tokenExpiresAt).toBeNull();
    expect(account?.scopes).toEqual(["read", "write"]);
  });

  it("stores all token fields when tokenStorage=all", async () => {
    const state = await getState(allSetup.fragment, "test-token");
    const response = await allSetup.fragment.callRoute("GET", "/oauth/:provider/callback", {
      pathParams: { provider: "test-token" },
      query: {
        code: "new",
        state,
      },
    });

    assert(response.type === "json");

    const account = await getOauthAccount(allSetup.test, "test-token", "provider-new-test-token");
    assert(account?.accessToken === "access-1");
    assert(account?.refreshToken === "refresh-1");
    assert(account?.idToken === "id-1");
    assert(account?.tokenType === "bearer");
    const tokenExpiresAt = account?.tokenExpiresAt
      ? new Date(account.tokenExpiresAt).getTime()
      : null;
    expect(tokenExpiresAt).toBe(0);
    expect(account?.scopes).toEqual(["read", "write"]);
  });

  it("updates existing oauth accounts on callback", async () => {
    const passwordHash = await hashPassword("password-123");
    const [user] = await updateSetup.test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          updateSetup.fragment.services.createUserUnvalidated(
            "token-update@test.com",
            passwordHash,
          ),
        ])
        .execute();
    });

    await updateSetup.test.inContext(function () {
      return this.handlerTx()
        .mutate(({ forSchema }) => {
          forSchema(authSchema).create("oauthAccount", {
            userId: user.id,
            provider: "test-token-update",
            providerAccountId: "provider-new-test-token-update",
            email: "old@test.com",
            emailVerified: true,
            image: null,
            accessToken: "old-access",
            refreshToken: "old-refresh",
            idToken: "old-id",
            tokenType: "bearer",
            tokenExpiresAt: new Date(0),
            scopes: ["old"],
            rawProfile: { old: true },
            createdAt: new Date(0),
            updatedAt: new Date(0),
          });
          return true;
        })
        .execute();
    });

    const state = await getState(updateSetup.fragment, "test-token-update");
    const response = await updateSetup.fragment.callRoute("GET", "/oauth/:provider/callback", {
      pathParams: { provider: "test-token-update" },
      query: {
        code: "new",
        state,
      },
    });

    assert(response.type === "json");

    const account = await getOauthAccount(
      updateSetup.test,
      "test-token-update",
      "provider-new-test-token-update",
    );
    assert(account?.accessToken === "access-updated");
    assert(account?.refreshToken === "refresh-updated");
    assert(account?.idToken === "id-updated");
    assert(account?.tokenType === "bearer");
    const tokenExpiresAt = account?.tokenExpiresAt
      ? new Date(account.tokenExpiresAt).getTime()
      : null;
    expect(tokenExpiresAt).toBe(10);
    expect(account?.scopes).toEqual(["repo"]);
    const updatedAt = account?.updatedAt ? new Date(account.updatedAt).getTime() : 0;
    expect(updatedAt).toBeGreaterThan(0);
  });
});
