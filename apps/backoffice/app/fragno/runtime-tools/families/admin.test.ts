import { assert, describe, expect, test, vi } from "vitest";

import { createTrustedSystemBackofficeToolContext } from "../runtime-tools";
import { adminRuntimeTools, type AdminRuntime } from "./admin";

describe("admin runtime tools", () => {
  test("normalizes organization owner email before validation", () => {
    expect(
      adminRuntimeTools[0].inputSchema.parse({
        name: "Acme",
        slug: "acme",
        ownerEmail: " Owner@Example.com ",
      }),
    ).toEqual({ name: "Acme", slug: "acme", ownerEmail: "owner@example.com" });
  });

  test("parses organization member commands by slug and email", () => {
    const addCommand = adminRuntimeTools[1].adapters?.bash;
    const removeCommand = adminRuntimeTools[2].adapters?.bash;
    assert(addCommand);
    assert(removeCommand);

    expect(
      addCommand.parse(["--org", "acme", "--email", "member@example.com", "--role", "member"]),
    ).toEqual({
      organizationSlug: "acme",
      userEmail: "member@example.com",
      roles: ["member"],
    });
    expect(removeCommand.parse(["--org", "acme", "--email", "member@example.com"])).toEqual({
      organizationSlug: "acme",
      userEmail: "member@example.com",
    });
  });

  test("delegates organization and membership changes to the admin runtime", async () => {
    const runtime: AdminRuntime = {
      listOAuthClients: async () => ({ clients: [], nextCursor: null, hasNextPage: false }),
      createOAuthClient: async () => ({
        clientType: "public" as const,
        clientId: "client-1",
        clientSecret: null,
      }),
      updateOAuthClient: async () => {
        throw new Error("OAuth client updates are not configured in this legacy fixture.");
      },
      rotateOAuthClientSecret: async () => {
        throw new Error("OAuth client secret rotation is not configured in this legacy fixture.");
      },
      createApp: async () => {
        throw new Error("App creation is not configured in this legacy fixture.");
      },
      updateAppActions: async () => {
        throw new Error("unexpected app action update");
      },
      updateAppPermissions: async () => {
        throw new Error("unexpected app permission update");
      },
      updateAppTrust: async () => {
        throw new Error("unexpected app trust update");
      },
      deleteOrganizationEventsOfType: async () => {
        throw new Error("unexpected event deletion");
      },
      setUsageLimit: async () => {
        throw new Error("unexpected usage limit change");
      },
      listApps: async () => {
        throw new Error("App listing is not configured in this legacy fixture.");
      },
      createAccessCode: async () => {
        throw new Error("Access code creation is not configured in this fixture.");
      },
      listAccessCodes: async () => {
        throw new Error("Access code listing is not configured in this fixture.");
      },
      listAccessCodeRedemptions: async () => {
        throw new Error("Access code redemption listing is not configured in this fixture.");
      },
      revokeAccessCode: async () => {
        throw new Error("Access code revocation is not configured in this fixture.");
      },
      verifyUserEmail: async () => {
        throw new Error("Email verification is not configured in this fixture.");
      },
      createOrganization: vi.fn(async (input) => ({
        organizationId: "org-1",
        name: input.name,
        slug: input.slug,
        ownerUserId: "owner-1",
      })),
      addOrganizationMember: vi.fn(async (input) => ({
        organizationId: "org-1",
        userId: "user-1",
        roles: [...input.roles],
      })),
      removeOrganizationMember: vi.fn(async () => ({
        organizationId: "org-1",
        userId: "user-1",
        roles: ["member"],
      })),
      setOrganizationManager: async () => {
        throw new Error("Organization management is not configured in this fixture.");
      },
      listOrganizations: async () => {
        throw new Error("Organization listing is not configured in this fixture.");
      },
      getOrganization: async () => {
        throw new Error("Organization reads are not configured in this fixture.");
      },
      listOrganizationMembers: async () => {
        throw new Error("Member listing is not configured in this fixture.");
      },
    };
    const context = createTrustedSystemBackofficeToolContext({ runtimes: { admin: runtime } });

    await expect(
      adminRuntimeTools[0].execute(
        { name: "Acme", slug: "acme", ownerEmail: "owner@example.com" },
        context,
      ),
    ).resolves.toEqual({
      organizationId: "org-1",
      name: "Acme",
      slug: "acme",
      ownerUserId: "owner-1",
    });
    await expect(
      adminRuntimeTools[1].execute(
        {
          organizationSlug: "acme",
          userEmail: "member@example.com",
          roles: ["member"],
        },
        context,
      ),
    ).resolves.toEqual({ organizationId: "org-1", userId: "user-1", roles: ["member"] });
    await expect(
      adminRuntimeTools[2].execute(
        { organizationSlug: "acme", userEmail: "member@example.com" },
        context,
      ),
    ).resolves.toEqual({ organizationId: "org-1", userId: "user-1", roles: ["member"] });
    expect(runtime.addOrganizationMember).toHaveBeenCalledWith({
      organizationSlug: "acme",
      userEmail: "member@example.com",
      roles: ["member"],
    });
    expect(runtime.removeOrganizationMember).toHaveBeenCalledWith({
      organizationSlug: "acme",
      userEmail: "member@example.com",
    });
  });
});
