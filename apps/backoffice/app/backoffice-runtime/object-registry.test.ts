import { assert, describe, expect, it, vi } from "vitest";

import {
  createBackofficeObjectRegistry,
  encodeBackofficeObjectAddress,
  named,
  objectAddressToActor,
  org,
  project,
  singleton,
  user,
  type BackofficeObjectAddress,
  type BackofficeObjectFactory,
} from "./object-registry";

describe("encodeBackofficeObjectAddress", () => {
  it.each([
    ["singleton", { binding: "AUTH", scope: singleton() }, "v1:singleton"],
    ["org", { binding: "PI", scope: org("org_123") }, "v1:org:org_123"],
    ["named", { binding: "SANDBOX", scope: named("sandbox_abc") }, "v1:named:sandbox_abc"],
    ["user", { binding: "PI", scope: user({ userId: "user_456" }) }, "v1:user:user_456"],
    [
      "project",
      { binding: "PI", scope: project({ projectId: "project_789" }) },
      "v1:project:project_789",
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
    ["project id", () => project({ projectId: "" })],
  ])("rejects an empty %s", (_label, callback) => {
    expect(callback).toThrow(/Backoffice object address requires a non-empty/);
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
    expect(objects.auth.forProject({ projectId: "project_1" })).toEqual({
      binding: "AUTH",
      scope: { kind: "project", projectId: "project_1" },
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
    expect(objects.auth.for({ kind: "project", projectId: "project_1" })).toEqual({
      binding: "AUTH",
      scope: { kind: "project", projectId: "project_1" },
    });
  });
});
