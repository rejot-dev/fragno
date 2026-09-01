import { afterEach, assert, beforeEach, describe, expect, test, vi } from "vitest";

const { DurableObject, RpcTarget, WorkerEntrypoint, tracing } = vi.hoisted(() => {
  class MockDurableObject {
    constructor(_state: unknown, _env: unknown) {}
  }

  return {
    DurableObject: MockDurableObject,
    RpcTarget: class {},
    WorkerEntrypoint: class {},
    tracing: {
      enterSpan: vi.fn((_name: string, callback: (span: unknown) => unknown) =>
        callback({ isTraced: true, setAttribute: vi.fn() }),
      ),
    },
  };
});

vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint, tracing }));

import { createInMemoryBackofficeRuntime } from "@/backoffice-runtime/in-memory-runtime";
import { verifyBackofficeJwt } from "@/fragno/auth/token-lifecycle";
import { getSetCookieHeaders } from "@/worker-runtime/http-headers";

import { issueTestSignUpInvitation } from "./auth-sign-up.test-support";

const baseUrl = "https://backoffice.example";
const deviceCodeGrantType = "urn:ietf:params:oauth:grant-type:device_code";
const runtimes: Array<Awaited<ReturnType<typeof createInMemoryBackofficeRuntime>>> = [];

type AuthTestObject = Awaited<
  ReturnType<typeof createInMemoryBackofficeRuntime>
>["objects"]["auth"] extends {
  singleton(): infer TObject;
}
  ? TObject
  : never;

type OAuthConfig = Awaited<ReturnType<AuthTestObject["commands"]["getBackofficeCliOAuthConfig"]>>;

type SignedUpUser = {
  runtime: Awaited<ReturnType<typeof createInMemoryBackofficeRuntime>>;
  auth: AuthTestObject;
  user: { id: string; email: string };
  sessionCookie: string;
  organizationId: string;
  config: OAuthConfig;
};

