import { describe, expect, it } from "vitest";

import {
  assertBackofficeObjectAddressAllowed,
  type BackofficeObjectScope,
} from "./object-registry";

const scopedAddress = (
  binding: "OTP" | "AUTOMATIONS" | "UPLOAD",
  scope: BackofficeObjectScope,
) => ({
  binding,
  scope,
});

describe("Automations object scope policy", () => {
  it.each([
    { kind: "singleton" } as const,
    { kind: "org", orgId: "org-1" } as const,
    { kind: "user", userId: "user-1" } as const,
    { kind: "project", orgId: "org-1", projectId: "project-1" } as const,
  ])("allows $kind-scoped objects", (scope) => {
    expect(() =>
      assertBackofficeObjectAddressAllowed(scopedAddress("AUTOMATIONS", scope)),
    ).not.toThrow();
  });
});

describe("Upload object scope policy", () => {
  it("allows arbitrary named instances", () => {
    expect(() =>
      assertBackofficeObjectAddressAllowed(
        scopedAddress("UPLOAD", { kind: "named", name: "marketplace/telegram-test-command" }),
      ),
    ).not.toThrow();
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
