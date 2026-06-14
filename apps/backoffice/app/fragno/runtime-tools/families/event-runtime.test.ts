import { describe, expect, it, vi } from "vitest";

import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";

import type { AutomationEvent } from "../../automation/contracts";
import { createEventRuntime } from "./event-runtime";

const createEvent = (overrides: Partial<AutomationEvent> = {}): AutomationEvent => ({
  id: "event-1",
  orgId: "org-1",
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
  it("normalizes array payloads to an empty object", async () => {
    const triggerIngestEvent = vi.fn(async () => undefined);
    const objects = {
      automations: { forOrg: vi.fn(() => ({ triggerIngestEvent })) },
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
      orgId: "org-1",
      source: "telegram",
    });

    expect(triggerIngestEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: {},
      }),
    );
  });

  it("preserves object payloads", async () => {
    const triggerIngestEvent = vi.fn(async () => undefined);
    const objects = {
      automations: { forOrg: vi.fn(() => ({ triggerIngestEvent })) },
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
