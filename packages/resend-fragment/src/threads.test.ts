import { afterAll, beforeEach, describe, expect, test } from "vitest";

import { drainDurableHooks } from "@fragno-dev/test";

import { createResendTestContext, sendMock, verifyMock } from "./test-context";

describe("resend-fragment threads", async () => {
  const ctx = await createResendTestContext();
  const { fragment, callRoute } = ctx;

  beforeEach(async () => {
    await ctx.reset();
    verifyMock.mockReturnValue({
      type: "email.received",
      object: "event",
      created_at: "2026-03-18T10:00:00.000Z",
      data: {
        object: "email",
        id: "re_inbound_1",
        from: "support@example.com",
        to: ["agent@example.com"],
        cc: [],
        bcc: [],
        reply_to: ["reply@example.com"],
        subject: "Hello thread",
        message_id: "<inbound-msg>",
        created_at: "2026-03-18T10:00:00.000Z",
        headers: {},
        attachments: [],
      } as never,
    });
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  test("creates thread via outbound send endpoint", async () => {
    sendMock.mockResolvedValue({
      data: { id: "re_thread_1" },
      error: null,
      headers: null,
    });

    const response = await callRoute("POST", "/threads", {
      body: {
        to: "support@example.com",
        subject: "Initial thread",
        html: "<p>Hello</p>",
      },
    });

    expect(response.type).toBe("json");
    if (response.type !== "json") {
      return;
    }

    const { thread, message } = response.data;
    expect(thread.subject).toBe("Initial thread");
    expect(thread.messageCount).toBe(1);
    expect(thread.lastDirection).toBe("outbound");

    expect(message.direction).toBe("outbound");
    expect(message.subject).toBe("Initial thread");
    expect(Array.isArray(message.replyTo)).toBe(true);
    expect(message.replyTo.length).toBeGreaterThan(0);

    const storedThread = await ctx.getThread(thread.id);
    expect(storedThread).toBeTruthy();
    if (!storedThread) {
      throw new Error("Expected thread");
    }
    expect(storedThread.replyToken).toEqual(expect.any(String));

    const storedMessage = await ctx.getEmail(message.id);
    expect(storedMessage).toBeTruthy();
    const storedMessages = await ctx.listThreadMessages(thread.id);
    expect(storedMessages.map((entry) => entry.id.valueOf())).toContain(message.id);

    await drainDurableHooks(fragment);
    expect(sendMock).toHaveBeenCalledTimes(1);

    const emailRecord = await ctx.getEmail(message.id);
    expect(emailRecord).toBeTruthy();
    if (!emailRecord) {
      throw new Error("Expected email record");
    }
    expect(emailRecord.status).toBe("sent");
    expect(emailRecord.providerEmailId).toBe("re_thread_1");
  });

  test("returns scheduledAt for scheduled thread messages", async () => {
    const beforeCreate = new Date();

    const response = await callRoute("POST", "/threads", {
      body: {
        to: "support@example.com",
        subject: "Scheduled thread",
        html: "<p>Hello later</p>",
        scheduledIn: { minutes: 1 },
      },
    });

    expect(response.type).toBe("json");
    if (response.type !== "json") {
      return;
    }

    const { thread, message } = response.data;
    expect(thread.messageCount).toBe(1);
    expect(message.status).toBe("scheduled");
    expect(message.scheduledAt).toBeTruthy();

    const storedMessage = await ctx.getEmail(message.id);
    expect(storedMessage).toBeTruthy();
    if (!storedMessage) {
      throw new Error("Expected stored scheduled message");
    }

    expect(storedMessage.scheduledAt).toBeInstanceOf(Date);
    const responseScheduledAt = new Date(String(message.scheduledAt));
    expect(Number.isNaN(responseScheduledAt.getTime())).toBe(false);
    expect(
      Math.abs(responseScheduledAt.getTime() - (storedMessage.scheduledAt?.getTime() ?? 0)),
    ).toBeLessThanOrEqual(1_000);
    expect(responseScheduledAt.getTime()).toBeGreaterThan(beforeCreate.getTime());
  });

  test("replies into an existing thread", async () => {
    sendMock.mockResolvedValue({
      data: { id: "re_thread_base" },
      error: null,
      headers: null,
    });

    const created = await callRoute("POST", "/threads", {
      body: {
        to: "support@example.com",
        subject: "Project discussion",
        html: "<p>Let's start</p>",
      },
    });

    expect(created.type).toBe("json");
    if (created.type !== "json") {
      return;
    }

    const threadId = created.data.thread.id;
    await drainDurableHooks(fragment);
    sendMock.mockClear();
    sendMock.mockResolvedValue({
      data: { id: "re_thread_reply" },
      error: null,
      headers: null,
    });

    const response = await callRoute("POST", "/threads/:threadId/reply", {
      pathParams: { threadId },
      body: {
        to: "support@example.com",
        html: "<p>Thanks</p>",
      },
    });

    expect(response.type).toBe("json");
    if (response.type !== "json") {
      return;
    }

    const { thread, message } = response.data;
    expect(thread.id).toBe(threadId);
    expect(thread.messageCount).toBe(2);
    expect(thread.lastDirection).toBe("outbound");

    expect(message.direction).toBe("outbound");
    expect(message.inReplyTo).toEqual(expect.any(String));
    expect(message.references).toEqual(expect.arrayContaining([expect.any(String)]));

    const storedMessages = await ctx.listThreadMessages(threadId);
    expect(storedMessages).toHaveLength(2);
  });

  test("lists thread messages from the canonical message store", async () => {
    sendMock.mockResolvedValue({
      data: { id: "re_thread_messages" },
      error: null,
      headers: null,
    });

    const created = await callRoute("POST", "/threads", {
      body: {
        to: "support@example.com",
        subject: "Canonical",
        html: "<p>First</p>",
      },
    });

    expect(created.type).toBe("json");
    if (created.type !== "json") {
      return;
    }

    const threadId = created.data.thread.id;
    const messages = await callRoute("GET", "/threads/:threadId/messages", {
      pathParams: { threadId },
    });

    expect(messages.type).toBe("json");
    if (messages.type !== "json") {
      return;
    }

    expect(messages.data.messages).toHaveLength(1);
    expect(messages.data.messages[0]?.id).toBe(created.data.message.id);
  });

  test("gets thread list and thread detail", async () => {
    sendMock.mockResolvedValue({
      data: { id: "re_thread_list_1" },
      error: null,
      headers: null,
    });

    const createFirst = await callRoute("POST", "/threads", {
      body: {
        to: "support@example.com",
        subject: "First",
        html: "<p>First</p>",
      },
    });
    expect(createFirst.type).toBe("json");

    const createSecond = await callRoute("POST", "/threads", {
      body: {
        to: "support@example.com",
        subject: "Second",
        html: "<p>Second</p>",
      },
    });
    expect(createSecond.type).toBe("json");

    const list = await callRoute("GET", "/threads", {
      query: { order: "desc", pageSize: "10" },
    });
    expect(list.type).toBe("json");
    if (list.type !== "json") {
      return;
    }
    expect(list.data.threads).toHaveLength(2);

    const firstThreadId = list.data.threads[0]!.id;
    const detail = await callRoute("GET", "/threads/:threadId", {
      pathParams: { threadId: firstThreadId },
    });
    expect(detail.type).toBe("json");
    if (detail.type !== "json") {
      return;
    }
    expect(detail.data.id).toBe(firstThreadId);
    expect(typeof detail.data.replyToAddress).toBe("string");
  });

  test("returns THREAD_NOT_FOUND for unknown thread", async () => {
    const response = await callRoute("GET", "/threads/:threadId", {
      pathParams: { threadId: "missing-thread" },
    });
    expect(response.type).toBe("error");
  });
});
