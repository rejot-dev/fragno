import { describe, expect, test, vi } from "vitest";

import type { AuthObject } from "@/backoffice-runtime/object-registry";
import type {
  BackofficeOrganizationIdentity,
  BackofficeResolvedScope,
} from "@/backoffice-runtime/resolved-scope";
import { findBackofficeMe, requireBackofficeMe } from "@/fragno/auth/auth-server";
import type { BackofficeMeData } from "@/fragno/auth/contracts";
import type { BackofficeJwtPayload } from "@/fragno/auth/token-lifecycle";
import type { AutomationCollectionSource } from "@/fragno/automation/tanstack/browser-database";

import { BackofficeRequestStateContext, type BackofficeRequestState } from "./request-state";
import { createBackofficeRequestState } from "./request-state.server";

const authenticatedPayload: BackofficeJwtPayload = {
  sub: "user-1",
  email: "user@example.com",
  globalRole: "admin",
  organization: { id: "org-1", slug: "acme", roles: ["owner"] },
  iss: "fragno-backoffice-auth",
  aud: "fragno-backoffice",
  iat: 1_788_192_000,
  exp: 1_788_192_900,
  jti: "request-state-test",
};

const authenticatedMe: BackofficeMeData = {
  user: {
    id: "user-1",
    name: "Test User",
    email: "user@example.com",
    emailVerified: true,
    role: "admin",
    banned: false,
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    updatedAt: new Date("2026-09-01T00:00:00.000Z"),
  },
  organizations: [],
  activeOrganizationId: null,
  activeOrganization: null,
  invitations: [],
};

function createAuthenticatedDependencies(
  getBackofficeMe: Pick<AuthObject, "getBackofficeMe">["getBackofficeMe"],
  automationCollectionSourceFailure: Error | null = null,
) {
  const verifyJwt = vi.fn(async () => ({ ok: true as const, payload: authenticatedPayload }));
  const getAuthObject = vi.fn(() => ({
    http: { fetch: vi.fn() },
    commands: { getBackofficeMe },
  }));
  const loadAutomationCollectionSourceCall = vi.fn();
  async function loadAutomationCollectionSource<
    TOrganization extends BackofficeOrganizationIdentity,
  >(
    resolvedScope: BackofficeResolvedScope<TOrganization>,
  ): Promise<AutomationCollectionSource<TOrganization>> {
    loadAutomationCollectionSourceCall(resolvedScope);
    if (automationCollectionSourceFailure) {
      throw automationCollectionSourceFailure;
    }
    return { resolvedScope, adapterIdentity: "adapter-test" };
  }
  return {
    dependencies: { getAuthObject, verifyJwt, loadAutomationCollectionSource },
    getAuthObject,
    verifyJwt,
    loadAutomationCollectionSourceCall,
  };
}

function contextForRequestState(state: BackofficeRequestState) {
  return {
    get(context: unknown) {
      if (context !== BackofficeRequestStateContext) {
        throw new Error("Request state test received an unexpected React Router context.");
      }
      return state;
    },
  } as never;
}

