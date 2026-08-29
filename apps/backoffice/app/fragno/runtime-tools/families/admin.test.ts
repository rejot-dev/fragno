import { assert, describe, expect, test, vi } from "vitest";

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

  test("parses organization member commands by slug and email", () => {
    const addCommand = adminRuntimeTools[1].adapters?.bash;
    const removeCommand = adminRuntimeTools[2].adapters?.bash;
    assert(addCommand);
    assert(removeCommand);

    expect(
      addCommand.parse([
        "--organization-slug",
        "acme",
        "--email",
        "member@example.com",
        "--role",
        "member",
      ]),
    ).toEqual({
      organizationSlug: "acme",
      userEmail: "member@example.com",
      roles: ["member"],
    });
    expect(
      removeCommand.parse(["--organization-slug", "acme", "--email", "member@example.com"]),
    ).toEqual({
      organizationSlug: "acme",
      userEmail: "member@example.com",
    });
  });

  test("delegates organization and membership changes to the admin runtime", async () => {
    const runtime: AdminRuntime = {
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
