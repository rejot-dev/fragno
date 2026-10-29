import { describe, expect, test } from "vitest";

import { createAdminRuntime } from "./admin-runtime";

function createAdminRuntimeDependencies() {
  return {
    apps: null,
    auth: {
      getOAuthClientFacts: async () => null,
      updateAdminOAuthClient: async () => {
        throw new Error("OAuth client updates are not configured in this fixture.");
      },
      rotateAdminOAuthClientSecret: async () => {
        throw new Error("OAuth client secret rotation is not configured in this fixture.");
      },
      listAdminOAuthClients: async () => ({ clients: [], nextCursor: null, hasNextPage: false }),
      createAdminOAuthClient: async () => ({
        clientType: "public" as const,
        clientId: "client-1",
        clientSecret: null,
      }),
      createAdminOrganization: async (input: { name: string; slug: string }) => ({
        organizationId: "org-1",
        name: input.name,
        slug: input.slug,
        ownerUserId: "owner-1",
      }),
      verifyAdminUserEmail: async (input: { email: string }) => ({
        userId: "user-1",
        email: input.email,
        status: "verified" as const,
      }),
      getOrganizationBySlug: async (slug: string) =>
        slug === "acme" ? { id: "org-1", slug, jurisdiction: null } : null,
      getOrganization: async () => null,
      getOrganizationRelations: async () => ({
        memberCount: 0,
        managingOrganization: null,
        managedOrganizations: [],
      }),
      listOrganizations: async () => ({ organizations: [], nextCursor: null, hasNextPage: false }),
      listOrganizationMembers: async () => ({ members: [], nextCursor: null, hasNextPage: false }),
      addAdminOrganizationMember: async (input: {
        organizationId: string;
        roles: readonly ("owner" | "admin" | "member")[];
      }) => ({
        organizationId: input.organizationId,
        userId: "user-1",
        roles: [...input.roles],
      }),
      removeAdminOrganizationMember: async (input: { organizationId: string }) => ({
        organizationId: input.organizationId,
        userId: "user-1",
        roles: ["member"],
      }),
      setOrganizationManager: async () => {
        throw new Error("Organization management is not configured in this fixture.");
      },
      findRootOwnerScope: async () => null,
    },
    otp: null,
    automationsFor: () => {
      throw new Error("These tests do not reach an organization's automations.");
    },
    billingFor: null,
    publicBaseUrl: "https://backoffice.example/",
  } satisfies Parameters<typeof createAdminRuntime>[0];
}

describe("createAdminRuntime", () => {
  test("resolves organization slugs before changing membership", async () => {
    const dependencies = createAdminRuntimeDependencies();
    const membershipCalls: unknown[] = [];
    dependencies.auth.addAdminOrganizationMember = async (input) => {
      membershipCalls.push(["add", input]);
      return { organizationId: input.organizationId, userId: "user-1", roles: [...input.roles] };
    };
    dependencies.auth.removeAdminOrganizationMember = async (input) => {
      membershipCalls.push(["remove", input]);
      return { organizationId: input.organizationId, userId: "user-1", roles: ["member"] };
    };
    const runtime = createAdminRuntime(dependencies);

    await expect(
      runtime.addOrganizationMember({
        organizationSlug: "acme",
        userEmail: "member@example.com",
        roles: ["member"],
      }),
    ).resolves.toEqual({ organizationId: "org-1", userId: "user-1", roles: ["member"] });
    await expect(
      runtime.removeOrganizationMember({
        organizationSlug: "acme",
        userEmail: "member@example.com",
      }),
    ).resolves.toEqual({ organizationId: "org-1", userId: "user-1", roles: ["member"] });
    expect(membershipCalls).toEqual([
      [
        "add",
        {
          organizationId: "org-1",
          userEmail: "member@example.com",
          roles: ["member"],
        },
      ],
      ["remove", { organizationId: "org-1", userEmail: "member@example.com" }],
    ]);
  });

  test("reports the missing organization slug before changing membership", async () => {
    const dependencies = createAdminRuntimeDependencies();
    dependencies.auth.getOrganizationBySlug = async () => null;
    const runtime = createAdminRuntime(dependencies);

    await expect(
      runtime.addOrganizationMember({
        organizationSlug: "missing",
        userEmail: "member@example.com",
        roles: ["member"],
      }),
    ).rejects.toThrow("Admin organization command could not find organization slug 'missing'.");
  });
});
