import { assert, beforeEach, describe, expect, test, vi } from "vitest";

const { authorizeBackofficePrincipalMock, requireBackofficePrincipalMock } = vi.hoisted(() => ({
  authorizeBackofficePrincipalMock: vi.fn(),
  requireBackofficePrincipalMock: vi.fn(),
}));

vi.mock("./request-auth.server", () => ({
  authorizeBackofficePrincipal: authorizeBackofficePrincipalMock,
  requireBackofficePrincipal: requireBackofficePrincipalMock,
}));

import {
  authorizeBackofficeCodemodeContext,
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
      },
      auth: {
        transport: "cookie",
        expiresAt,
        organization: { id: "org-1", slug: "acme", roles: ["owner"] },
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
        kind: "verified-request-authority",
        userId: "user-1",
        role: "admin",
        organizationId: "org-1",
        expiresAtEpochMs: expiresAt.getTime(),
      },
    });
  });

  test("preserves forbidden authorization responses", async () => {
    authorizeBackofficePrincipalMock.mockResolvedValue({
      ok: true,
      headers: [],
      principal: {
        user: { id: "user-1", role: "user" },
        auth: {
          transport: "cookie",
          expiresAt: new Date("2099-01-01T00:00:00.000Z"),
          organization: { id: "org-1", slug: "acme", roles: ["member"] },
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
    authorizeBackofficePrincipalMock.mockResolvedValue({
      ok: true,
      headers: [["Set-Cookie", "access-token=refreshed"]],
      principal: {
        user: { id: "user-1", role: "user" },
        auth: {
          transport: "cookie",
          expiresAt,
          organization: { id: "org-1", slug: "acme", roles: ["member"] },
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

  test("allows rejot.dev accounts to use codemode", async () => {
    authorizeBackofficePrincipalMock.mockResolvedValue({
      ok: true,
      headers: [],
      principal: {
        user: { id: "user-1", email: "Developer@Rejot.dev", role: "user" },
        auth: {
          transport: "bearer",
          expiresAt: new Date("2099-01-01T00:00:00.000Z"),
          organization: { id: "org-1", slug: "acme", roles: ["member"] },
        },
      },
    });

    await expect(
      authorizeBackofficeCodemodeContext(
        new Request("https://backoffice.example/api/backoffice/codemode/org/org-1"),
        {} as never,
        { kind: "org", orgId: "org-1" },
      ),
    ).resolves.toMatchObject({ ok: true });
  });

  test("forbids non-rejot.dev accounts from using codemode", async () => {
    authorizeBackofficePrincipalMock.mockResolvedValue({
      ok: true,
      headers: [["Set-Cookie", "access-token=refreshed"]],
      principal: {
        user: { id: "user-1", email: "user@example.com", role: "user" },
        auth: {
          transport: "cookie",
          expiresAt: new Date("2099-01-01T00:00:00.000Z"),
          organization: { id: "org-1", slug: "acme", roles: ["member"] },
        },
      },
    });

    const result = await authorizeBackofficeCodemodeContext(
      new Request("https://backoffice.example/api/backoffice/codemode/org/org-1"),
      {} as never,
      { kind: "org", orgId: "org-1" },
    );

    expect(result).toMatchObject({ ok: false, response: { status: 403 } });
    if (result.ok) {
      throw new Error("Expected codemode authorization to be forbidden.");
    }
    assert(result.response.headers.get("Set-Cookie") === "access-token=refreshed");
  });

  test("does not let an administrator enter another user's private scope", async () => {
    requireBackofficePrincipalMock.mockResolvedValue({
      user: { id: "admin-1", email: "admin@example.com", role: "admin" },
      auth: {
        transport: "cookie",
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
        organization: null,
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
