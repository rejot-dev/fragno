import { afterAll, assert, describe, expect, it } from "vitest";
import { buildDatabaseFragmentsTest } from "@fragno-dev/test";
import { instantiate } from "@fragno-dev/core";
import { authFragmentDefinition } from "..";
import { oauthRoutesFactory } from "./routes";
import type { OAuthProvider, ProviderOptions } from "./types";
import { hashPassword } from "../user/password";
import { authSchema } from "../schema";

const redirectURI = "http://localhost:3000/api/auth/oauth/test/callback";

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

describe("auth oauth", async () => {
  const { fragments, test } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "drizzle-pglite" })
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
    expect(url.hostname).toBe("example.com");
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
    expect(response.data.email).toBe("new@test.com");
    expect(response.data.sessionId).toBeTruthy();
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
    expect(callbackResponse.data.email).toBe("linked@test.com");

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
    expect(callbackResponse.data.email).toBe("unverified@test.com");
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
    expect(response.error.code).toBe("signup_required");
    expect(response.status).toBe(403);
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
        .withServiceCalls(() => [fragment.services.createSession(user.id)])
        .execute();
    });

    assert(sessionResult.ok);

    const authorizeResponse = await fragment.callRoute("GET", "/oauth/:provider/authorize", {
      pathParams: { provider: "test-unverified-email" },
      query: {
        link: "true",
        sessionId: sessionResult.session.id,
      },
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
    expect(callbackResponse.data.email).toBe("link-unverified@test.com");
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
    expect(callbackResponse.error.code).toBe("signup_disabled");
    expect(callbackResponse.status).toBe(403);
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
    expect(callbackResponse.error.code).toBe("signup_required");
    expect(callbackResponse.status).toBe(403);

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
    expect(callbackResponseWithSignup.data.email).toBe("test-disable-implicit-new@test.com");
  });

  it("requires a session when linking providers", async () => {
    const unauthorizedResponse = await fragment.callRoute("GET", "/oauth/:provider/authorize", {
      pathParams: { provider: "test-link" },
      query: {
        link: "true",
      },
    });

    assert(unauthorizedResponse.type === "error");
    expect(unauthorizedResponse.error.code).toBe("session_invalid");
    expect(unauthorizedResponse.status).toBe(401);

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
        .withServiceCalls(() => [fragment.services.createSession(user.id)])
        .execute();
    });

    assert(sessionResult.ok);

    const authorizedResponse = await fragment.callRoute("GET", "/oauth/:provider/authorize", {
      pathParams: { provider: "test-link" },
      query: {
        link: "true",
      },
      headers: {
        Cookie: `sessionid=${sessionResult.session.id}`,
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
    expect(callbackResponse.status).toBe(302);
    expect(callbackResponse.headers.get("Location")).toBe("/app");
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
    expect(url.searchParams.get("scope")).toBe("read|write|openid");
    expect(url.searchParams.get("login_hint")).toBe("user@test.com");
  });

  it("returns provider_not_found for unknown providers", async () => {
    const authorizeResponse = await fragment.callRoute("GET", "/oauth/:provider/authorize", {
      pathParams: { provider: "missing" },
      query: {},
    });

    assert(authorizeResponse.type === "error");
    expect(authorizeResponse.error.code).toBe("provider_not_found");
    expect(authorizeResponse.status).toBe(404);

    const callbackResponse = await fragment.callRoute("GET", "/oauth/:provider/callback", {
      pathParams: { provider: "missing" },
      query: {
        code: "new",
        state: "missing-state",
      },
    });

    assert(callbackResponse.type === "error");
    expect(callbackResponse.error.code).toBe("provider_not_found");
    expect(callbackResponse.status).toBe(404);
  });

  it("rejects redirectUri mismatches on authorize", async () => {
    const response = await fragment.callRoute("GET", "/oauth/:provider/authorize", {
      pathParams: { provider: "test" },
      query: {
        redirectUri: "http://localhost:3000/api/auth/oauth/other/callback",
      },
    });

    assert(response.type === "error");
    expect(response.error.code).toBe("redirect_uri_mismatch");
    expect(response.status).toBe(400);
  });

  it("requires code and state on callback", async () => {
    const missingCode = await fragment.callRoute("GET", "/oauth/:provider/callback", {
      pathParams: { provider: "test" },
      query: {
        state: "state",
      },
    });

    assert(missingCode.type === "error");
    expect(missingCode.error.code).toBe("invalid_code");
    expect(missingCode.status).toBe(400);

    const missingState = await fragment.callRoute("GET", "/oauth/:provider/callback", {
      pathParams: { provider: "test" },
      query: {
        code: "new",
      },
    });

    assert(missingState.type === "error");
    expect(missingState.error.code).toBe("invalid_state");
    expect(missingState.status).toBe(400);
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
    expect(response.error.code).toBe("invalid_code");
    expect(response.status).toBe(401);
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
    expect(response.error.code).toBe("invalid_code");
    expect(response.status).toBe(401);
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
    expect(response.error.code).toBe("email_required");
    expect(response.status).toBe(400);
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
    expect(response.error.code).toBe("email_required");
    expect(response.status).toBe(400);

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
    expect(missingState.error.code).toBe("invalid_state");
    expect(missingState.status).toBe(400);

    const mismatchedState = await getState("test");
    const mismatchResponse = await fragment.callRoute("GET", "/oauth/:provider/callback", {
      pathParams: { provider: "test-returnto" },
      query: {
        code: "new",
        state: mismatchedState,
      },
    });

    assert(mismatchResponse.type === "error");
    expect(mismatchResponse.error.code).toBe("invalid_state");
    expect(mismatchResponse.status).toBe(400);
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
    expect(second.error.code).toBe("invalid_state");
    expect(second.status).toBe(400);
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
    expect(response.error.code).toBe("user_banned");
    expect(response.status).toBe(403);
  });

  it("links providers using sessionId query param when link=true", async () => {
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
        .withServiceCalls(() => [fragment.services.createSession(user.id)])
        .execute();
    });

    assert(sessionResult.ok);

    const authorizeResponse = await fragment.callRoute("GET", "/oauth/:provider/authorize", {
      pathParams: { provider: "test-link" },
      query: {
        link: "true",
        sessionId: sessionResult.session.id,
      },
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
    expect(callbackResponse.data.email).toBe("link-user@test.com");
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
        .withServiceCalls(() => [fragment.services.createSession(user.id)])
        .execute();
    });

    assert(sessionResult.ok);

    await test.inContext(function () {
      return this.handlerTx()
        .mutate(({ forSchema }) => {
          forSchema(authSchema).update("session", sessionResult.session.id, (b) =>
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
        sessionId: sessionResult.session.id,
      },
    });

    assert(response.type === "error");
    expect(response.error.code).toBe("session_invalid");
    expect(response.status).toBe(401);
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

describe("auth oauth disabled", async () => {
  const { fragments, test } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "drizzle-pglite" })
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
    expect(authorizeResponse.error.code).toBe("oauth_disabled");
    expect(authorizeResponse.status).toBe(400);

    const callbackResponse = await fragment.callRoute("GET", "/oauth/:provider/callback", {
      pathParams: { provider: "test" },
      query: {
        code: "new",
        state: "state",
      },
    });

    assert(callbackResponse.type === "error");
    expect(callbackResponse.error.code).toBe("oauth_disabled");
    expect(callbackResponse.status).toBe(400);
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
    .withTestAdapter({ type: "drizzle-pglite" })
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
    expect(authorizeResponse.error.code).toBe("missing_redirect_uri");
    expect(authorizeResponse.status).toBe(400);

    const callbackResponse = await fragment.callRoute("GET", "/oauth/:provider/callback", {
      pathParams: { provider: "test-missing-redirect" },
      query: {
        code: "new",
        state: "state",
      },
    });

    assert(callbackResponse.type === "error");
    expect(callbackResponse.error.code).toBe("missing_redirect_uri");
    expect(callbackResponse.status).toBe(400);
  });
});

