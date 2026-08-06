import { beforeEach, describe, expect, test, vi } from "vitest";

const { authorizeAuthPrincipalMock, requireAuthPrincipalMock } = vi.hoisted(() => ({
  authorizeAuthPrincipalMock: vi.fn(),
  requireAuthPrincipalMock: vi.fn(),
}));

vi.mock("./access-token.server", () => ({
  authorizeAuthPrincipal: authorizeAuthPrincipalMock,
  requireAuthPrincipal: requireAuthPrincipalMock,
}));

import {
  authorizeBackofficeContext,
  requireBackofficeContext,
} from "./backoffice-principal.server";

describe("requireBackofficeContext", () => {
  beforeEach(() => {
    authorizeAuthPrincipalMock.mockReset();
    requireAuthPrincipalMock.mockReset();
  });

  test("copies verified access-token authority into trusted execution context", async () => {
    const expiresAt = new Date("2099-01-01T00:00:00.000Z");
    requireAuthPrincipalMock.mockResolvedValue({
      user: {
        id: "user-1",
        email: "user@example.com",
        role: "admin",
      },
      auth: {
        strategy: "session",
        credentialKind: "jwt",
        credentialSource: "cookie",
        credentialId: "session-1",
        expiresAt,
        activeOrganizationId: "org-1",
        sessionContext: { organizationIds: ["org-1", "org-2"] },
      },
    });

    await expect(
      requireBackofficeContext(new Request("https://backoffice.example/"), {} as never, {
        kind: "org",
        orgId: "org-1",
      }),
    ).resolves.toMatchObject({
      scope: { kind: "org", orgId: "org-1" },
      userAuthority: {
        kind: "verified-access-token",
        userId: "user-1",
        role: "admin",
        organizationIds: ["org-1", "org-2"],
        expiresAtEpochMs: expiresAt.getTime(),
      },
    });
  });

  test("preserves forbidden authorization responses", async () => {
    authorizeAuthPrincipalMock.mockResolvedValue({
      ok: true,
      headers: [],
      principal: {
        user: { id: "user-1", role: "user" },
        auth: {
          credentialKind: "jwt",
          expiresAt: new Date("2099-01-01T00:00:00.000Z"),
          sessionContext: { organizationIds: ["org-1"] },
        },
      },
    });

    const result = await authorizeBackofficeContext(
      new Request("https://backoffice.example/"),
      {} as never,
      { kind: "org", orgId: "org-2" },
    );

    expect(result).toMatchObject({ ok: false, response: { status: 403 } });
  });

  test("returns refreshed authentication headers with the scoped execution", async () => {
    const expiresAt = new Date("2099-01-01T00:00:00.000Z");
    authorizeAuthPrincipalMock.mockResolvedValue({
      ok: true,
      headers: [["Set-Cookie", "access-token=refreshed"]],
      principal: {
        user: { id: "user-1", role: "user" },
        auth: {
          credentialKind: "jwt",
          expiresAt,
          sessionContext: { organizationIds: ["org-1"] },
        },
      },
    });

    await expect(
      authorizeBackofficeContext(new Request("https://backoffice.example/"), {} as never, {
        kind: "org",
        orgId: "org-1",
      }),
    ).resolves.toMatchObject({
      ok: true,
      headers: [["Set-Cookie", "access-token=refreshed"]],
      execution: { scope: { kind: "org", orgId: "org-1" } },
    });
  });

  test("does not let an administrator enter another user's private scope", async () => {
    requireAuthPrincipalMock.mockResolvedValue({
      user: { id: "admin-1", email: "admin@example.com", role: "admin" },
      auth: {
        credentialKind: "jwt",
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
        sessionContext: { organizationIds: [] },
      },
    });

    await expect(
      requireBackofficeContext(new Request("https://backoffice.example/"), {} as never, {
        kind: "user",
        userId: "user-1",
      }),
    ).rejects.toMatchObject({ reason: "policy-denied" });
  });
});
