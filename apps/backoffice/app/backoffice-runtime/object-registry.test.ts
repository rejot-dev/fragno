import { describe, expect, it } from "vitest";

import {
  assertBackofficeObjectAddressAllowed,
  type BackofficeObjectScope,
} from "./object-registry";

const scopedAddress = (binding: "OTP" | "PI", scope: BackofficeObjectScope) => ({
  binding,
  scope,
});

describe("PI object scope policy", () => {
  it("allows organisation-scoped objects", () => {
    expect(() =>
      assertBackofficeObjectAddressAllowed(scopedAddress("PI", { kind: "org", orgId: "org-1" })),
    ).not.toThrow();
  });

  it.each([
    { kind: "singleton" } as const,
    { kind: "user", userId: "user-1" } as const,
    { kind: "project", orgId: "org-1", projectId: "project-1" } as const,
  ])("rejects $kind-scoped objects", (scope) => {
    expect(() => assertBackofficeObjectAddressAllowed(scopedAddress("PI", scope))).toThrow(
      `PI cannot be instantiated with ${scope.kind} scope`,
    );
  });
});

describe("OTP object scope policy", () => {
  it.each([{ kind: "singleton" } as const, { kind: "org", orgId: "org-1" } as const])(
    "allows $kind-scoped objects",
    (scope) => {
      expect(() => assertBackofficeObjectAddressAllowed(scopedAddress("OTP", scope))).not.toThrow();
    },
  );
});
