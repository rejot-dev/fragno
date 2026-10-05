import { assert, describe, expect, it, vi } from "vitest";

import {
  assertBackofficeObjectAddressAllowed,
  createBackofficeObjectRegistry,
  isBackofficeObjectAvailableInContext,
  type AutomationsObject,
  type BackofficeObjectFactory,
  type BackofficeObjectScope,
} from "./object-registry";

const scopedAddress = (
  binding: "OTP" | "AUTOMATIONS" | "PROJECT_CONNECTOR" | "UPLOAD",
  scope: BackofficeObjectScope,
) => ({
  binding,
  scope,
});

describe("Backoffice object context availability", () => {
  it("maps system context to singleton objects", () => {
    assert(isBackofficeObjectAvailableInContext("RESEND", { kind: "system" }));
  });

  it("rejects object bindings that do not support the selected context", () => {
    assert(!isBackofficeObjectAvailableInContext("RESEND", { kind: "user", userId: "user-1" }));
    assert(
      !isBackofficeObjectAvailableInContext("RESEND", {
        kind: "project",
        orgId: "org-1",
        projectId: "project-1",
      }),
    );
  });
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
    const seedStarterAutomationRoutes = vi.fn(async () => ({ created: [], existing: [] }));
    const commands = { seedStarterAutomationRoutes } as unknown as AutomationsObject;
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

    await expect(automations.commands.seedStarterAutomationRoutes()).resolves.toEqual({
      created: [],
      existing: [],
    });
    await automations.http.fetch(new Request("https://automations.test/api/automations/outbox"));

    expect(get).toHaveBeenCalledWith(
      { name: "AUTOMATIONS" },
      { binding: "AUTOMATIONS", scope: { kind: "org", orgId: "org-1" } },
    );
    expect(fetch).toHaveBeenCalledOnce();
  });
});

describe("Connector object scope policy", () => {
  it("allows user ownership and rejects organization or project ownership", () => {
    expect(() =>
      assertBackofficeObjectAddressAllowed(
        scopedAddress("PROJECT_CONNECTOR", { kind: "user", userId: "user-1" }),
      ),
    ).not.toThrow();
    expect(() =>
      assertBackofficeObjectAddressAllowed(
        scopedAddress("PROJECT_CONNECTOR", { kind: "org", orgId: "org-1" }),
      ),
    ).toThrow("cannot be instantiated with org scope");
    expect(() =>
      assertBackofficeObjectAddressAllowed(
        scopedAddress("PROJECT_CONNECTOR", {
          kind: "project",
          orgId: "org-1",
          projectId: "project-1",
        }),
      ),
    ).toThrow("cannot be instantiated with project scope");
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