describe("auth oauth expired state", async () => {
  const { fragments, test } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "drizzle-pglite" })
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
    expect(callbackResponse.error.code).toBe("invalid_state");
    expect(callbackResponse.status).toBe(400);
  });
});

describe("auth oauth linkByEmail false", async () => {
  const { fragments, test } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "drizzle-pglite" })
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
    expect(callbackResponse.data.email).toBe("new@test.com");
    expect(callbackResponse.data.userId).not.toBe(existingUser.id);
  });
});

describe("auth oauth token storage", async () => {
  const buildTokenStorage = async (
    tokenStorage: "none" | "refresh" | "all",
    provider: OAuthProvider,
  ) => {
    const { fragments, test } = await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "drizzle-pglite" })
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
    expect(account?.refreshToken).toBe("refresh-1");
    expect(account?.idToken).toBeNull();
    expect(account?.tokenType).toBe("bearer");
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
    expect(account?.accessToken).toBe("access-1");
    expect(account?.refreshToken).toBe("refresh-1");
    expect(account?.idToken).toBe("id-1");
    expect(account?.tokenType).toBe("bearer");
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
    expect(account?.accessToken).toBe("access-updated");
    expect(account?.refreshToken).toBe("refresh-updated");
    expect(account?.idToken).toBe("id-updated");
    expect(account?.tokenType).toBe("bearer");
    const tokenExpiresAt = account?.tokenExpiresAt
      ? new Date(account.tokenExpiresAt).getTime()
      : null;
    expect(tokenExpiresAt).toBe(10);
    expect(account?.scopes).toEqual(["repo"]);
    const updatedAt = account?.updatedAt ? new Date(account.updatedAt).getTime() : 0;
    expect(updatedAt).toBeGreaterThan(0);
  });
});