describe("Backoffice request state", () => {
  test("coalesces concurrent principal and membership operations", async () => {
    const getBackofficeMe = vi.fn(async () => authenticatedMe);
    const { dependencies, getAuthObject, verifyJwt } =
      createAuthenticatedDependencies(getBackofficeMe);
    const state = createBackofficeRequestState(
      new Request("https://backoffice.example/private", {
        headers: { authorization: "Bearer signed-token" },
      }),
      dependencies,
    );

    const [principal, me, repeatedPrincipal] = await Promise.all([
      state.getPrincipal(),
      state.getBackofficeMe(),
      state.getPrincipal(),
    ]);

    expect(principal).toMatchObject({ ok: true, principal: { user: { id: "user-1" } } });
    expect(me).toMatchObject({ status: "authenticated", me: { user: { id: "user-1" } } });
    expect(repeatedPrincipal).toBe(principal);
    expect(verifyJwt).toHaveBeenCalledOnce();
    expect(getBackofficeMe).toHaveBeenCalledOnce();
    expect(getAuthObject).toHaveBeenCalledOnce();
  });

  test("coalesces find and require membership helpers", async () => {
    const getBackofficeMeCommand = vi.fn(async () => authenticatedMe);
    const { dependencies } = createAuthenticatedDependencies(getBackofficeMeCommand);
    const request = new Request("https://backoffice.example/private", {
      headers: { authorization: "Bearer signed-token" },
    });
    const context = contextForRequestState(createBackofficeRequestState(request, dependencies));

    const [found, required] = await Promise.all([
      findBackofficeMe(request, context),
      requireBackofficeMe(request, context),
    ]);

    expect(found).toEqual(authenticatedMe);
    expect(required).toEqual(authenticatedMe);
    expect(getBackofficeMeCommand).toHaveBeenCalledOnce();
  });

  test("shares a rejected membership command without retrying it", async () => {
    const failure = new Error("Auth membership lookup unavailable.");
    const getBackofficeMe = vi.fn(async () => {
      throw failure;
    });
    const { dependencies } = createAuthenticatedDependencies(getBackofficeMe);
    const state = createBackofficeRequestState(
      new Request("https://backoffice.example/private", {
        headers: { authorization: "Bearer signed-token" },
      }),
      dependencies,
    );

    const first = state.getBackofficeMe();
    const second = state.getBackofficeMe();

    await expect(first).rejects.toBe(failure);
    await expect(second).rejects.toBe(failure);
    expect(second).toBe(first);
    expect(getBackofficeMe).toHaveBeenCalledOnce();
  });

  test("coalesces concurrent Automations collection-source loads by canonical scope", async () => {
    const getBackofficeMe = vi.fn(async () => authenticatedMe);
    const { dependencies, loadAutomationCollectionSourceCall } =
      createAuthenticatedDependencies(getBackofficeMe);
    const state = createBackofficeRequestState(
      new Request("https://backoffice.example/backoffice/automations"),
      dependencies,
    );
    const firstScope = {
      kind: "org" as const,
      organization: { id: "org-1", slug: "acme" },
    };
    const equivalentScope = {
      kind: "org" as const,
      organization: { id: "org-1", slug: "renamed-acme" },
    };

    const first = state.getAutomationCollectionSource(firstScope);
    const second = state.getAutomationCollectionSource(equivalentScope);
    const [firstSource, secondSource] = await Promise.all([first, second]);

    expect(second).toBe(first);
    expect(secondSource).toBe(firstSource);
    expect(firstSource).toEqual({ resolvedScope: firstScope, adapterIdentity: "adapter-test" });
    expect(loadAutomationCollectionSourceCall).toHaveBeenCalledOnce();
  });

  test("keeps organization and project collection-source operations distinct", async () => {
    const getBackofficeMe = vi.fn(async () => authenticatedMe);
    const { dependencies, loadAutomationCollectionSourceCall } =
      createAuthenticatedDependencies(getBackofficeMe);
    const state = createBackofficeRequestState(
      new Request("https://backoffice.example/backoffice/automations"),
      dependencies,
    );
    const organization = { id: "org-1", slug: "acme" };

    await Promise.all([
      state.getAutomationCollectionSource({ kind: "org", organization }),
      state.getAutomationCollectionSource({
        kind: "project",
        organization,
        projectId: "project-1",
      }),
    ]);

    expect(loadAutomationCollectionSourceCall).toHaveBeenCalledTimes(2);
  });

  test("shares a rejected collection-source load without retrying it", async () => {
    const failure = new Error("Automations adapter description unavailable.");
    const getBackofficeMe = vi.fn(async () => authenticatedMe);
    const { dependencies, loadAutomationCollectionSourceCall } = createAuthenticatedDependencies(
      getBackofficeMe,
      failure,
    );
    const state = createBackofficeRequestState(
      new Request("https://backoffice.example/backoffice/automations"),
      dependencies,
    );
    const resolvedScope = {
      kind: "user" as const,
      userId: "user-1",
    };

    const first = state.getAutomationCollectionSource(resolvedScope);
    const second = state.getAutomationCollectionSource(resolvedScope);

    await expect(first).rejects.toBe(failure);
    await expect(second).rejects.toBe(failure);
    expect(second).toBe(first);
    expect(loadAutomationCollectionSourceCall).toHaveBeenCalledOnce();
  });

  test("does not share promises between request state instances", async () => {
    const getBackofficeMe = vi.fn(async () => authenticatedMe);
    const { dependencies, verifyJwt, loadAutomationCollectionSourceCall } =
      createAuthenticatedDependencies(getBackofficeMe);
    const request = new Request("https://backoffice.example/private", {
      headers: { authorization: "Bearer signed-token" },
    });
    const firstState = createBackofficeRequestState(request, dependencies);
    const secondState = createBackofficeRequestState(request, dependencies);

    const resolvedScope = { kind: "user" as const, userId: "user-1" };
    await Promise.all([
      firstState.getBackofficeMe(),
      secondState.getBackofficeMe(),
      firstState.getAutomationCollectionSource(resolvedScope),
      secondState.getAutomationCollectionSource(resolvedScope),
    ]);

    expect(verifyJwt).toHaveBeenCalledTimes(2);
    expect(getBackofficeMe).toHaveBeenCalledTimes(2);
    expect(loadAutomationCollectionSourceCall).toHaveBeenCalledTimes(2);
  });

  test("preserves invalid cookie recovery headers and bearer precedence", async () => {
    const getBackofficeMe = vi.fn(async () => authenticatedMe);
    const verifyJwt = vi.fn(async () => ({ ok: false as const, reason: "expired" as const }));
    const getAuthObject = vi.fn(() => ({
      http: { fetch: vi.fn() },
      commands: { getBackofficeMe },
    }));
    async function loadAutomationCollectionSource<
      TOrganization extends BackofficeOrganizationIdentity,
    >(
      _resolvedScope: BackofficeResolvedScope<TOrganization>,
    ): Promise<AutomationCollectionSource<TOrganization>> {
      throw new Error("Authentication recovery must not initialize Automations.");
    }
    const cookieRequest = new Request("https://backoffice.example/private", {
      headers: { cookie: "fragno-backoffice.access_token=expired-token" },
    });
    const bearerRequest = new Request("https://backoffice.example/private", {
      headers: {
        authorization: "Bearer expired-bearer",
        cookie: "fragno-backoffice.access_token=ignored-cookie",
      },
    });

    const cookieAuthentication = await createBackofficeRequestState(cookieRequest, {
      getAuthObject,
      verifyJwt,
      loadAutomationCollectionSource,
    }).resolveAuthentication();
    const bearerAuthentication = await createBackofficeRequestState(bearerRequest, {
      getAuthObject,
      verifyJwt,
      loadAutomationCollectionSource,
    }).resolveAuthentication();

    expect(cookieAuthentication).toMatchObject({ ok: false, reason: "expired" });
    expect(cookieAuthentication.headers).toHaveLength(2);
    expect(cookieAuthentication.headers[0]?.[1]).toContain("Max-Age=0");
    expect(bearerAuthentication).toEqual({ ok: false, reason: "expired", headers: [] });
    expect(verifyJwt).toHaveBeenNthCalledWith(
      2,
      "expired-bearer",
      bearerRequest.url,
      expect.anything(),
    );
  });
});
