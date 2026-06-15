import { describe, expect, it } from "vitest";

import type { BackofficeObjectAddress, BackofficeObjectBindingName } from "./object-registry";
import {
  assertBackofficeObjectAddressAllowed,
  backofficeObjectScopePolicy,
  type BackofficeObjectScopeKind,
} from "./object-scope-policy";

const address = (
  binding: BackofficeObjectBindingName,
  scopeKind: BackofficeObjectScopeKind,
): BackofficeObjectAddress => {
  switch (scopeKind) {
    case "singleton":
      return { binding, scope: { kind: "singleton" } };
    case "org":
      return { binding, scope: { kind: "org", orgId: "org-1" } };
    case "named":
      return { binding, scope: { kind: "named", name: "name-1" } };
    case "user":
      return { binding, scope: { kind: "user", userId: "user-1" } };
    case "project":
      return { binding, scope: { kind: "project", projectId: "project-1" } };
  }
};

describe("backoffice object scope policy", () => {
  it("defines the allowed scope matrix", () => {
    expect(backofficeObjectScopePolicy).toEqual({
      AUTH: ["singleton"],
      AUTOMATIONS: ["singleton", "org", "user", "project"],
      TELEGRAM: ["org"],
      OTP: ["org"],
      RESEND: ["org"],
      RESON8: ["org"],
      MCP: ["org", "user"],
      UPLOAD: ["org", "user", "project"],
      GITHUB: ["org"],
      CLOUDFLARE_WORKERS: ["org"],
      PI: ["org"],
      GITHUB_WEBHOOK_ROUTER: ["singleton"],
      SANDBOX_REGISTRY: ["org"],
      SANDBOX: ["named"],
    });
  });

  it("allows configured binding and scope pairs", () => {
    assertBackofficeObjectAddressAllowed(address("UPLOAD", "project"));
    assertBackofficeObjectAddressAllowed(address("MCP", "user"));
    assertBackofficeObjectAddressAllowed(address("PI", "org"));
  });

  it("rejects disallowed binding and scope pairs", () => {
    expect(() => assertBackofficeObjectAddressAllowed(address("PI", "user"))).toThrow(
      "PI cannot be instantiated with user scope",
    );
    expect(() => assertBackofficeObjectAddressAllowed(address("AUTH", "org"))).toThrow(
      "AUTH cannot be instantiated with org scope",
    );
  });
});
