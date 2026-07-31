import { beforeEach, describe, expect, test, vi } from "vitest";

const { requireAuthPrincipalMock } = vi.hoisted(() => ({
  requireAuthPrincipalMock: vi.fn(),
}));

vi.mock("./access-token.server", () => ({
  requireAuthPrincipal: requireAuthPrincipalMock,
}));

import { requireBackofficeContext } from "./backoffice-principal.server";

describe("requireBackofficeContext", () => {
  beforeEach(() => {
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
});
