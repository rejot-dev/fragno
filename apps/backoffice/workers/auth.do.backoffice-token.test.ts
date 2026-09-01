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
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import { backofficeMeDataSchema } from "@/fragno/auth/contracts";
import {
  BACKOFFICE_JWT_LIFETIME_SECONDS,
  backofficeAccessTokenCookieName,
  verifyBackofficeJwtRequest,
} from "@/fragno/auth/token-lifecycle";
import { loader as loadBackofficeMe } from "@/routes/api/backoffice-me";
import { getSetCookieHeaders } from "@/worker-runtime/http-headers";
import { createBackofficeRouterContextProvider } from "@/worker-runtime/router-context-provider.server";

const runtimes: Array<Awaited<ReturnType<typeof createInMemoryBackofficeRuntime>>> = [];

const cookieHeader = (response: Response): string =>
  getSetCookieHeaders(response.headers)
    .map((header) => header.split(";", 1)[0])
    .join("; ");

const authRequest = (
  auth: { http: { fetch(request: Request): Promise<Response> } },
  path: string,
  input: { cookie?: string; body?: unknown } = {},
) =>
  auth.http.fetch(
    new Request(`https://backoffice.example/api/auth${path}`, {
      method: input.body === undefined ? "GET" : "POST",
      headers: {
        origin: "https://backoffice.example",
        ...(input.cookie ? { cookie: input.cookie } : {}),
        ...(input.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
    }),
  );

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-11T12:00:00.000Z"));
});

afterEach(async () => {
  try {
    await Promise.all(runtimes.splice(0).map(async (runtime) => await runtime.cleanup()));
  } finally {
    vi.useRealTimers();
  }
});

function createRouteContext(
  request: Request,
  runtime: Awaited<ReturnType<typeof createInMemoryBackofficeRuntime>>,
) {
  return createBackofficeRouterContextProvider(request, {
    runtime: runtime.services,
    kernel: new BackofficeKernel(runtime.services),
    env: runtime.env as unknown as CloudflareEnv,
    ctx: {} as ExecutionContext,
  });
}

const signUp = async () => {
  const runtime = await createInMemoryBackofficeRuntime({
    env: { AUTH_EMAIL_VERIFICATION_ENABLED: "false" },
  });
  runtimes.push(runtime);
  const auth = runtime.objects.auth.singleton();
  const response = await authRequest(auth, "/sign-up/email", {
    body: {
      name: "Token User",
      email: "token-user@example.com",
      password: "password123",
    },
  });
  if (!response.ok) {
    assert.fail(await response.text());
  }
  const result = (await response.clone().json()) as { user: { id: string; email: string } };
  await runtime.drain();
  return { runtime, auth, user: result.user, sessionCookie: cookieHeader(response) };
};

