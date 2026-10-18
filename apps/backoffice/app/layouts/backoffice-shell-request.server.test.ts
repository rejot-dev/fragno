import { describe, expect, test, vi } from "vitest";

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
};

const authenticatedPrincipal: BackofficeAuthPrincipal = {
  user: { id: "user-1", email: "user@example.com", role: "user" },
  auth: {
    scopeRestriction: null,
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
  // Organization "acme" has one project, "website".
  const automations = {
    http: {
      fetch: async (projectRequest: Request) =>
        new URL(projectRequest.url).pathname.endsWith("/projects/by-slug/website")
          ? Response.json({ id: "project-1", slug: "website", name: "Website", archivedAt: null })
          : Response.json(
              { message: "Project not found.", code: "PROJECT_NOT_FOUND" },
              { status: 404 },
            ),
    },
  };
  const context = createBackofficeRouterContextProvider(request, {
    runtime: { objects: { automations: { for: () => automations } } } as never,
    kernel: {
      scoped: (_binding: string, scope: unknown, family: { for(scope: unknown): unknown }) =>
        family.for(scope),
    } as never,
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
      "https://backoffice.example/backoffice/dashboard/project/org:acme:website",
    );
    const { context, getPrincipal } = createShellContext({ request });
    const response = new Response("descendant response");
    const next = vi.fn(async () => {
      expect(getBackofficeShellRequest(context)).toMatchObject({
        me: authenticatedMe,
        principal: authenticatedPrincipal,
        resolvedScope: {
          kind: "project",
          owner: { kind: "org" as const, organization: activeOrganization.organization },
          project: { id: "project-1", slug: "website", name: "Website" },
        },
        route: {
          status: "resolved",
          resolvedScope: {
            kind: "project",
            owner: { kind: "org", organization: activeOrganization.organization },
            project: { id: "project-1", slug: "website", name: "Website" },
          },
          selection: { kind: "project", label: "Website" },
          execution: {
            scope: {
              kind: "project",
              owner: { kind: "org", orgId: "org-1" },
              projectId: "project-1",
            },
            userAuthority: {
              scopeRestriction: null,
              kind: "verified-request-authority",
              userId: "user-1",
              organizationId: "org-1",
              expiresAtEpochMs: expiresAt.getTime(),
            },
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
          url: new URL(request.url),
          params: { scopeKind: "project", scopeId: "org:acme:website" },
        },
        next,
      ),
    ).resolves.toBe(response);
    expect(next).toHaveBeenCalledOnce();
    expect(getPrincipal).toHaveBeenCalledOnce();
  });

  test.each([
    { scopeKind: "project", scopeId: "org:acme:project-1" },
    { scopeKind: "org", scopeId: "org-1" },
    { scopeKind: "org", scopeId: "acme:extra" },
  ])("keeps the default scope while recording that %o did not resolve", async (params) => {
    const request = new Request("https://backoffice.example/backoffice/automations");
    const { context } = createShellContext({ request });
    const next = vi.fn(async () => {
      expect(getBackofficeShellRequest(context)).toMatchObject({
        route: { status: "not-found" },
        resolvedScope: { kind: "org", organization: activeOrganization.organization },
      });
      return new Response("descendant response");
    });

    await establishBackofficeShellRequest(
      { request, context, url: new URL(request.url), params },
      next,
    );
    expect(next).toHaveBeenCalledOnce();
  });

  test("hides System scope from non-administrators so sections report it as not found", async () => {
    const request = new Request("https://backoffice.example/backoffice/dashboard/system/system");
    const { context } = createShellContext({ request });
    const next = vi.fn(async () => {
      expect(getBackofficeShellRequest(context)).toMatchObject({
        resolvedScope: { kind: "org", organization: activeOrganization.organization },
        route: { status: "not-found" },
      });
      return new Response("descendant response");
    });

    await establishBackofficeShellRequest(
      {
        request,
        context,
        url: new URL(request.url),
        params: { scopeKind: "system", scopeId: "system" },
      },
      next,
    );
    expect(next).toHaveBeenCalledOnce();
  });
});
