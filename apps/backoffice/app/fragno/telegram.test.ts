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
      attachments: [],
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

  test("includes attachments when present", () => {
    const event = buildTelegramAutomationEvent("org-1", {
      updateId: 43,
      updateType: "message",
      messageId: "chat-1:11",
      chatId: "chat-1",
      fromUserId: "user-1",
      text: null,
      attachments: [
        {
          kind: "voice",
          fileId: "voice-file-1",
          fileUniqueId: "voice-unique-1",
          duration: 3,
        },
      ],
      commandName: null,
      sentAt: "2026-03-17T14:30:29.074Z",
      editedAt: null,
    });

    expect(event.payload).toEqual({
      messageId: "chat-1:11",
      chatId: "chat-1",
      fromUserId: "user-1",
      text: null,
      attachments: [
        {
          kind: "voice",
          fileId: "voice-file-1",
          fileUniqueId: "voice-unique-1",
          duration: 3,
        },
      ],
    });
  });
});