describe("Backoffice token exchange", () => {
  test("exchanges a session for a scoped cookie and serves current-user data with only that cookie", async () => {
    const { runtime, auth, user, sessionCookie } = await signUp();
    const organizationId = (await auth.commands.getAllOrganizations())[0]?.id;
    assert(organizationId);

    const tokenResponse = await authRequest(auth, "/backoffice-token", {
      cookie: sessionCookie,
      body: { selection: "required", organizationId },
    });
    if (!tokenResponse.ok) {
      assert.fail(await tokenResponse.text());
    }
    expect(await tokenResponse.clone().json()).toEqual({
      expiresAt: "2026-08-11T12:15:00.000Z",
      organization: { id: organizationId, slug: "token-users-organization" },
    });

    const setCookie = getSetCookieHeaders(tokenResponse.headers).find((header) =>
      header.startsWith(`${backofficeAccessTokenCookieName(false)}=`),
    );
    assert(setCookie);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain(`Max-Age=${BACKOFFICE_JWT_LIFETIME_SECONDS}`);

    const accessTokenCookie = setCookie.split(";", 1)[0];
    const verification = await verifyBackofficeJwtRequest(
      new Request("https://backoffice.example/api/backoffice/me", {
        headers: { cookie: accessTokenCookie },
      }),
      auth.http,
    );
    assert(verification.ok);
    expect(verification.payload).toMatchObject({
      sub: user.id,
      email: "token-user@example.com",
      globalRole: "user",
      organization: {
        id: organizationId,
        slug: "token-users-organization",
        roles: ["owner"],
      },
    });
    expect(verification.payload.jti).toEqual(expect.any(String));

    const cookieRequest = new Request("https://backoffice.example/api/backoffice/me", {
      headers: { cookie: accessTokenCookie },
    });
    const response = await loadBackofficeMe({
      request: cookieRequest,
      context: createRouteContext(cookieRequest, runtime),
      params: {},
    } as never);
    assert(response.status === 200);
    const me = backofficeMeDataSchema.parse(await response.json());
    expect(me.user.id).toBe(user.id);
    expect(me.activeOrganizationId).toBe(organizationId);
    expect(me.activeOrganization?.organization.id).toBe(organizationId);
    expect(me.organizations).toHaveLength(1);
    assert(response.headers.get("cache-control") === "no-store");

    const bearerRequest = new Request("https://backoffice.example/api/backoffice/me", {
      headers: { authorization: `Bearer ${accessTokenCookie.split("=", 2)[1]}` },
    });
    const bearerResponse = await loadBackofficeMe({
      request: bearerRequest,
      context: createRouteContext(bearerRequest, runtime),
      params: {},
    } as never);
    assert(bearerResponse.status === 200);
    expect(backofficeMeDataSchema.parse(await bearerResponse.json()).activeOrganizationId).toBe(
      organizationId,
    );
  });

  test("requires explicit organizations and falls back from unavailable preferences", async () => {
    const { auth, sessionCookie } = await signUp();
    vi.advanceTimersByTime(1_000);
    const createOrganizationResponse = await authRequest(auth, "/organization/create", {
      cookie: sessionCookie,
      body: { name: "Second Workspace", slug: `second-${crypto.randomUUID()}` },
    });
    if (!createOrganizationResponse.ok) {
      assert.fail(await createOrganizationResponse.text());
    }
    const secondOrganization = (await createOrganizationResponse.json()) as { id: string };

    const requestedResponse = await authRequest(auth, "/backoffice-token", {
      cookie: sessionCookie,
      body: { selection: "required", organizationId: secondOrganization.id },
    });
    assert(requestedResponse.status === 200);
    expect(await requestedResponse.json()).toMatchObject({
      organization: { id: secondOrganization.id },
    });

    const rejectedResponse = await authRequest(auth, "/backoffice-token", {
      cookie: sessionCookie,
      body: { selection: "required", organizationId: "unavailable-organization" },
    });
    assert(rejectedResponse.status === 403);

    const expectedFallback = (await auth.commands.getAllOrganizations()).sort(
      (left, right) => left.createdAt.getTime() - right.createdAt.getTime(),
    )[0]?.id;
    assert(expectedFallback);

    const fallbackResponse = await authRequest(auth, "/backoffice-token", {
      cookie: sessionCookie,
      body: { selection: "preferred", organizationId: "unavailable-organization" },
    });
    assert(fallbackResponse.status === 200);
    expect(await fallbackResponse.json()).toMatchObject({
      organization: { id: expectedFallback },
    });
  });

  test("reports initial organization provisioning instead of issuing an unscoped token", async () => {
    const { auth, user, sessionCookie } = await signUp();
    const organizationId = (await auth.commands.getAllOrganizations())[0]?.id;
    assert(organizationId);
    await auth.commands.applyScenarioFixture({
      removedMembers: [{ organizationId, userId: user.id }],
    });

    const response = await authRequest(auth, "/backoffice-token", {
      cookie: sessionCookie,
      body: { selection: "preferred", organizationId: null },
    });

    assert(response.status === 202, `${response.status}: ${await response.clone().text()}`);
    expect(await response.json()).toEqual({
      status: "organization_provisioning",
      retryAfterMs: 250,
    });
    expect(getSetCookieHeaders(response.headers)).toEqual([]);
  });

  test("disables default JWT issuance and clears both credentials on sign-out", async () => {
    const { auth, sessionCookie } = await signUp();
    assert((await authRequest(auth, "/token", { cookie: sessionCookie })).status === 404);

    const clearResponse = await authRequest(auth, "/backoffice-sign-out", {
      cookie: sessionCookie,
      body: {},
    });
    assert(clearResponse.status === 200);
    expect(await clearResponse.json()).toEqual({
      sessionRevoked: true,
      credentialsCleared: true,
    });
    const clearedCookies = getSetCookieHeaders(clearResponse.headers);
    expect(clearedCookies).toEqual(
      expect.arrayContaining([
        expect.stringContaining("better-auth.session_token="),
        expect.stringContaining("fragno-backoffice.access_token="),
        expect.stringContaining("__Host-fragno-backoffice.access_token="),
      ]),
    );
    assert(clearedCookies.every((cookie) => cookie.includes("Max-Age=0")));

    const revokedSessionResponse = await authRequest(auth, "/backoffice-token", {
      cookie: sessionCookie,
      body: { selection: "preferred", organizationId: null },
    });
    assert(revokedSessionResponse.status === 401);
  });

  test("rejects banned users", async () => {
    const { auth, user, sessionCookie } = await signUp();
    await auth.commands.applyScenarioFixture({
      users: [
        {
          id: user.id,
          email: user.email,
          role: "user",
          status: "banned",
        },
      ],
    });

    const response = await authRequest(auth, "/backoffice-token", {
      cookie: sessionCookie,
      body: { selection: "preferred", organizationId: null },
    });
    assert(response.status === 403);
    expect(getSetCookieHeaders(response.headers)).toEqual([]);
  });
});
