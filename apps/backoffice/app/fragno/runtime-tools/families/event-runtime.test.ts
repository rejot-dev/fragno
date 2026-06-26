import { describe, expect, it, vi } from "vitest";

import { BackofficeForbiddenError, BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";

import type { AutomationEvent } from "../../automation/contracts";
import { createEventRuntime } from "./event-runtime";

const createEvent = (overrides: Partial<AutomationEvent> = {}): AutomationEvent => ({
  id: "event-1",
  scope: { kind: "org", orgId: "org-1" },
  source: "telegram",
  eventType: "message.received",
  occurredAt: "2026-01-01T00:00:00.000Z",
  payload: {},
  actor: {
    scope: "external",
    source: "telegram",
    type: "chat",
    id: "chat-1",
  },
  actors: [{ scope: "external", source: "telegram", type: "chat", id: "chat-1" }],
  subject: null,
  ...overrides,
});

describe("createEventRuntime.emitEvent", () => {
  it("emits from an interactive Backoffice context without a base automation event", async () => {
    const triggerIngestEvent = vi.fn(async () => undefined);
    const objects = {
      automations: {
        forOrg: vi.fn(() => ({ triggerIngestEvent })),
      },
    } as unknown as BackofficeObjectRegistry;
    const runtime = createEventRuntime({
      objects,
      kernel: new BackofficeKernel({ objects }),
      execution: {
        actor: {
          type: "user",
          id: "user-1",
          userId: "user-1",
          organizationIds: ["org-1"],
        },
        scope: { kind: "org", orgId: "org-1" },
      },
    });

    await expect(
      runtime.emitEvent({ eventType: "custom.event", payload: { ok: true } }),
    ).resolves.toMatchObject({
      accepted: true,
      scope: { kind: "org", orgId: "org-1" },
      source: "backoffice",
      eventType: "custom.event",
    });

    expect(triggerIngestEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.stringMatching(/^backoffice:custom\.event:/u),
        actor: {
          scope: "internal",
          type: "user",
          id: "user-1",
          role: "principal",
        },
        actors: [
          {
            scope: "internal",
            type: "user",
            id: "user-1",
            role: "principal",
          },
        ],
        payload: { ok: true },
      }),
    );
  });

  it("normalizes array payloads to an empty object", async () => {
    const triggerIngestEvent = vi.fn(async () => undefined);
    const objects = {
      automations: {
        for: vi.fn(() => ({ triggerIngestEvent })),
        forOrg: vi.fn(() => ({ triggerIngestEvent })),
      },
    } as unknown as BackofficeObjectRegistry;
    const runtime = createEventRuntime({
      objects,
      event: createEvent(),
    });

    await expect(
      runtime.emitEvent({ eventType: "custom.event", payload: ["not", "allowed"] as never }),
    ).resolves.toEqual({
      accepted: true,
      eventId: expect.any(String),
      eventType: "custom.event",
      scope: { kind: "org", orgId: "org-1" },
      source: "telegram",
    });

    expect(triggerIngestEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: {},
      }),
    );
  });

  it("routes scoped events to an explicit target scope when authorized", async () => {
    const triggerOrgIngestEvent = vi.fn(async () => undefined);
    const triggerUserIngestEvent = vi.fn(async () => undefined);
    const objects = {
      automations: {
        forOrg: vi.fn(() => ({ triggerIngestEvent: triggerOrgIngestEvent })),
        forUser: vi.fn(() => ({ triggerIngestEvent: triggerUserIngestEvent })),
      },
    } as unknown as BackofficeObjectRegistry;
    const kernel = new BackofficeKernel({
      objects,
      authorizationPolicy: (request) => {
        expect(request.scope).toEqual({ kind: "user", userId: "user-1" });
        expect(request.requiredPermissions).toEqual([{ namespace: "event", permission: "route" }]);
        expect(request.resource).toEqual({
          sourceScope: { kind: "org", orgId: "org-1" },
          targetScope: { kind: "user", userId: "user-1" },
        });
        return { allowed: true };
      },
    });
    const runtime = createEventRuntime({
      objects,
      kernel,
      execution: {
        actor: { type: "automation", id: "automation:event-1", organizationIds: ["org-1"] },
        scope: { kind: "org", orgId: "org-1" },
      },
      event: createEvent({ scope: { kind: "org", orgId: "org-1" } }),
    });

    await expect(
      runtime.emitEvent({
        eventType: "custom.event",
        targetScope: { kind: "user", userId: "user-1" },
      }),
    ).resolves.toMatchObject({
      accepted: true,
      scope: { kind: "user", userId: "user-1" },
    });

    expect(triggerOrgIngestEvent).not.toHaveBeenCalled();
    expect(triggerUserIngestEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { kind: "user", userId: "user-1" },
      }),
    );
  });

  it("resolves project targets through the owning org before enqueueing", async () => {
    const triggerProjectIngestEvent = vi.fn(async () => undefined);
    const resolveProjectForExecution = vi.fn(async () => ({
      projectId: "project-1",
      slug: "launch",
      name: "Launch",
    }));
    const objects = {
      automations: {
        forOrg: vi.fn(() => ({ resolveProjectForExecution })),
        forProject: vi.fn(() => ({ triggerIngestEvent: triggerProjectIngestEvent })),
      },
    } as unknown as BackofficeObjectRegistry;
    const runtime = createEventRuntime({
      objects,
      kernel: new BackofficeKernel({ objects }),
      execution: {
        actor: { type: "automation", id: "automation:event-1", organizationIds: ["org-1"] },
        scope: { kind: "org", orgId: "org-1" },
      },
      event: createEvent({ scope: { kind: "org", orgId: "org-1" } }),
    });

    await expect(
      runtime.emitEvent({
        eventType: "project.event",
        targetScope: { kind: "project", orgId: "org-1", projectId: "project-1" },
      }),
    ).resolves.toMatchObject({
      accepted: true,
      scope: { kind: "project", orgId: "org-1", projectId: "project-1" },
    });

    expect(resolveProjectForExecution).toHaveBeenCalledWith({ projectId: "project-1" });
    expect(triggerProjectIngestEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { kind: "project", orgId: "org-1", projectId: "project-1" },
        subject: expect.objectContaining({ orgId: "org-1", projectId: "project-1" }),
      }),
    );
  });

  it("does not enqueue events for unavailable projects", async () => {
    const triggerProjectIngestEvent = vi.fn(async () => undefined);
    const objects = {
      automations: {
        forOrg: vi.fn(() => ({ resolveProjectForExecution: vi.fn(async () => null) })),
        forProject: vi.fn(() => ({ triggerIngestEvent: triggerProjectIngestEvent })),
      },
    } as unknown as BackofficeObjectRegistry;
    const runtime = createEventRuntime({
      objects,
      kernel: new BackofficeKernel({ objects }),
      execution: {
        actor: { type: "automation", id: "automation:event-1", organizationIds: ["org-1"] },
        scope: { kind: "org", orgId: "org-1" },
      },
      event: createEvent({ scope: { kind: "org", orgId: "org-1" } }),
    });

    await expect(
      runtime.emitEvent({
        eventType: "project.event",
        targetScope: { kind: "project", orgId: "org-1", projectId: "missing" },
      }),
    ).rejects.toThrow("Project 'missing' is not available.");

    expect(triggerProjectIngestEvent).not.toHaveBeenCalled();
  });

  it("does not enqueue events when the actor cannot access the target org", async () => {
    const triggerOrgIngestEvent = vi.fn(async () => undefined);
    const objects = {
      automations: {
        forOrg: vi.fn(() => ({ triggerIngestEvent: triggerOrgIngestEvent })),
      },
    } as unknown as BackofficeObjectRegistry;
    const runtime = createEventRuntime({
      objects,
      kernel: new BackofficeKernel({ objects }),
      execution: {
        actor: { type: "automation", id: "automation:event-1", organizationIds: ["org-1"] },
        scope: { kind: "org", orgId: "org-1" },
      },
      event: createEvent({ scope: { kind: "org", orgId: "org-1" } }),
    });

    await expect(
      runtime.emitEvent({
        eventType: "custom.event",
        targetScope: { kind: "org", orgId: "org-2" },
      }),
    ).rejects.toBeInstanceOf(BackofficeForbiddenError);

    expect(triggerOrgIngestEvent).not.toHaveBeenCalled();
  });

  it("does not enqueue denied cross-scope events", async () => {
    const triggerUserIngestEvent = vi.fn(async () => undefined);
    const objects = {
      automations: {
        forUser: vi.fn(() => ({ triggerIngestEvent: triggerUserIngestEvent })),
      },
    } as unknown as BackofficeObjectRegistry;
    const runtime = createEventRuntime({
      objects,
      kernel: new BackofficeKernel({
        objects,
        authorizationPolicy: () => ({ allowed: false, message: "route denied" }),
      }),
      execution: {
        actor: { type: "automation", id: "automation:event-1", organizationIds: ["org-1"] },
        scope: { kind: "org", orgId: "org-1" },
      },
      event: createEvent({ scope: { kind: "org", orgId: "org-1" } }),
    });

    await expect(
      runtime.emitEvent({
        eventType: "custom.event",
        targetScope: { kind: "user", userId: "user-1" },
      }),
    ).rejects.toBeInstanceOf(BackofficeForbiddenError);

    expect(triggerUserIngestEvent).not.toHaveBeenCalled();
  });

  it("preserves object payloads", async () => {
    const triggerIngestEvent = vi.fn(async () => undefined);
    const objects = {
      automations: {
        for: vi.fn(() => ({ triggerIngestEvent })),
        forOrg: vi.fn(() => ({ triggerIngestEvent })),
      },
    } as unknown as BackofficeObjectRegistry;
    const runtime = createEventRuntime({
      objects,
      event: createEvent(),
    });

    await runtime.emitEvent({
      eventType: "custom.event",
      payload: { nested: true, count: 2 },
    });

    expect(triggerIngestEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: { nested: true, count: 2 },
      }),
    );
  });
});
