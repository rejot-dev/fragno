import { describe, expect, it, vi } from "vitest";

import { InMemoryAdapter } from "@fragno-dev/db";

import { unavailableBackofficeAuthorityResolver } from "@/backoffice-runtime/authority-resolver";
import {
  createBackofficeServiceExecution,
  createBackofficeSystemExecution,
  createBackofficeUserExecution,
} from "@/backoffice-runtime/context";
import {
  BackofficeForbiddenError,
  BackofficeKernel,
  noopBackofficeKernelObserver,
} from "@/backoffice-runtime/kernel";
import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";
import { createAutomationFragment, type AutomationWorkflowsService } from "@/fragno/automation";

import type { AutomationEvent } from "../../automation/contracts";
import { createEventRuntime } from "./event-runtime";

const TEST_KERNEL_RUNTIME = {
  authorityResolver: unavailableBackofficeAuthorityResolver,
  kernelObserver: noopBackofficeKernelObserver,
};

const userExecution = (scope: AutomationEvent["scope"]) =>
  createBackofficeUserExecution({ scope, userId: "user-1" });

const automationExecution = (scope: AutomationEvent["scope"]) =>
  createBackofficeServiceExecution({
    scope,
    service: { type: "automation", id: "automation:event-1" },
  });

const createEvent = (overrides: Partial<AutomationEvent> = {}): AutomationEvent => ({
  id: "event-1",
  scope: { kind: "org", orgId: "org-1" },
  source: "telegram",
  eventType: "message.received",
  occurredAt: "2026-01-01T00:00:00.000Z",
  payload: {},
  actors: {
    initiator: {
      scope: "external",
      source: "telegram",
      type: "chat",
      id: "chat-1",
      role: "initiator",
    },
    principal: null,
    delegation: [],
  },
  subject: null,
  ...overrides,
});

