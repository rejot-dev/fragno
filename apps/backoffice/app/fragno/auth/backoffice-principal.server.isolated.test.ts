import { beforeEach, describe, expect, test, vi } from "vitest";

const { authorizeBackofficePrincipalMock, requireBackofficePrincipalMock } = vi.hoisted(() => ({
  authorizeBackofficePrincipalMock: vi.fn(),
  requireBackofficePrincipalMock: vi.fn(),
}));

vi.mock("./request-auth.server", () => ({
  authorizeBackofficePrincipal: authorizeBackofficePrincipalMock,
  requireBackofficePrincipal: requireBackofficePrincipalMock,
}));

import {
  authorizeBackofficeContext,
  requireBackofficeContext,
} from "./backoffice-principal.server";

describe("requireBackofficeContext", () => {
  beforeEach(() => {
    authorizeBackofficePrincipalMock.mockReset();
    requireBackofficePrincipalMock.mockReset();
  });

  test("copies verified access-token authority into trusted execution context", async () => {
    const expiresAt = new Date("2099-01-01T00:00:00.000Z");
    requireBackofficePrincipalMock.mockResolvedValue({
      user: {
        id: "user-1",
        email: "user@example.com",
        role: "admin",
        personalScope: { kind: "user", userId: "user-1", jurisdiction: null },
      },
      auth: {
        scopeRestriction: null,
        transport: "cookie",
        expiresAt,
        organization: { id: "org-1", slug: "acme", jurisdiction: null, roles: ["owner"] },
      },
    });

    await expect(
      requireBackofficeContext(new Request("https://backoffice.example/"), {} as never, {
        kind: "org",
        orgId: "org-1",
        jurisdiction: null,
      }),
    ).resolves.toMatchObject({
      scope: { kind: "org", orgId: "org-1", jurisdiction: null },
      userAuthority: {
        scopeRestriction: null,
        kind: "verified-request-authority",
        userId: "user-1",
        personalScope: { kind: "user", userId: "user-1", jurisdiction: null },
        role: "admin",
        organization: { kind: "org", orgId: "org-1", jurisdiction: null },
        expiresAtEpochMs: expiresAt.getTime(),
      },
    });
  });

  test("preserves forbidden authorization responses", async () => {
    authorizeBackofficePrincipalMock.mockResolvedValue({
      ok: true,
      headers: [],
      principal: {
        user: {
          id: "user-1",
          role: "user",
          personalScope: { kind: "user", userId: "user-1", jurisdiction: null },
        },
        auth: {
          scopeRestriction: null,
          transport: "cookie",
          expiresAt: new Date("2099-01-01T00:00:00.000Z"),
          organization: { id: "org-1", slug: "acme", jurisdiction: null, roles: ["member"] },
        },
      },
    });

    const result = await authorizeBackofficeContext(
      new Request("https://backoffice.example/"),
      {} as never,
      { kind: "org", orgId: "org-2", jurisdiction: null },
    );

    expect(result).toMatchObject({ ok: false, response: { status: 403 } });
  });

  test("returns refreshed authentication headers with the scoped execution", async () => {
    const expiresAt = new Date("2099-01-01T00:00:00.000Z");
    authorizeBackofficePrincipalMock.mockResolvedValue({
      ok: true,
      headers: [["Set-Cookie", "access-token=refreshed"]],
      principal: {
        user: {
          id: "user-1",
          role: "user",
          personalScope: { kind: "user", userId: "user-1", jurisdiction: null },
        },
        auth: {
          scopeRestriction: null,
          transport: "cookie",
          expiresAt,
          organization: { id: "org-1", slug: "acme", jurisdiction: null, roles: ["member"] },
        },
      },
    });

    await expect(
      authorizeBackofficeContext(new Request("https://backoffice.example/"), {} as never, {
        kind: "org",
        orgId: "org-1",
        jurisdiction: null,
      }),
    ).resolves.toMatchObject({
      ok: true,
      headers: [["Set-Cookie", "access-token=refreshed"]],
      execution: { scope: { kind: "org", orgId: "org-1", jurisdiction: null } },
    });
  });

  test("does not let an administrator enter another user's private scope", async () => {
    requireBackofficePrincipalMock.mockResolvedValue({
      user: {
        id: "admin-1",
        email: "admin@example.com",
        role: "admin",
        personalScope: { kind: "user", userId: "admin-1", jurisdiction: null },
      },
      auth: {
        scopeRestriction: null,
        transport: "cookie",
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
        organization: null,
      },
    });

    // The administrator owns or administers no organization of user-1.
    const routerContext = {
      get: () => ({
        runtime: {
          objects: {
            auth: { singleton: () => ({ commands: { findAdministeredMember: async () => null } }) },
          },
        },
      }),
    };
    await expect(
      requireBackofficeContext(new Request("https://backoffice.example/"), routerContext as never, {
        kind: "user",
        userId: "user-1",
        jurisdiction: null,
      }),
    ).rejects.toMatchObject({ reason: "policy-denied" });
  });
});
