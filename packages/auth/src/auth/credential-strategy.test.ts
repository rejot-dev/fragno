import { describe, expect, it, vi } from "vitest";

import { toAuthActor } from "./actor";
import {
  buildIssuedCredentialHeaders,
  createSessionCredentialStrategy,
} from "./credential-strategy";

describe("session credential strategy", () => {
  it("resolves bearer-authenticated principals", async () => {
    const strategy = createSessionCredentialStrategy({
      validateCredential: vi.fn(async (token: string) => ({
        id: token,
        expiresAt: new Date("2026-01-02T03:04:05.000Z"),
        activeOrganizationId: "org_123",
        user: {
          id: "user_123",
          email: "principal@test.com",
          role: "admin" as const,
        },
      })),
      issueCredential: vi.fn(),
      invalidateCredential: vi.fn(async () => true),
    });

    const result = await strategy.resolveRequestAuth({
      headers: new Headers({ Authorization: "Bearer session_123" }),
    });

    expect(result).toEqual({
      ok: true,
      principal: {
        user: {
          id: "user_123",
          email: "principal@test.com",
          role: "admin",
        },
        auth: {
          strategy: "session",
          credentialKind: "session",
          credentialSource: "authorization-header",
          credentialId: "session_123",
          expiresAt: new Date("2026-01-02T03:04:05.000Z"),
          activeOrganizationId: "org_123",
        },
      },
    });

    if (!result.ok) {
      throw new Error("Expected principal");
    }

    expect(toAuthActor(result.principal)).toEqual({
      userId: "user_123",
      email: "principal@test.com",
      role: "admin",
      activeOrganizationId: "org_123",
    });
  });

  it("surfaces missing, malformed, and invalid auth failures", async () => {
    const strategy = createSessionCredentialStrategy({
      validateCredential: vi.fn(async () => null),
      issueCredential: vi.fn(),
      invalidateCredential: vi.fn(async () => true),
    });

    await expect(strategy.resolveRequestAuth({ headers: new Headers() })).resolves.toEqual({
      ok: false,
      reason: "missing",
    });

    await expect(
      strategy.resolveRequestAuth({
        headers: new Headers({ Authorization: "Basic nope" }),
      }),
    ).resolves.toEqual({ ok: false, reason: "malformed" });

    await expect(
      strategy.resolveRequestAuth({
        headers: new Headers({ Cookie: "fragno_auth=session_123" }),
      }),
    ).resolves.toEqual({ ok: false, reason: "invalid" });
  });

  it("issues and clears session credentials with the strategy-neutral cookie", async () => {
    const invalidateCredential = vi.fn(async () => true);
    const strategy = createSessionCredentialStrategy({
      cookieOptions: { sameSite: "Lax" },
      validateCredential: vi.fn(async () => null),
      issueCredential: vi.fn(async () => ({
        ok: true as const,
        credential: {
          id: "session_123",
          expiresAt: new Date("2026-01-02T03:04:05.000Z"),
          activeOrganizationId: "org_123",
        },
      })),
      invalidateCredential,
    });

    await expect(
      strategy.issueCredential({
        userId: "user_123",
        activeOrganizationId: "org_123",
      }),
    ).resolves.toEqual({
      token: "session_123",
      kind: "session",
      expiresAt: new Date("2026-01-02T03:04:05.000Z"),
      activeOrganizationId: "org_123",
    });

    const clearResult = await strategy.clearCredential({
      principal: {
        user: {
          id: "user_123",
          email: "principal@test.com",
          role: "admin" as const,
        },
        auth: {
          strategy: "session",
          credentialKind: "session",
          credentialSource: "cookie",
          credentialId: "session_123",
          expiresAt: new Date("2026-01-02T03:04:05.000Z"),
          activeOrganizationId: "org_123",
        },
      },
    });

    expect(invalidateCredential).toHaveBeenCalledWith("session_123");
    expect(clearResult.headers).toEqual({
      "Set-Cookie": expect.stringContaining("fragno_auth="),
    });
    expect(
      buildIssuedCredentialHeaders({
        token: "session_123",
        kind: "session",
        expiresAt: new Date("2026-01-02T03:04:05.000Z"),
        activeOrganizationId: null,
      }),
    ).toEqual({
      "Set-Cookie": expect.stringContaining("fragno_auth=session_123"),
    });
  });
});