function authRequest(
  auth: AuthTestObject,
  path: string,
  input: { cookie?: string; json?: unknown; form?: URLSearchParams } = {},
) {
  const body = input.form ?? (input.json === undefined ? undefined : JSON.stringify(input.json));
  return auth.http.fetch(
    new Request(`${baseUrl}/api/auth${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        origin: baseUrl,
        ...(input.cookie ? { cookie: input.cookie } : {}),
        ...(input.form
          ? { "content-type": "application/x-www-form-urlencoded" }
          : input.json === undefined
            ? {}
            : { "content-type": "application/json" }),
      },
      body,
    }),
  );
}

async function signUpUser(): Promise<SignedUpUser> {
  const runtime = await createInMemoryBackofficeRuntime({
    env: { AUTH_EMAIL_VERIFICATION_ENABLED: "false" },
  });
  runtimes.push(runtime);
  const auth = runtime.objects.auth.singleton();
  const email = `oauth-device-${crypto.randomUUID()}@example.com`;
  const invitation = await issueTestSignUpInvitation(runtime, email);
  const response = await authRequest(auth, "/sign-up/email", {
    json: {
      name: "OAuth Device User",
      email,
      password: "password123",
      ...invitation,
    },
  });
  if (!response.ok) {
    assert.fail(await response.text());
  }
  const result = (await response.clone().json()) as { user: { id: string; email: string } };
  const setCookieHeaders = getSetCookieHeaders(response.headers);
  assert(
    setCookieHeaders.some(
      (header) => header.includes(".session_token=") && header.includes("Path=/;"),
    ),
  );
  const sessionCookie = setCookieHeaders.map((header) => header.split(";", 1)[0]).join("; ");
  assert(sessionCookie);
  await runtime.drain();
  const organizationId = (await auth.commands.getAllOrganizations())[0]?.id;
  assert(organizationId);
  const config = await auth.commands.getBackofficeCliOAuthConfig({
    requestUrl: `${baseUrl}/api/config`,
  });
  return { runtime, auth, user: result.user, sessionCookie, organizationId, config };
}

async function requestDeviceCode(
  auth: AuthTestObject,
  config: OAuthConfig,
  input: { clientId?: string; scope?: string } = {},
) {
  const response = await authRequest(auth, "/device/code", {
    form: new URLSearchParams({
      client_id: input.clientId ?? config.clientId,
      scope: input.scope ?? config.scope,
      resource: baseUrl,
    }),
  });
  if (!response.ok) {
    assert.fail(await response.text());
  }
  return (await response.json()) as {
    device_code: string;
    user_code: string;
    interval: number;
  };
}

async function claimDeviceCode(auth: AuthTestObject, sessionCookie: string, userCode: string) {
  const response = await authRequest(auth, `/device?user_code=${encodeURIComponent(userCode)}`, {
    cookie: sessionCookie,
  });
  if (!response.ok) {
    assert.fail(await response.text());
  }
  return await response.json();
}

async function decideDeviceCode(
  auth: AuthTestObject,
  sessionCookie: string,
  userCode: string,
  decision: "approve" | "deny",
) {
  const response = await authRequest(auth, `/device/${decision}`, {
    cookie: sessionCookie,
    json: { userCode },
  });
  if (!response.ok) {
    assert.fail(await response.text());
  }
}

async function exchangeDeviceCode(
  auth: AuthTestObject,
  clientId: string,
  deviceCode: string,
): Promise<Response> {
  return await authRequest(auth, "/oauth2/token", {
    form: new URLSearchParams({
      grant_type: deviceCodeGrantType,
      device_code: deviceCode,
      client_id: clientId,
      resource: baseUrl,
    }),
  });
}

async function authorizeDevice(input: SignedUpUser, scope = input.config.scope) {
  const device = await requestDeviceCode(input.auth, input.config, { scope });
  await claimDeviceCode(input.auth, input.sessionCookie, device.user_code);
  await decideDeviceCode(input.auth, input.sessionCookie, device.user_code, "approve");
  const response = await exchangeDeviceCode(input.auth, input.config.clientId, device.device_code);
  if (!response.ok) {
    assert.fail(await response.text());
  }
  const token = (await response.json()) as { access_token: string; refresh_token?: string };
  assert(token.access_token);
  return token;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-22T12:00:00.000Z"));
});

afterEach(async () => {
  try {
    await Promise.all(runtimes.splice(0).map(async (runtime) => await runtime.cleanup()));
  } finally {
    vi.useRealTimers();
  }
});

describe("Backoffice OAuth device authorization", () => {
  test("provisions the first-party client and exchanges an approved device code for a Backoffice JWT", async () => {
    const signedUp = await signUpUser();
    expect(signedUp.config).toMatchObject({
      scope: "openid offline_access backoffice",
      deviceAuthorizationEndpoint: `${baseUrl}/api/auth/device/code`,
      tokenEndpoint: `${baseUrl}/api/auth/oauth2/token`,
      verificationUri: `${baseUrl}/backoffice/device`,
    });

    const device = await requestDeviceCode(signedUp.auth, signedUp.config);
    expect(device.user_code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    const pendingResponse = await exchangeDeviceCode(
      signedUp.auth,
      signedUp.config.clientId,
      device.device_code,
    );
    assert(pendingResponse.status === 400);
    expect(await pendingResponse.json()).toMatchObject({ error: "authorization_pending" });

    await claimDeviceCode(signedUp.auth, signedUp.sessionCookie, device.user_code);
    await decideDeviceCode(signedUp.auth, signedUp.sessionCookie, device.user_code, "approve");
    vi.advanceTimersByTime(device.interval * 1_000);

    const oauthResponse = await exchangeDeviceCode(
      signedUp.auth,
      signedUp.config.clientId,
      device.device_code,
    );
    if (!oauthResponse.ok) {
      assert.fail(await oauthResponse.text());
    }
    const oauthToken = (await oauthResponse.json()) as {
      access_token: string;
      refresh_token?: string;
    };
    assert(oauthToken.access_token);
    assert(oauthToken.refresh_token);

    const result = await signedUp.auth.commands.exchangeBackofficeOAuthAccessToken({
      requestUrl: `${baseUrl}/api/backoffice/cli-token`,
      oauthAccessToken: oauthToken.access_token,
      scope: { kind: "org", orgId: signedUp.organizationId },
    });
    const verification = await verifyBackofficeJwt(result.accessToken, baseUrl, signedUp.auth.http);
    assert(verification.ok);
    expect(verification.payload).toMatchObject({
      sub: signedUp.user.id,
      email: signedUp.user.email,
      globalRole: "user",
      organization: {
        id: signedUp.organizationId,
        slug: expect.any(String),
        roles: ["owner"],
      },
    });
    expect(result).toMatchObject({
      scope: { kind: "org", orgId: signedUp.organizationId },
    });
  });

  test("authorizes user, project, and administrator system scopes", async () => {
    const signedUp = await signUpUser();
    const oauthToken = await authorizeDevice(signedUp);

    const userScope = { kind: "user" as const, userId: signedUp.user.id };
    const userResult = await signedUp.auth.commands.exchangeBackofficeOAuthAccessToken({
      requestUrl: `${baseUrl}/api/backoffice/cli-token`,
      oauthAccessToken: oauthToken.access_token,
      scope: userScope,
    });
    expect(userResult.scope).toEqual(userScope);
    const userVerification = await verifyBackofficeJwt(
      userResult.accessToken,
      baseUrl,
      signedUp.auth.http,
    );
    assert(userVerification.ok);
    expect(userVerification.payload).toMatchObject({ organization: null });

    const projectScope = {
      kind: "project" as const,
      orgId: signedUp.organizationId,
      projectId: "project-1",
    };
    const projectResult = await signedUp.auth.commands.exchangeBackofficeOAuthAccessToken({
      requestUrl: `${baseUrl}/api/backoffice/cli-token`,
      oauthAccessToken: oauthToken.access_token,
      scope: projectScope,
    });
    expect(projectResult.scope).toEqual(projectScope);

    await signedUp.auth.commands.applyScenarioFixture({
      users: [
        {
          id: signedUp.user.id,
          email: signedUp.user.email,
          role: "admin",
          status: "active",
        },
      ],
    });
    const systemResult = await signedUp.auth.commands.exchangeBackofficeOAuthAccessToken({
      requestUrl: `${baseUrl}/api/backoffice/cli-token`,
      oauthAccessToken: oauthToken.access_token,
      scope: { kind: "system" },
    });
    expect(systemResult.scope).toEqual({ kind: "system" });
  });

  test("rejects scopes outside the authenticated user's authority", async () => {
    const signedUp = await signUpUser();
    const oauthToken = await authorizeDevice(signedUp);

    await expect(
      signedUp.auth.commands.exchangeBackofficeOAuthAccessToken({
        requestUrl: `${baseUrl}/api/backoffice/cli-token`,
        oauthAccessToken: oauthToken.access_token,
        scope: { kind: "user", userId: "another-user" },
      }),
    ).rejects.toMatchObject({ name: "BackofficeCliScopeAuthorizationError" });
    await expect(
      signedUp.auth.commands.exchangeBackofficeOAuthAccessToken({
        requestUrl: `${baseUrl}/api/backoffice/cli-token`,
        oauthAccessToken: oauthToken.access_token,
        scope: { kind: "system" },
      }),
    ).rejects.toMatchObject({ name: "BackofficeCliScopeAuthorizationError" });
  });

  test("refreshes the OAuth access token and exchanges the replacement for a Backoffice JWT", async () => {
    const signedUp = await signUpUser();
    const oauthToken = await authorizeDevice(signedUp);
    assert(oauthToken.refresh_token);

    const refreshResponse = await authRequest(signedUp.auth, "/oauth2/token", {
      form: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: oauthToken.refresh_token,
        client_id: signedUp.config.clientId,
        resource: baseUrl,
      }),
    });
    if (!refreshResponse.ok) {
      assert.fail(await refreshResponse.text());
    }
    const refreshedToken = (await refreshResponse.json()) as {
      access_token: string;
      refresh_token?: string;
    };
    assert(refreshedToken.access_token);
    assert(refreshedToken.refresh_token);

    const result = await signedUp.auth.commands.exchangeBackofficeOAuthAccessToken({
      requestUrl: `${baseUrl}/api/backoffice/cli-token`,
      oauthAccessToken: refreshedToken.access_token,
      scope: { kind: "org", orgId: signedUp.organizationId },
    });
    const verification = await verifyBackofficeJwt(result.accessToken, baseUrl, signedUp.auth.http);
    assert(verification.ok);
    assert.equal(verification.payload.sub, signedUp.user.id);
  });

  test("rejects an OAuth token without the backoffice scope", async () => {
    const signedUp = await signUpUser();
    const oauthToken = await authorizeDevice(signedUp, "openid offline_access");

    await expect(
      signedUp.auth.commands.exchangeBackofficeOAuthAccessToken({
        requestUrl: `${baseUrl}/api/backoffice/cli-token`,
        oauthAccessToken: oauthToken.access_token,
        scope: { kind: "org", orgId: signedUp.organizationId },
      }),
    ).rejects.toMatchObject({ name: "BackofficeCliOAuthAuthenticationError" });
  });

  test("rejects an OAuth token issued to another client", async () => {
    const signedUp = await signUpUser();
    const createClientResponse = await authRequest(signedUp.auth, "/oauth2/create-client", {
      cookie: signedUp.sessionCookie,
      json: {
        client_name: "Other local client",
        software_id: `other-${crypto.randomUUID()}`,
        scope: signedUp.config.scope,
        token_endpoint_auth_method: "none",
        application_type: "native",
        grant_types: [deviceCodeGrantType, "refresh_token"],
      },
    });
    if (!createClientResponse.ok) {
      assert.fail(await createClientResponse.text());
    }
    const otherClient = (await createClientResponse.json()) as { client_id: string };
    const device = await requestDeviceCode(signedUp.auth, signedUp.config, {
      clientId: otherClient.client_id,
    });
    await claimDeviceCode(signedUp.auth, signedUp.sessionCookie, device.user_code);
    await decideDeviceCode(signedUp.auth, signedUp.sessionCookie, device.user_code, "approve");
    const tokenResponse = await exchangeDeviceCode(
      signedUp.auth,
      otherClient.client_id,
      device.device_code,
    );
    if (!tokenResponse.ok) {
      assert.fail(await tokenResponse.text());
    }
    const oauthToken = (await tokenResponse.json()) as { access_token: string };

    await expect(
      signedUp.auth.commands.exchangeBackofficeOAuthAccessToken({
        requestUrl: `${baseUrl}/api/backoffice/cli-token`,
        oauthAccessToken: oauthToken.access_token,
        scope: { kind: "org", orgId: signedUp.organizationId },
      }),
    ).rejects.toMatchObject({ name: "BackofficeCliOAuthAuthenticationError" });
  });

  test("reports access_denied after the browser denies the device code", async () => {
    const signedUp = await signUpUser();
    const device = await requestDeviceCode(signedUp.auth, signedUp.config);
    await claimDeviceCode(signedUp.auth, signedUp.sessionCookie, device.user_code);
    await decideDeviceCode(signedUp.auth, signedUp.sessionCookie, device.user_code, "deny");

    const response = await exchangeDeviceCode(
      signedUp.auth,
      signedUp.config.clientId,
      device.device_code,
    );
    assert(response.status === 400);
    expect(await response.json()).toMatchObject({ error: "access_denied" });
  });

  test("rejects a banned user when exchanging the OAuth token", async () => {
    const signedUp = await signUpUser();
    const oauthToken = await authorizeDevice(signedUp);
    await signedUp.auth.commands.applyScenarioFixture({
      users: [
        {
          id: signedUp.user.id,
          email: signedUp.user.email,
          role: "user",
          status: "banned",
        },
      ],
    });

    await expect(
      signedUp.auth.commands.exchangeBackofficeOAuthAccessToken({
        requestUrl: `${baseUrl}/api/backoffice/cli-token`,
        oauthAccessToken: oauthToken.access_token,
        scope: { kind: "org", orgId: signedUp.organizationId },
      }),
    ).rejects.toMatchObject({ name: "BackofficeCliScopeAuthorizationError" });
  });

  test("rejects a removed organization membership when exchanging the OAuth token", async () => {
    const signedUp = await signUpUser();
    const oauthToken = await authorizeDevice(signedUp);
    await signedUp.auth.commands.applyScenarioFixture({
      removedMembers: [{ organizationId: signedUp.organizationId, userId: signedUp.user.id }],
    });

    await expect(
      signedUp.auth.commands.exchangeBackofficeOAuthAccessToken({
        requestUrl: `${baseUrl}/api/backoffice/cli-token`,
        oauthAccessToken: oauthToken.access_token,
        scope: { kind: "org", orgId: signedUp.organizationId },
      }),
    ).rejects.toMatchObject({ name: "BackofficeCliScopeAuthorizationError" });
  });
});
