import { beforeEach, describe, expect, test, vi } from "vitest";

import { BACKOFFICE_PERMISSION } from "@/backoffice-runtime/permissions";

const { requireBackofficePrincipalMock } = vi.hoisted(() => ({
  requireBackofficePrincipalMock: vi.fn(),
}));

vi.mock("@/fragno/auth/request-auth.server", () => ({
  requireBackofficePrincipal: requireBackofficePrincipalMock,
}));

import { loader } from "./settings";

beforeEach(() => {
  requireBackofficePrincipalMock.mockReset();
  requireBackofficePrincipalMock.mockResolvedValue({
    user: {
      id: "user-1",
      role: "user",
    },
    auth: {
      transport: "cookie",
      expiresAt: new Date("2027-01-01T00:00:00.000Z"),
      organization: { id: "org-1", slug: "acme", roles: ["member"] },
    },
  });
});

describe("Backoffice settings authority inspection", () => {
  test("resolves grants through the production authority boundary for every displayed scope", async () => {
    const resolvePrincipalPermissions = vi.fn(
      async ({ execution }: { execution: { scope: { kind: string } } }) =>
        execution.scope.kind === "system"
          ? []
          : [BACKOFFICE_PERMISSION.store.read, BACKOFFICE_PERMISSION.pi.read],
    );
    const context = {
      get: () => ({
        runtime: {
          authorityResolver: {
            resolvePrincipalPermissions,
          },
        },
      }),
    };

    const result = await loader({
      request: new Request("https://backoffice.example/backoffice/settings"),
      context,
    } as never);

    expect(result).toEqual({
      authRole: "user",
      scopes: [
        {
          key: "user:user-1",
          scope: { kind: "user", userId: "user-1" },
          role: "user-owner",
          grants: [BACKOFFICE_PERMISSION.store.read, BACKOFFICE_PERMISSION.pi.read],
        },
        {
          key: "org:org-1",
          scope: { kind: "org", orgId: "org-1" },
          role: "organization-member",
          grants: [BACKOFFICE_PERMISSION.store.read, BACKOFFICE_PERMISSION.pi.read],
        },
      ],
    });
    expect(resolvePrincipalPermissions).toHaveBeenCalledTimes(2);
    expect(resolvePrincipalPermissions).toHaveBeenCalledWith({
      principal: {
        scope: "internal",
        type: "user",
        id: "user-1",
        role: "principal",
      },
      execution: expect.objectContaining({
        scope: { kind: "org", orgId: "org-1" },
        userAuthority: {
          kind: "verified-request-authority",
          userId: "user-1",
          role: "user",
          organizationId: "org-1",
          expiresAtEpochMs: Date.parse("2027-01-01T00:00:00.000Z"),
        },
      }),
    });
  });

  test("includes the global system scope for administrators", async () => {
    requireBackofficePrincipalMock.mockResolvedValue({
      user: { id: "admin-1", role: "admin" },
      auth: {
        transport: "cookie",
        expiresAt: new Date("2027-01-01T00:00:00.000Z"),
        organization: null,
      },
    });
    const resolvePrincipalPermissions = vi.fn(async () => [BACKOFFICE_PERMISSION.internal.manage]);

    const result = await loader({
      request: new Request("https://backoffice.example/backoffice/settings"),
      context: {
        get: () => ({ runtime: { authorityResolver: { resolvePrincipalPermissions } } }),
      },
    } as never);

    expect(result.scopes.map(({ scope }) => scope)).toEqual([
      { kind: "system" },
      { kind: "user", userId: "admin-1" },
    ]);
  });
});
