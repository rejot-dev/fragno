import { describe, expect, test } from "vitest";

import { createAdminRuntime } from "./admin-runtime";

describe("createAdminRuntime", () => {
  test("resolves organization slugs before changing membership", async () => {
    const membershipCalls: unknown[] = [];
    const auth: Parameters<typeof createAdminRuntime>[0] = {
      createAdminOrganization: async (input) => ({
        organizationId: "org-1",
        name: input.name,
        slug: input.slug,
        ownerUserId: "owner-1",
      }),
      getOrganizationBySlug: async (slug) => (slug === "acme" ? { id: "org-1", slug } : null),
      addAdminOrganizationMember: async (input) => {
        membershipCalls.push(["add", input]);
        return { organizationId: input.organizationId, userId: "user-1", roles: [...input.roles] };
      },
      removeAdminOrganizationMember: async (input) => {
        membershipCalls.push(["remove", input]);
        return { organizationId: input.organizationId, userId: "user-1", roles: ["member"] };
      },
    };
    const runtime = createAdminRuntime(auth);

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
    const auth: Parameters<typeof createAdminRuntime>[0] = {
      createAdminOrganization: async () => {
        throw new Error("createAdminOrganization should not be called");
      },
      getOrganizationBySlug: async () => null,
      addAdminOrganizationMember: async () => {
        throw new Error("addAdminOrganizationMember should not be called");
      },
      removeAdminOrganizationMember: async () => {
        throw new Error("removeAdminOrganizationMember should not be called");
      },
    };
    const runtime = createAdminRuntime(auth);

    await expect(
      runtime.addOrganizationMember({
        organizationSlug: "missing",
        userEmail: "member@example.com",
        roles: ["member"],
      }),
    ).rejects.toThrow(
      "Admin organization member command could not find organization slug 'missing'.",
    );
  });
});
