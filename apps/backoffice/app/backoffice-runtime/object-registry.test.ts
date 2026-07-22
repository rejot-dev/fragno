import { describe, expect, it } from "vitest";

import {
  assertBackofficeObjectAddressAllowed,
  type BackofficeObjectScope,
} from "./object-registry";

const piAddress = (scope: BackofficeObjectScope) => ({
  binding: "PI" as const,
  scope,
});

describe("PI object scope policy", () => {
  it("allows organisation-scoped objects", () => {
    expect(() =>
      assertBackofficeObjectAddressAllowed(piAddress({ kind: "org", orgId: "org-1" })),
    ).not.toThrow();
  });

  it.each([
    { kind: "singleton" } as const,
    { kind: "user", userId: "user-1" } as const,
    { kind: "project", orgId: "org-1", projectId: "project-1" } as const,
  ])("rejects $kind-scoped objects", (scope) => {
    expect(() => assertBackofficeObjectAddressAllowed(piAddress(scope))).toThrow(
      `PI cannot be instantiated with ${scope.kind} scope`,
    );
  });
});
