import { describe, expect, test } from "vitest";

import { buildTelegramAutomationEvent } from "./telegram";

describe("buildTelegramAutomationEvent", () => {
  test("accepts serialized hook payload dates", () => {
    const event = buildTelegramAutomationEvent("org-1", {
      updateId: 42,
      updateType: "message",
      messageId: "chat-1:10",
      chatId: "chat-1",
      fromUserId: "user-1",
      text: "/start",
      commandName: "start",
      sentAt: "2026-03-17T14:30:29.074Z",
      editedAt: null,
    });

    expect(event).toEqual({
      id: "telegram:org-1:42:chat-1:10",
      orgId: "org-1",
      source: "telegram",
      eventType: "message.received",
      occurredAt: "2026-03-17T14:30:29.074Z",
      payload: {
        messageId: "chat-1:10",
        chatId: "chat-1",
        fromUserId: "user-1",
        text: "/start",
      },
      actor: {
        type: "external",
        externalId: "chat-1",
      },
    });
  });
});
