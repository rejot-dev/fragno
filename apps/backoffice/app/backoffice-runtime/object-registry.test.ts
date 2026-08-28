import { describe, expect, it, vi } from "vitest";

import {
  assertBackofficeObjectAddressAllowed,
  createBackofficeObjectRegistry,
  type AutomationsObject,
  type BackofficeObjectFactory,
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

  it("returns separate command and HTTP capabilities for the addressed object", async () => {
    const getPiRuntimeState = vi.fn(async () => ({ configured: true, modelCatalog: [] }));
    const commands = { getPiRuntimeState } as unknown as AutomationsObject;
    const fetch = vi.fn(async () => new Response());
    const handle = {
      commands,
      http: {
        fetch,
        fetchAuthorized: vi.fn(async () => new Response()),
      },
    };
    const get = vi.fn(() => handle) as unknown as BackofficeObjectFactory["get"];
    const automations = createBackofficeObjectRegistry({ get }).automations.forOrg("org-1");

    await expect(automations.commands.getPiRuntimeState()).resolves.toEqual({
      configured: true,
      modelCatalog: [],
    });
    await automations.http.fetch(new Request("https://automations.test/api/automations/outbox"));

    expect(get).toHaveBeenCalledWith(
      { name: "AUTOMATIONS" },
      { binding: "AUTOMATIONS", scope: { kind: "org", orgId: "org-1" } },
    );
    expect(fetch).toHaveBeenCalledOnce();
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
