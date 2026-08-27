import { describe, expect, test, vi } from "vitest";

import { createTrustedSystemBackofficeToolContext } from "../runtime-tools";
import { adminRuntimeTools, type AdminRuntime } from "./admin";

describe("admin runtime tools", () => {
  test("exposes the requested organization administration tools", () => {
    expect(adminRuntimeTools.map(({ id }) => id)).toEqual([
      "admin.organisation.create",
      "admin.organisation.members.add",
      "admin.organisation.members.remove",
    ]);
  });

  test("normalizes organization owner email before validation", () => {
    expect(
      adminRuntimeTools[0].inputSchema.parse({
        name: "Acme",
        slug: "acme",
        ownerEmail: " Owner@Example.com ",
      }),
    ).toEqual({ name: "Acme", slug: "acme", ownerEmail: "owner@example.com" });
  });

  test("delegates organization and membership changes to the admin runtime", async () => {
    const runtime: AdminRuntime = {
      createOrganization: vi.fn(async (input) => ({
        organizationId: "org-1",
        name: input.name,
        slug: input.slug,
        ownerUserId: "owner-1",
      })),
      addOrganizationMember: vi.fn(async (input) => ({ ...input, roles: [...input.roles] })),
      removeOrganizationMember: vi.fn(async (input) => ({ ...input, roles: ["member"] })),
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
        { organizationId: "org-1", userId: "user-1", roles: ["member"] },
        context,
      ),
    ).resolves.toEqual({ organizationId: "org-1", userId: "user-1", roles: ["member"] });
    await expect(
      adminRuntimeTools[2].execute({ organizationId: "org-1", userId: "user-1" }, context),
    ).resolves.toEqual({ organizationId: "org-1", userId: "user-1", roles: ["member"] });
  });
});
