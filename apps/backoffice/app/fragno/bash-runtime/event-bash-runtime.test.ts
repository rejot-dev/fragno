import { describe, expect, it, vi } from "vitest";

import { z } from "zod";

import type { AutomationEvent, AutomationSourceAdapterRegistry } from "../automation/contracts";
import { createEventBashRuntime } from "./event-bash-runtime";

const createTelegramAdapter = (
  reply?: AutomationSourceAdapterRegistry["telegram"]["reply"],
): AutomationSourceAdapterRegistry["telegram"] => ({
  source: "telegram",
  eventSchemas: {
    "message.received": z.object({}),
  },
  toBashEnv: () => ({}),
  reply,
});

const createOtpAdapter = (
  reply?: AutomationSourceAdapterRegistry["otp"]["reply"],
): AutomationSourceAdapterRegistry["otp"] => ({
  source: "otp",
  eventSchemas: {
    "identity.claim.completed": z.object({}),
  },
  toBashEnv: () => ({}),
  reply,
});

const createEvent = (overrides: Partial<AutomationEvent> = {}): AutomationEvent => ({
  id: "event-1",
  orgId: "org-1",
  source: "telegram",
  eventType: "message.received",
  occurredAt: "2026-01-01T00:00:00.000Z",
  payload: {},
  actor: {
    type: "external",
    externalId: "chat-1",
  },
  subject: null,
  ...overrides,
});

describe("createEventBashRuntime.reply", () => {
  it("reuses the event actor id when replying through the same source", async () => {
    const reply = vi.fn(async () => undefined);
    const sourceAdapters = {
      telegram: createTelegramAdapter(reply),
    } satisfies Partial<AutomationSourceAdapterRegistry>;
    const event = createEvent();
    const runtime = createEventBashRuntime({
      event,
      sourceAdapters,
      sourceAdapter: sourceAdapters.telegram,
    });

    await expect(runtime.reply({ text: "hello" })).resolves.toEqual({ ok: true });

    expect(reply).toHaveBeenCalledWith({
      event,
      externalActorId: "chat-1",
      text: "hello",
    });
  });

  it("requires an explicit external actor id when replying through a different source", async () => {
    const otpReply = vi.fn(async () => undefined);
    const sourceAdapters = {
      telegram: createTelegramAdapter(),
      otp: createOtpAdapter(otpReply),
    } satisfies Partial<AutomationSourceAdapterRegistry>;
    const event = createEvent();
    const runtime = createEventBashRuntime({
      event,
      sourceAdapters,
      sourceAdapter: sourceAdapters.telegram,
    });

    await expect(runtime.reply({ source: "otp", text: "hello" })).rejects.toThrow(
      "event.reply requires --external-actor-id when replying through source 'otp' because the current event source is 'telegram'",
    );
    expect(otpReply).not.toHaveBeenCalled();
  });

  it("uses an explicit external actor id when replying through a different source", async () => {
    const otpReply = vi.fn(async () => undefined);
    const sourceAdapters = {
      telegram: createTelegramAdapter(),
      otp: createOtpAdapter(otpReply),
    } satisfies Partial<AutomationSourceAdapterRegistry>;
    const event = createEvent();
    const runtime = createEventBashRuntime({
      event,
      sourceAdapters,
      sourceAdapter: sourceAdapters.telegram,
    });

    await expect(
      runtime.reply({ source: "otp", externalActorId: "otp-user-1", text: "hello" }),
    ).resolves.toEqual({ ok: true });

    expect(otpReply).toHaveBeenCalledWith({
      event,
      externalActorId: "otp-user-1",
      text: "hello",
    });
  });
});

describe("createEventBashRuntime.emitEvent", () => {
  it("normalizes array payloads to an empty object", async () => {
    const triggerIngestEvent = vi.fn(async () => undefined);
    const env = {
      AUTOMATIONS: {
        idFromName: vi.fn(() => "automations-do-id"),
        get: vi.fn(() => ({
          triggerIngestEvent,
        })),
      },
    } as unknown as CloudflareEnv;
    const runtime = createEventBashRuntime({
      env,
      event: createEvent(),
      sourceAdapters: {},
      sourceAdapter: undefined,
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
    const env = {
      AUTOMATIONS: {
        idFromName: vi.fn(() => "automations-do-id"),
        get: vi.fn(() => ({
          triggerIngestEvent,
        })),
      },
    } as unknown as CloudflareEnv;
    const runtime = createEventBashRuntime({
      env,
      event: createEvent(),
      sourceAdapters: {},
      sourceAdapter: undefined,
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
