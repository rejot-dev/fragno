import { assert, describe, expect, test, vi } from "vitest";

import type {
  BackofficeAuthPrincipal,
  BackofficeMeData,
  Organization,
  OrganizationMembership,
} from "@/fragno/auth/contracts";
import {
  BackofficeRequestStateContext,
  type BackofficeRequestState,
} from "@/worker-runtime/request-state";
import { createBackofficeRouterContextProvider } from "@/worker-runtime/router-context-provider.server";

import { BackofficeAuthenticatedRequestContext } from "./backoffice-authenticated-request.server";
import {
  establishBackofficeShellRequest,
  getBackofficeShellRequest,
} from "./backoffice-shell-request.server";

const expiresAt = new Date("2026-09-01T12:15:00.000Z");

function createOrganization(id: string, slug: string, name: string): Organization {
  return {
    id,
    slug,
    name,
    createdBy: "user-1",
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    updatedAt: new Date("2026-09-01T00:00:00.000Z"),
  };
}

function createMembership(organization: Organization): OrganizationMembership {
  return {
    organization,
    member: {
      id: `member-${organization.id}`,
      organizationId: organization.id,
      userId: "user-1",
      roles: ["member"],
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
      updatedAt: new Date("2026-09-01T00:00:00.000Z"),
    },
  };
}

const activeOrganization = createMembership(createOrganization("org-1", "acme", "Acme"));
const otherOrganization = createMembership(createOrganization("org-2", "beta", "Beta"));

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
  organizations: [activeOrganization, otherOrganization],
  activeOrganizationId: activeOrganization.organization.id,
  activeOrganization,
  invitations: [],
};

const authenticatedPrincipal: BackofficeAuthPrincipal = {
  user: { id: "user-1", email: "user@example.com", role: "user" },
  auth: {
    transport: "cookie",
    expiresAt,
    organization: { id: "org-1", slug: "acme", roles: ["member"] },
  },
};

function createShellContext({
  request,
  me = authenticatedMe,
  principal = authenticatedPrincipal,
}: {
  request: Request;
  me?: BackofficeMeData;
  principal?: BackofficeAuthPrincipal;
}) {
  const context = createBackofficeRouterContextProvider(request, {
    runtime: {} as never,
    kernel: {} as never,
    env: {} as CloudflareEnv,
    ctx: {} as ExecutionContext,
  });
  context.set(BackofficeAuthenticatedRequestContext, {
    me,
    accessTokenExpiresAt: expiresAt,
  });
  const getPrincipal = vi.fn<BackofficeRequestState["getPrincipal"]>(async () => ({
    ok: true,
    principal,
    headers: [],
  }));
  context.set(BackofficeRequestStateContext, {
    async resolveAuthentication() {
      throw new Error("Shell middleware must reuse established authentication.");
    },
    getPrincipal,
    async getBackofficeMe() {
      throw new Error("Shell middleware must reuse established membership.");
    },
    async getAutomationCollectionSource() {
      throw new Error("Shell middleware must not initialize Automations.");
    },
  });
  return { context, getPrincipal };
}

describe("Backoffice shell request middleware", () => {
  test("establishes resolved scope and execution before descendant handlers run", async () => {
    const request = new Request(
      "https://backoffice.example/backoffice/automations/project/acme%3Aproject-1/dashboard",
    );
    const { context, getPrincipal } = createShellContext({ request });
    const response = new Response("descendant response");
    const next = vi.fn(async () => {
      expect(getBackofficeShellRequest(context)).toMatchObject({
        me: authenticatedMe,
        principal: authenticatedPrincipal,
        resolvedScope: {
          kind: "project",
          organization: activeOrganization.organization,
          projectId: "project-1",
        },
        runtimeScope: { kind: "project", orgId: "org-1", projectId: "project-1" },
        execution: {
          scope: { kind: "project", orgId: "org-1", projectId: "project-1" },
          userAuthority: {
            kind: "verified-request-authority",
            userId: "user-1",
            organizationId: "org-1",
            expiresAtEpochMs: expiresAt.getTime(),
          },
        },
        accessTokenExpiresAt: expiresAt,
      });
      return response;
    });

    await expect(
      establishBackofficeShellRequest(
        {
          request,
          context,
          params: { scopeKind: "project", scopeId: "acme:project-1" },
        },
        next,
      ),
    ).resolves.toBe(response);
    expect(next).toHaveBeenCalledOnce();
    expect(getPrincipal).toHaveBeenCalledOnce();
  });

  test("redirects organization changes before resolving execution authority", async () => {
    const request = new Request(
      "https://backoffice.example/backoffice/automations/org/beta/dashboard?tab=runs",
    );
    const { context, getPrincipal } = createShellContext({ request });
    const next = vi.fn(async () => new Response("descendant response"));

    const result = await establishBackofficeShellRequest(
      { request, context, params: { scopeKind: "org", scopeId: "beta" } },
      next,
    ).catch((error: unknown) => error);

    assert(result instanceof Response);
    assert.equal(result.status, 302);
    assert.equal(
      result.headers.get("location"),
      "/backoffice/auth/bootstrap?organizationId=org-2&returnTo=%2Fbackoffice%2Fautomations%2Forg%2Fbeta%2Fdashboard%3Ftab%3Druns",
    );
    expect(next).not.toHaveBeenCalled();
    expect(getPrincipal).not.toHaveBeenCalled();
  });

  test("redirects inconsistent active organization state before descendant work", async () => {
    const request = new Request("https://backoffice.example/backoffice/settings");
    const { context, getPrincipal } = createShellContext({
      request,
      me: { ...authenticatedMe, activeOrganization: null },
    });
    const next = vi.fn(async () => new Response("descendant response"));

    const result = await establishBackofficeShellRequest(
      { request, context, params: {} },
      next,
    ).catch((error: unknown) => error);

    assert(result instanceof Response);
    assert.equal(result.status, 302);
    assert.equal(
      result.headers.get("location"),
      "/backoffice/auth/bootstrap?returnTo=%2Fbackoffice%2Fsettings",
    );
    expect(next).not.toHaveBeenCalled();
    expect(getPrincipal).not.toHaveBeenCalled();
  });

  test("rejects forbidden scopes before descendant handlers run", async () => {
    const request = new Request("https://backoffice.example/backoffice/automations/system/system");
    const { context, getPrincipal } = createShellContext({ request });
    const next = vi.fn(async () => new Response("descendant response"));

    const result = await establishBackofficeShellRequest(
      { request, context, params: { scopeKind: "system", scopeId: "system" } },
      next,
    ).catch((error: unknown) => error);

    assert(result instanceof Response);
    assert.equal(result.status, 403);
    assert.equal(await result.text(), "System context requires an admin user.");
    expect(next).not.toHaveBeenCalled();
    expect(getPrincipal).toHaveBeenCalledOnce();
  });
});
