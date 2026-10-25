import { describe, expect, test, vi } from "vitest";

import type { BackofficeMeData } from "@/fragno/auth/contracts";
import {
  BackofficeRequestStateContext,
  type BackofficeMeLookupResult,
  type BackofficeRequestState,
} from "@/worker-runtime/request-state";
import { createBackofficeRouterContextProvider } from "@/worker-runtime/router-context-provider.server";

import {
  establishBackofficeAuthenticatedRequest,
  getBackofficeAuthenticatedRequest,
} from "./backoffice-authenticated-request.server";

const authenticatedMe: BackofficeMeData = {
  user: {
    id: "user-1",
    name: "Test User",
    email: "user@example.com",
    emailVerified: true,
    role: "user",
    banned: false,
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    updatedAt: new Date("2026-09-01T00:00:00.000Z"),
  },
  organizations: [],
  activeOrganizationId: null,
  activeOrganization: null,
};

function createAuthenticationContext(
  request: Request,
  getBackofficeMe: BackofficeRequestState["getBackofficeMe"],
) {
  const context = createBackofficeRouterContextProvider(request, {
    runtime: {} as never,
    kernel: {} as never,
    env: {} as CloudflareEnv,
    ctx: {} as ExecutionContext,
  });
  context.set(BackofficeRequestStateContext, {
    async resolveAuthentication() {
      throw new Error("Authentication middleware must use the membership operation.");
    },
    async getPrincipal() {
      throw new Error("Authentication middleware must not resolve the principal separately.");
    },
    getBackofficeMe,
    async getAutomationReplicaSource() {
      throw new Error("Authentication middleware must not initialize Automations.");
    },
  });
  return context;
}

describe("Backoffice authenticated request middleware", () => {
  test("establishes authenticated membership before descendant handlers run", async () => {
    const request = new Request("https://backoffice.example/backoffice/settings");
    const expiresAt = new Date("2026-09-01T12:15:00.000Z");
    const authentication: BackofficeMeLookupResult = {
      status: "authenticated",
      me: authenticatedMe,
      expiresAt,
    };
    const getBackofficeMe = vi.fn<BackofficeRequestState["getBackofficeMe"]>(
      async () => authentication,
    );
    const context = createAuthenticationContext(request, getBackofficeMe);
    const response = new Response("descendant response");
    const next = vi.fn(async () => {
      expect(getBackofficeAuthenticatedRequest(context)).toEqual({
        me: authenticatedMe,
        accessTokenExpiresAt: expiresAt,
      });
      return response;
    });

    await expect(
      establishBackofficeAuthenticatedRequest(
        { request, context, url: new URL(request.url) },
        next,
      ),
    ).resolves.toBe(response);
    expect(next).toHaveBeenCalledOnce();
    expect(getBackofficeMe).toHaveBeenCalledOnce();
  });
});
