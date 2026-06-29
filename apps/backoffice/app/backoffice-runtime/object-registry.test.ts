import { assert, describe, expect, it, vi } from "vitest";

import {
  assertBackofficeObjectAddressAllowed,
  backofficeObjectScopePolicy,
  createBackofficeObjectRegistry,
  encodeBackofficeObjectAddress,
  named,
  objectAddressToActor,
  org,
  project,
  singleton,
  user,
  type BackofficeObjectAddress,
  type BackofficeObjectBindingName,
  type BackofficeObjectFactory,
  type BackofficeObjectScopeKind,
} from "./object-registry";

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
      return { binding, scope: { kind: "project", orgId: "org-1", projectId: "project-1" } };
  }
};

describe("encodeBackofficeObjectAddress", () => {
  it.each([
    ["singleton", { binding: "AUTH", scope: singleton() }, "v1:singleton"],
    ["org", { binding: "PI", scope: org("org_123") }, "v1:org:org_123"],
    ["named", { binding: "SANDBOX", scope: named("sandbox_abc") }, "v1:named:sandbox_abc"],
    ["user", { binding: "PI", scope: user({ userId: "user_456" }) }, "v1:user:user_456"],
    [
      "project",
      { binding: "PI", scope: project({ orgId: "org_123", projectId: "project_789" }) },
      "v1:project:org_123:project_789",
    ],
  ] satisfies Array<[string, BackofficeObjectAddress, string]>)(
    "encodes %s scope with stable v1 names",
    (_label, address, expected) => {
      expect(encodeBackofficeObjectAddress(address)).toBe(expected);
    },
  );

  it("escapes separator characters in ids", () => {
    assert(
      encodeBackofficeObjectAddress({
        binding: "PI",
        scope: user({ userId: "user%id/with:separator" }),
      }) === "v1:user:user%25id%2Fwith%3Aseparator",
    );
  });

  it("converts addresses to internal object actors", () => {
    expect(
      objectAddressToActor({
        binding: "PI",
        scope: user({ userId: "user_456" }),
      }),
    ).toEqual({
      scope: "internal",
      type: "object",
      id: "PI/v1:user:user_456",
      role: "delegate",
    });
  });

  it.each([
    ["org id", () => org("")],
    ["name", () => named(" ")],
    ["user id", () => user({ userId: "" })],
    ["project org id", () => project({ orgId: "", projectId: "project_1" })],
    ["project id", () => project({ orgId: "org_1", projectId: "" })],
  ])("rejects an empty %s", (_label, callback) => {
    expect(callback).toThrow(/Backoffice object address requires a non-empty/);
  });
});

describe("backoffice object scope policy", () => {
  it("defines the allowed scope matrix", () => {
    expect(backofficeObjectScopePolicy).toEqual({
      API: ["org", "user", "project"],
      AUTH: ["singleton"],
      AUTOMATIONS: ["singleton", "org", "user", "project"],
      TELEGRAM: ["singleton", "org", "user"],
      OTP: ["org"],
      RESEND: ["org"],
      RESON8: ["org"],
      MCP: ["org", "user", "project"],
      UPLOAD: ["org", "user", "project"],
      GITHUB: ["org"],
      CLOUDFLARE_WORKERS: ["org"],
      PI: ["org"],
      GITHUB_WEBHOOK_ROUTER: ["singleton"],
      SANDBOX: ["named"],
    });
  });

  it("allows configured binding and scope pairs", () => {
    assertBackofficeObjectAddressAllowed(address("API", "project"));
    assertBackofficeObjectAddressAllowed(address("API", "user"));
    assertBackofficeObjectAddressAllowed(address("UPLOAD", "project"));
    assertBackofficeObjectAddressAllowed(address("MCP", "user"));
    assertBackofficeObjectAddressAllowed(address("MCP", "project"));
    assertBackofficeObjectAddressAllowed(address("TELEGRAM", "singleton"));
    assertBackofficeObjectAddressAllowed(address("TELEGRAM", "user"));
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

describe("createBackofficeObjectRegistry", () => {
  it("exposes all supported scope helpers for every binding", () => {
    const get = vi.fn((_binding, address) => address);
    const objects = createBackofficeObjectRegistry({ get } as BackofficeObjectFactory);

    expect(objects.auth.singleton()).toEqual({
      binding: "AUTH",
      scope: { kind: "singleton" },
    });
    expect(objects.auth.forOrg("org_1")).toEqual({
      binding: "AUTH",
      scope: { kind: "org", orgId: "org_1" },
    });
    expect(objects.auth.forName("custom")).toEqual({
      binding: "AUTH",
      scope: { kind: "named", name: "custom" },
    });
    expect(objects.auth.forUser({ userId: "user_1" })).toEqual({
      binding: "AUTH",
      scope: { kind: "user", userId: "user_1" },
    });
    expect(objects.auth.forProject({ orgId: "org_1", projectId: "project_1" })).toEqual({
      binding: "AUTH",
      scope: { kind: "project", orgId: "org_1", projectId: "project_1" },
    });
    expect(objects.auth.for({ kind: "system" })).toEqual({
      binding: "AUTH",
      scope: { kind: "singleton" },
    });
    expect(objects.auth.for({ kind: "org", orgId: "org_1" })).toEqual({
      binding: "AUTH",
      scope: { kind: "org", orgId: "org_1" },
    });
    expect(objects.auth.for({ kind: "user", userId: "user_1" })).toEqual({
      binding: "AUTH",
      scope: { kind: "user", userId: "user_1" },
    });
    expect(objects.auth.for({ kind: "project", orgId: "org_1", projectId: "project_1" })).toEqual({
      binding: "AUTH",
      scope: { kind: "project", orgId: "org_1", projectId: "project_1" },
    });
  });
});
