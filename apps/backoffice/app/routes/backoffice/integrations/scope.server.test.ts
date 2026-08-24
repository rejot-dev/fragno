import { describe, expect, test, vi } from "vitest";

import type { BackofficeAuthPrincipal } from "@/fragno/auth/contracts";

const { requireBackofficePrincipalMock } = vi.hoisted(() => ({
  requireBackofficePrincipalMock: vi.fn(),
}));

vi.mock("@/fragno/auth/request-auth.server", () => ({
  requireBackofficePrincipal: requireBackofficePrincipalMock,
}));

import { resolveAuthenticatedIntegrationRuntimeScope } from "./scope.server";

const request = new Request("https://backoffice.example/backoffice/automations/org/acme");
const context = {} as never;

function authenticatedPrincipal(
  organization: BackofficeAuthPrincipal["auth"]["organization"],
): BackofficeAuthPrincipal {
  return {
    user: { id: "user-1", email: "user@example.com", role: "user" },
    auth: {
      transport: "cookie",
      expiresAt: new Date("2026-08-25T00:00:00.000Z"),
      organization,
    },
  };
}

describe("authenticated integration runtime scope", () => {
  test("uses the active JWT organization ID after matching the public slug", async () => {
    requireBackofficePrincipalMock.mockResolvedValue(
      authenticatedPrincipal({ id: "org-123", slug: "acme", roles: ["owner"] }),
    );

    await expect(
      resolveAuthenticatedIntegrationRuntimeScope({
        request,
        context,
        params: { scopeKind: "org", scopeId: "acme" },
      }),
    ).resolves.toEqual({ kind: "org", orgId: "org-123" });
  });

  test("rejects an organization slug that is not active in the JWT", async () => {
    requireBackofficePrincipalMock.mockResolvedValue(
      authenticatedPrincipal({ id: "org-123", slug: "acme", roles: ["owner"] }),
    );

    await expect(
      resolveAuthenticatedIntegrationRuntimeScope({
        request,
        context,
        params: { scopeKind: "org", scopeId: "another-org" },
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  test("requires global admin authority for the system scope", async () => {
    requireBackofficePrincipalMock.mockResolvedValue(authenticatedPrincipal(null));

    await expect(
      resolveAuthenticatedIntegrationRuntimeScope({
        request,
        context,
        params: { scopeKind: "system", scopeId: "system" },
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
