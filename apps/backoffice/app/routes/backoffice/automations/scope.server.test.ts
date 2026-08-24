import { beforeEach, describe, expect, test, vi } from "vitest";

const { requireBackofficePrincipalMock } = vi.hoisted(() => ({
  requireBackofficePrincipalMock: vi.fn(),
}));

vi.mock("@/fragno/auth/request-auth.server", () => ({
  requireBackofficePrincipal: requireBackofficePrincipalMock,
}));

import { requireAutomationRouteExecution } from "./scope.server";

const request = new Request("https://backoffice.example/backoffice/automations/org/acme/scripts");
const context = {} as never;

beforeEach(() => {
  requireBackofficePrincipalMock.mockReset();
  requireBackofficePrincipalMock.mockResolvedValue({
    user: { id: "user-1", email: "user@example.com", role: "user" },
    auth: {
      transport: "cookie",
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      organization: { id: "org-123", slug: "acme", roles: ["owner"] },
    },
  });
});

describe("authenticated automation route scope", () => {
  test("uses the signed JWT organization slug to recover the ID-backed runtime scope", async () => {
    await expect(
      requireAutomationRouteExecution(request, context, {
        scopeKind: "org",
        scopeId: "acme",
      }),
    ).resolves.toMatchObject({ scope: { kind: "org", orgId: "org-123" } });

    expect(requireBackofficePrincipalMock).toHaveBeenCalledOnce();
  });

  test("resolves project routes from the same signed organization identity", async () => {
    await expect(
      requireAutomationRouteExecution(request, context, {
        scopeKind: "project",
        scopeId: "acme:project-1",
      }),
    ).resolves.toMatchObject({
      scope: { kind: "project", orgId: "org-123", projectId: "project-1" },
    });
  });

  test("does not treat an organization ID as a slug fallback", async () => {
    await expect(
      requireAutomationRouteExecution(request, context, {
        scopeKind: "org",
        scopeId: "org-123",
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