const createAutomationFragmentForEventRuntimeTest = (idSeed: string) =>
  createAutomationFragment(
    {
      builtInEventDefinitions: [],
      ownerScope: { kind: "org", orgId: "org-1" },
    },
    {
      databaseAdapter: new InMemoryAdapter({ idSeed }),
      dbRoundtripGuard: true,
      mountRoute: "/api/automations",
      outbox: { enabled: true },
    },
    {
      workflows: {
        createInstance: async () => ({}),
        getInstanceStatus: async () => [],
        sendEvent: async () => ({}),
      } as unknown as AutomationWorkflowsService,
    },
  );

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
      kernel: new BackofficeKernel(TEST_KERNEL_RUNTIME),
      execution: createBackofficeUserExecution({
        scope: { kind: "org", orgId: "org-1" },
        userId: "user-1",
      }),
    });

    await expect(
      runtime.emitEvent({ eventType: "custom.event", source: "backoffice", payload: { ok: true } }),
    ).resolves.toMatchObject({
      accepted: true,
      scope: { kind: "org", orgId: "org-1" },
      source: "backoffice",
      eventType: "custom.event",
    });

    expect(triggerIngestEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
        ),
        actors: {
          initiator: {
            scope: "internal",
            type: "backoffice",
            id: "interactive",
            role: "initiator",
          },
          principal: {
            scope: "internal",
            type: "user",
            id: "user-1",
            role: "principal",
          },
          delegation: [],
        },
        payload: { ok: true },
      }),
    );
  });

  it("attributes emitted events separately from the privileged execution authority", async () => {
    const triggerIngestEvent = vi.fn(async () => undefined);
    const objects = {
      automations: {
        forOrg: vi.fn(() => ({ triggerIngestEvent })),
      },
    } as unknown as BackofficeObjectRegistry;
    const attributedActors = createBackofficeUserExecution({
      scope: { kind: "org", orgId: "org-1" },
      userId: "marketplace-installer",
    }).actors;
    const runtime = createEventRuntime({
      objects,
      kernel: new BackofficeKernel(TEST_KERNEL_RUNTIME),
      execution: createBackofficeSystemExecution({ kind: "org", orgId: "org-1" }),
      emittedEventActors: attributedActors,
    });

    await runtime.emitEvent({ eventType: "installation.event", source: "marketplace" });

    expect(triggerIngestEvent).toHaveBeenCalledWith(
      expect.objectContaining({ actors: attributedActors }),
    );
  });

  it("requires source without a parent automation event", async () => {
    const objects = {
      automations: {
        forOrg: vi.fn(() => ({ triggerIngestEvent: vi.fn(async () => undefined) })),
      },
    } as unknown as BackofficeObjectRegistry;
    const runtime = createEventRuntime({
      objects,
      kernel: new BackofficeKernel(TEST_KERNEL_RUNTIME),
      execution: userExecution({ kind: "org", orgId: "org-1" }),
    });

    await expect(runtime.emitEvent({ eventType: "custom.event" })).rejects.toThrow(
      "events.fire source is required without a parent automation event.",
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
    const event = createEvent();
    const runtime = createEventRuntime({
      objects,
      kernel: new BackofficeKernel(TEST_KERNEL_RUNTIME),
      execution: automationExecution(event.scope),
      parentEvent: event,
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

  it("preserves initiator, principal, and ordered delegation on child events", async () => {
    const triggerIngestEvent = vi.fn(async () => undefined);
    const objects = {
      automations: {
        forOrg: vi.fn(() => ({ triggerIngestEvent })),
      },
    } as unknown as BackofficeObjectRegistry;
    const parentEvent = createEvent({
      actors: {
        initiator: {
          scope: "external",
          source: "telegram",
          type: "chat",
          id: "chat-1",
          role: "initiator",
        },
        principal: {
          scope: "internal",
          type: "user",
          id: "user-1",
          role: "principal",
        },
        delegation: [
          {
            scope: "internal",
            type: "automation",
            id: "automation:event-1",
            role: "delegate",
          },
          {
            scope: "internal",
            type: "agent",
            id: "agent-1",
            role: "assistant",
          },
        ],
      },
    });
    const runtime = createEventRuntime({
      objects,
      kernel: new BackofficeKernel(TEST_KERNEL_RUNTIME),
      execution: { scope: parentEvent.scope, actors: parentEvent.actors },
      parentEvent,
    });

    await runtime.emitEvent({ eventType: "child.created", payload: { ok: true } });

    expect(triggerIngestEvent).toHaveBeenCalledWith(
      expect.objectContaining({ actors: parentEvent.actors, payload: { ok: true } }),
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
    const kernel = new BackofficeKernel(TEST_KERNEL_RUNTIME);
    const runtime = createEventRuntime({
      objects,
      kernel,
      execution: automationExecution({ kind: "org", orgId: "org-1" }),
      parentEvent: createEvent({ scope: { kind: "org", orgId: "org-1" } }),
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
      kernel: new BackofficeKernel(TEST_KERNEL_RUNTIME),
      execution: automationExecution({ kind: "org", orgId: "org-1" }),
      parentEvent: createEvent({ scope: { kind: "org", orgId: "org-1" } }),
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
      kernel: new BackofficeKernel(TEST_KERNEL_RUNTIME),
      execution: automationExecution({ kind: "org", orgId: "org-1" }),
      parentEvent: createEvent({ scope: { kind: "org", orgId: "org-1" } }),
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
      kernel: new BackofficeKernel(TEST_KERNEL_RUNTIME),
      execution: automationExecution({ kind: "org", orgId: "org-1" }),
      parentEvent: createEvent({ scope: { kind: "org", orgId: "org-1" } }),
    });

    await expect(
      runtime.emitEvent({
        eventType: "custom.event",
        targetScope: { kind: "org", orgId: "org-2" },
      }),
    ).rejects.toBeInstanceOf(BackofficeForbiddenError);

    expect(triggerOrgIngestEvent).not.toHaveBeenCalled();
  });

  it("validates emitted payloads against dynamic automation event definitions", async () => {
    const fragment = createAutomationFragmentForEventRuntimeTest(
      "event-runtime-dynamic-definition-test",
    );
    await fragment.callServices(() =>
      fragment.services.createEventDefinition({
        source: "custom",
        eventType: "thing.created",
        label: "Thing created",
        payloadSchema: {
          type: "object",
          required: ["thingId"],
          properties: {
            thingId: { type: "string" },
          },
          additionalProperties: false,
        },
      }),
    );

    const triggerIngestEvent = vi.fn(async (event: AutomationEvent) =>
      fragment.callServices(() => fragment.services.ingestEvent(event)),
    );
    const objects = {
      automations: {
        forOrg: vi.fn(() => ({ triggerIngestEvent })),
      },
    } as unknown as BackofficeObjectRegistry;
    const runtime = createEventRuntime({
      objects,
      kernel: new BackofficeKernel(TEST_KERNEL_RUNTIME),
      execution: userExecution({ kind: "org", orgId: "org-1" }),
    });

    await expect(
      runtime.emitEvent({
        source: "custom",
        eventType: "thing.created",
        payload: { thingId: "thing-1" },
      }),
    ).resolves.toMatchObject({ accepted: true, source: "custom", eventType: "thing.created" });

    await expect(
      runtime.emitEvent({
        source: "custom",
        eventType: "thing.created",
        payload: { thingId: 123 },
      }),
    ).rejects.toThrow("payload failed schema validation");

    const events = await fragment.callServices(() => fragment.services.listEvents({ limit: 10 }));
    expect(events.events).toHaveLength(1);
    expect(events.events[0]).toMatchObject({
      source: "custom",
      eventType: "thing.created",
      payload: { thingId: "thing-1" },
    });
  });

  it("preserves object payloads", async () => {
    const triggerIngestEvent = vi.fn(async () => undefined);
    const objects = {
      automations: {
        for: vi.fn(() => ({ triggerIngestEvent })),
        forOrg: vi.fn(() => ({ triggerIngestEvent })),
      },
    } as unknown as BackofficeObjectRegistry;
    const event = createEvent();
    const runtime = createEventRuntime({
      objects,
      kernel: new BackofficeKernel(TEST_KERNEL_RUNTIME),
      execution: automationExecution(event.scope),
      parentEvent: event,
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
