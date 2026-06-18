import { describe, expect, it } from "vitest";

import type { AutomationEvent } from "@/fragno/automation";

import {
  resolveEventOrgId,
  resolveOrgScopedObjectAddress,
  resolveProjectScopedObjectAddress,
  resolveSingletonObjectAddress,
  resolveUserScopedObjectAddress,
} from "./object-routing-policy";

const event = (input: Partial<AutomationEvent> = {}): AutomationEvent => ({
  id: "event-1",
  scope: { kind: "org", orgId: "org-1" },
  source: "test",
  eventType: "test.event",
  occurredAt: "2026-01-01T00:00:00.000Z",
  payload: {},
  actor: {
    scope: "internal",
    type: "user",
    id: "actor-1",
  },
  actors: [],
  ...input,
});

describe("object routing policy", () => {
  it("routes org-scoped objects from event subject org id", () => {
    expect(
      resolveOrgScopedObjectAddress(
        "AUTOMATIONS",
        event({ scope: { kind: "org", orgId: "org-1" }, subject: { orgId: "org-1" } }),
      ),
    ).toEqual({
      binding: "AUTOMATIONS",
      scope: { kind: "org", orgId: "org-1" },
    });
  });

  it("routes user-scoped objects from event subjects without org qualification", () => {
    expect(resolveUserScopedObjectAddress("PI", event({ subject: { userId: "user-1" } }))).toEqual({
      binding: "PI",
      scope: { kind: "user", userId: "user-1" },
    });
  });

  it("routes project-scoped objects from org-qualified event subjects", () => {
    expect(
      resolveProjectScopedObjectAddress(
        "PI",
        event({ subject: { orgId: "org-1", projectId: "project-1" } }),
      ),
    ).toEqual({
      binding: "PI",
      scope: { kind: "project", projectId: "project-1" },
    });
  });

  it("routes singleton admin objects explicitly", () => {
    expect(resolveSingletonObjectAddress("AUTH")).toEqual({
      binding: "AUTH",
      scope: { kind: "singleton" },
    });
  });

  it("rejects conflicting top-level and subject org ids", () => {
    expect(() =>
      resolveEventOrgId(
        event({ scope: { kind: "org", orgId: "org-1" }, subject: { orgId: "org-2" } }),
      ),
    ).toThrow("does not match subject org id");
  });

  it("rejects actor-only events when user routing has no subject user id", () => {
    expect(() => resolveUserScopedObjectAddress("PI", event())).toThrow("missing subject user id");
  });

  it("rejects actor-only events when no org id exists", () => {
    expect(() =>
      resolveOrgScopedObjectAddress(
        "AUTOMATIONS",
        event({ scope: { kind: "user", userId: "user-1" } }),
      ),
    ).toThrow("expected org scope");
  });
});
