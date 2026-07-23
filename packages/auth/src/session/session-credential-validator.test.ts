import { describe, expect, it } from "vitest";

import { FragnoId } from "@fragno-dev/db/schema";

import { validateSessionCredentialOwner } from "./session-credential-validator";

const createOwner = (
  overrides: Partial<{
    role: string;
    bannedAt: Date | null;
    emailVerifiedAt: Date | null;
  }> = {},
) => ({
  id: FragnoId.fromExternal("user_123", 1),
  email: "user@example.com",
  role: "user",
  bannedAt: null,
  emailVerifiedAt: null,
  ...overrides,
});

describe("validateSessionCredentialOwner", () => {
  it("returns the canonical user summary for an eligible owner", () => {
    const owner = createOwner({ emailVerifiedAt: new Date("2026-07-22T12:00:00.000Z") });

    expect(validateSessionCredentialOwner(owner, {})).toEqual({
      ok: true,
      owner,
      user: {
        id: "user_123",
        email: "user@example.com",
        role: "user",
        bannedAt: null,
      },
    });
  });

  it("collapses account-policy failures into an invalid credential", () => {
    expect(validateSessionCredentialOwner(createOwner(), {})).toEqual({
      ok: false,
      code: "credential_invalid",
    });

    expect(
      validateSessionCredentialOwner(
        createOwner({ bannedAt: new Date("2026-07-22T12:00:00.000Z") }),
        undefined,
      ),
    ).toEqual({
      ok: false,
      code: "credential_invalid",
    });
  });
});
