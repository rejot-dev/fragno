import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { drainDurableHooks } from "@fragno-dev/test";

import { resendSchema } from "./schema";
import { createResendTestContext, receivingGetMock, sendMock, verifyMock } from "./test-context";

type ResendWebhookTestContext = Awaited<ReturnType<typeof createResendTestContext>>;

describe("resend-fragment webhook", () => {
  let ctx: ResendWebhookTestContext;
  let fragment: ResendWebhookTestContext["fragment"];
  let callRoute: ResendWebhookTestContext["callRoute"];
  let webhookUrl: string;

  beforeAll(async () => {
    ctx = await createResendTestContext();
    ({ fragment, callRoute } = ctx);
    webhookUrl = `http://localhost${ctx.fragment.mountRoute}/webhook`;
  });

  beforeEach(async () => {
    await ctx.reset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  test("validates webhook signature headers", async () => {
    const response = await fragment.handler(
      new Request(`${webhookUrl}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ type: "email.sent" }),
      }),
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.code).toBe("MISSING_SIGNATURE");
    expect(verifyMock).not.toHaveBeenCalled();
  });

  test("accepts inbound webhook for email received", async () => {
    const payload = {
      type: "email.received",
      object: "email",
      created_at: "2026-03-18T10:00:00.000Z",
      data: {
        object: "email",
        created_at: "2026-03-18T10:00:00.000Z",
        email_id: "re_received_1",
        from: "Acme <incoming@example.com>",
        to: ["support@example.com"],
        subject: "Inbound subject",
        cc: [],
        bcc: [],
        message_id: "<inbound-message-id>",
        created_at_ms: 1710756000000,
        raw: "SGVsbG8gV29ybGQ=",
        headers: {},
        text: "Hello",
        html: "<p>Hello</p>",
        attachments: [],
        tags: null,
        status: "queued",
      },
    } as const;

    verifyMock.mockReturnValue(payload);
    receivingGetMock.mockResolvedValue({
      data: {
        id: "re_received_1",
        created_at: "2026-03-18T10:00:00.000Z",
        from: "Acme <incoming@example.com>",
        to: ["support@example.com"],
        cc: [],
        bcc: [],
        reply_to: null,
        subject: "Inbound subject",
        message_id: "<inbound-message-id>",
        html: "<p>Hello</p>",
        text: "Hello",
        headers: {},
        attachments: [],
      },
      error: null,
      headers: null,
    });

    const rawBody = JSON.stringify(payload);
    const response = await fragment.handler(
      new Request(webhookUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "svix-id": "id",
          "svix-timestamp": "123456",
          "svix-signature": "sig",
        },
        body: rawBody,
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(verifyMock).toHaveBeenCalledWith({
      payload: rawBody,
      headers: {
        id: "id",
        timestamp: "123456",
        signature: "sig",
      },
      webhookSecret: "whsec_test",
    });

    await drainDurableHooks(fragment);

    const received = await ctx.getEmailByProviderId("re_received_1");
    expect(received).toBeTruthy();
    if (!received) {
      throw new Error("Expected received email");
    }
    expect(received.threadId).toBeTruthy();
    expect(received.providerEmailId).toBe("re_received_1");
    expect(ctx.onEmailReceived).toHaveBeenCalledTimes(1);
    const callbackPayload = ctx.onEmailReceived.mock.calls[0]?.[0];
    expect(callbackPayload).toMatchObject({
      providerEmailId: "re_received_1",
      emailMessageId: received.id.valueOf(),
      threadResolvedVia: "new-thread",
      eventType: "email.received",
    });
    expect(callbackPayload?.threadId).toEqual(expect.any(String));
    const resolvedThread = await ctx.getThread(callbackPayload.threadId);
    expect(resolvedThread).toBeTruthy();
  });

  test("retries received email callback delivery after the email commit succeeds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-18T10:05:00.000Z"));

    const payload = {
      type: "email.received",
      object: "email",
      created_at: "2026-03-18T10:00:00.000Z",
      data: {
        object: "email",
        created_at: "2026-03-18T10:00:00.000Z",
        email_id: "re_received_retry",
        from: "Acme <incoming@example.com>",
        to: ["support@example.com"],
        subject: "Retry inbound subject",
        cc: [],
        bcc: [],
        message_id: "<inbound-retry-message-id>",
        created_at_ms: 1710756000000,
        raw: "SGVsbG8gV29ybGQ=",
        headers: {},
        text: "Hello retry",
        html: "<p>Hello retry</p>",
        attachments: [],
        tags: null,
        status: "queued",
      },
    } as const;

    verifyMock.mockReturnValue(payload);
    receivingGetMock.mockResolvedValue({
      data: {
        id: "re_received_retry",
        created_at: "2026-03-18T10:00:00.000Z",
        from: "Acme <incoming@example.com>",
        to: ["support@example.com"],
        cc: [],
        bcc: [],
        reply_to: null,
        subject: "Retry inbound subject",
        message_id: "<inbound-retry-message-id>",
        html: "<p>Hello retry</p>",
        text: "Hello retry",
        headers: {},
        attachments: [],
      },
      error: null,
      headers: null,
    });
    ctx.onEmailReceived.mockImplementationOnce(async () => {
      throw new Error("transient failure");
    });

    const response = await fragment.handler(
      new Request(webhookUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "svix-id": "id-retry",
          "svix-timestamp": "123456",
          "svix-signature": "sig-retry",
        },
        body: JSON.stringify(payload),
      }),
    );

    expect(response.status).toBe(200);
    await response.json();

    await drainDurableHooks(fragment);

    const received = await ctx.getEmailByProviderId("re_received_retry");
    expect(received).toBeTruthy();
    if (!received) {
      throw new Error("Expected received email");
    }
    expect(ctx.onEmailReceived).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2026-03-18T10:05:01.000Z"));
    await drainDurableHooks(fragment);

    expect(ctx.onEmailReceived).toHaveBeenCalledTimes(2);
    expect(ctx.onEmailReceived).toHaveBeenLastCalledWith(
      expect.objectContaining({
        emailMessageId: received.id.valueOf(),
        providerEmailId: "re_received_retry",
        eventType: "email.received",
      }),
    );
  });

  test("resolves inbound replies by reply token into the existing canonical thread", async () => {
    sendMock.mockResolvedValue({
      data: { id: "re_outbound_1" },
      error: null,
      headers: null,
    });

    const created = await callRoute("POST", "/threads", {
      body: {
        to: "support@example.com",
        subject: "Canonical thread",
        html: "<p>Hello</p>",
      },
    });

    expect(created.type).toBe("json");
    if (created.type !== "json") {
      return;
    }

    const threadId = created.data.thread.id;
    const replyToAddress = created.data.thread.replyToAddress;
    await drainDurableHooks(fragment);

    const payload = {
      type: "email.received",
      object: "email",
      created_at: "2026-03-18T11:00:00.000Z",
      data: {
        object: "email",
        created_at: "2026-03-18T11:00:00.000Z",
        email_id: "re_received_reply",
        from: "Acme <incoming@example.com>",
        to: replyToAddress ? [replyToAddress] : ["support@example.com"],
        subject: "Re: Canonical thread",
        cc: [],
        bcc: [],
        message_id: "<inbound-reply-message-id>",
        created_at_ms: 1710759600000,
        raw: "SGVsbG8gV29ybGQ=",
        headers: {},
        text: "Reply",
        html: "<p>Reply</p>",
        attachments: [],
        tags: null,
        status: "queued",
      },
    } as const;

    verifyMock.mockReturnValue(payload);
    receivingGetMock.mockResolvedValue({
      data: {
        id: "re_received_reply",
        created_at: "2026-03-18T11:00:00.000Z",
        from: "Acme <incoming@example.com>",
        to: replyToAddress ? [replyToAddress] : ["support@example.com"],
        cc: [],
        bcc: [],
        reply_to: null,
        subject: "Re: Canonical thread",
        message_id: "<inbound-reply-message-id>",
        html: "<p>Reply</p>",
        text: "Reply",
        headers: {},
        attachments: [],
      },
      error: null,
      headers: null,
    });

    const rawBody = JSON.stringify(payload);
    const response = await fragment.handler(
      new Request(webhookUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "svix-id": "id",
          "svix-timestamp": "123456",
          "svix-signature": "sig",
        },
        body: rawBody,
      }),
    );

    expect(response.status).toBe(200);
    await response.json();
    await drainDurableHooks(fragment);

    const inbound = await ctx.getEmailByProviderId("re_received_reply");
    expect(inbound).toBeTruthy();
    expect(ctx.onEmailReceived).toHaveBeenLastCalledWith(
      expect.objectContaining({
        providerEmailId: "re_received_reply",
        threadId,
        threadResolvedVia: "reply-token",
      }),
    );
  });

  test("keeps latest thread metadata when an older inbound email arrives later", async () => {
    const newerPayload = {
      type: "email.received",
      object: "email",
      created_at: "2026-03-18T11:00:00.000Z",
      data: {
        object: "email",
        created_at: "2026-03-18T11:00:00.000Z",
        email_id: "re_received_newer",
        from: "Acme <incoming@example.com>",
        to: ["support@example.com"],
        subject: "Inbound subject",
        cc: [],
        bcc: [],
        message_id: "<newer-message-id>",
        created_at_ms: 1710759600000,
        raw: "SGVsbG8gV29ybGQ=",
        headers: {},
        text: "Newest reply",
        html: "<p>Newest reply</p>",
        attachments: [],
        tags: null,
        status: "queued",
      },
    } as const;

    verifyMock.mockReturnValue(newerPayload);
    receivingGetMock.mockResolvedValueOnce({
      data: {
        id: "re_received_newer",
        created_at: "2026-03-18T11:00:00.000Z",
        from: "Acme <incoming@example.com>",
        to: ["support@example.com"],
        cc: [],
        bcc: [],
        reply_to: null,
        subject: "Inbound subject",
        message_id: "<newer-message-id>",
        html: "<p>Newest reply</p>",
        text: "Newest reply",
        headers: {},
        attachments: [],
      },
      error: null,
      headers: null,
    });

    const newerResponse = await fragment.handler(
      new Request(webhookUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "svix-id": "id-newer",
          "svix-timestamp": "123456",
          "svix-signature": "sig-newer",
        },
        body: JSON.stringify(newerPayload),
      }),
    );

    expect(newerResponse.status).toBe(200);
    await newerResponse.json();
    await drainDurableHooks(fragment);

    const threadId = ctx.onEmailReceived.mock.calls[0]?.[0]?.threadId;
    expect(threadId).toEqual(expect.any(String));
    if (!threadId) {
      throw new Error("Expected thread id");
    }

    const olderPayload = {
      type: "email.received",
      object: "email",
      created_at: "2026-03-18T09:00:00.000Z",
      data: {
        object: "email",
        created_at: "2026-03-18T09:00:00.000Z",
        email_id: "re_received_older",
        from: "Acme <incoming@example.com>",
        to: ["support@example.com"],
        subject: "Inbound subject",
        cc: [],
        bcc: [],
        message_id: "<older-message-id>",
        created_at_ms: 1710752400000,
        raw: "SGVsbG8gV29ybGQ=",
        headers: {},
        text: "Earlier reply",
        html: "<p>Earlier reply</p>",
        attachments: [],
        tags: null,
        status: "queued",
      },
    } as const;

    verifyMock.mockReturnValue(olderPayload);
    receivingGetMock.mockResolvedValueOnce({
      data: {
        id: "re_received_older",
        created_at: "2026-03-18T09:00:00.000Z",
        from: "Acme <incoming@example.com>",
        to: ["support@example.com"],
        cc: [],
        bcc: [],
        reply_to: null,
        subject: "Inbound subject",
        message_id: "<older-message-id>",
        html: "<p>Earlier reply</p>",
        text: "Earlier reply",
        headers: {},
        attachments: [],
      },
      error: null,
      headers: null,
    });

    const olderResponse = await fragment.handler(
      new Request(webhookUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "svix-id": "id-older",
          "svix-timestamp": "123457",
          "svix-signature": "sig-older",
        },
        body: JSON.stringify(olderPayload),
      }),
    );

    expect(olderResponse.status).toBe(200);
    await olderResponse.json();
    await drainDurableHooks(fragment);

    const thread = await ctx.getThread(threadId);
    expect(thread).toBeTruthy();
    if (!thread) {
      throw new Error("Expected resolved thread");
    }

    expect(thread.messageCount).toBe(2);
    expect(thread.lastMessageAt.toISOString()).toBe("2026-03-18T11:00:00.000Z");
    expect(thread.lastDirection).toBe("inbound");
    expect(thread.lastMessagePreview).toBe("Newest reply");
    expect(ctx.onEmailReceived).toHaveBeenLastCalledWith(
      expect.objectContaining({
        providerEmailId: "re_received_older",
        threadId,
        threadResolvedVia: "heuristic",
      }),
    );
  });

  test("updates status events", async () => {
    {
      const uow = ctx.db.createUnitOfWork("seed-status-msg").forSchema(resendSchema);
      uow.create("emailMessage", {
        id: "msg_status",
        direction: "outbound",
        threadId: null,
        status: "queued",
        providerEmailId: "re_status",
        from: "Acme <hello@example.com>",
        to: ["support@example.com"],
        cc: null,
        bcc: null,
        replyTo: null,
        subject: "Status email",
        messageId: null,
        headers: null,
        html: "<p>Status</p>",
        text: null,
        attachments: null,
        tags: null,
        occurredAt: new Date("2026-03-18T10:00:00.000Z"),
        scheduledAt: null,
        sentAt: new Date("2026-03-18T10:00:00.000Z"),
        lastEventType: null,
        lastEventAt: null,
        errorCode: null,
        errorMessage: null,
        createdAt: new Date("2026-03-18T10:00:00.000Z"),
        updatedAt: new Date("2026-03-18T10:00:00.000Z"),
      });
      const { success } = await uow.executeMutations();
      if (!success) {
        throw new Error("Failed to create email message");
      }
    }

    const statusPayload = {
      type: "email.delivered",
      object: "email",
      created_at: "2026-03-18T10:00:00.000Z",
      data: {
        object: "email",
        email_id: "re_status",
        to: ["support@example.com"],
        from: "Acme <hello@example.com>",
        created_at: "2026-03-18T10:00:00.000Z",
        created_at_ms: 1710756000000,
        status: "delivered",
      },
    };

    verifyMock.mockReturnValue(statusPayload);

    const rawBody = JSON.stringify(statusPayload);
    const response = await fragment.handler(
      new Request(webhookUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "svix-id": "id",
          "svix-timestamp": "123456",
          "svix-signature": "sig",
        },
        body: rawBody,
      }),
    );

    expect(response.status).toBe(200);
    await response.json();

    await drainDurableHooks(fragment);

    const updated = await ctx.getEmail("msg_status");
    expect(updated).toBeTruthy();
    if (!updated) {
      throw new Error("Expected updated email");
    }
    expect(updated.lastEventType).toBe("email.delivered");
    expect(updated.lastEventAt).toBeInstanceOf(Date);
    expect(ctx.onEmailStatusUpdated).toHaveBeenCalledWith(
      expect.objectContaining({
        emailMessageId: "msg_status",
        providerEmailId: "re_status",
        status: "delivered",
      }),
    );
  });

  test("retries status callback delivery after the status update commits", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-18T10:05:00.000Z"));

    {
      const uow = ctx.db.createUnitOfWork("seed-status-retry-msg").forSchema(resendSchema);
      uow.create("emailMessage", {
        id: "msg_status_retry",
        direction: "outbound",
        threadId: null,
        status: "queued",
        providerEmailId: "re_status_retry",
        from: "Acme <hello@example.com>",
        to: ["support@example.com"],
        cc: null,
        bcc: null,
        replyTo: null,
        subject: "Status retry email",
        messageId: null,
        headers: null,
        html: "<p>Status retry</p>",
        text: null,
        attachments: null,
        tags: null,
        occurredAt: new Date("2026-03-18T10:00:00.000Z"),
        scheduledAt: null,
        sentAt: new Date("2026-03-18T10:00:00.000Z"),
        lastEventType: null,
        lastEventAt: null,
        errorCode: null,
        errorMessage: null,
        createdAt: new Date("2026-03-18T10:00:00.000Z"),
        updatedAt: new Date("2026-03-18T10:00:00.000Z"),
      });
      const { success } = await uow.executeMutations();
      if (!success) {
        throw new Error("Failed to create email message");
      }
    }

    const payload = {
      type: "email.delivered",
      object: "email",
      created_at: "2026-03-18T10:00:00.000Z",
      data: {
        object: "email",
        email_id: "re_status_retry",
        to: ["support@example.com"],
        from: "Acme <hello@example.com>",
        created_at: "2026-03-18T10:00:00.000Z",
        created_at_ms: 1710756000000,
        status: "delivered",
      },
    };

    verifyMock.mockReturnValue(payload);
    ctx.onEmailStatusUpdated.mockImplementationOnce(async () => {
      throw new Error("transient failure");
    });

    const response = await fragment.handler(
      new Request(webhookUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "svix-id": "id-status-retry",
          "svix-timestamp": "123456",
          "svix-signature": "sig-status-retry",
        },
        body: JSON.stringify(payload),
      }),
    );

    expect(response.status).toBe(200);
    await response.json();

    await drainDurableHooks(fragment);

    const updated = await ctx.getEmail("msg_status_retry");
    expect(updated).toBeTruthy();
    expect(updated?.status).toBe("delivered");
    expect(ctx.onEmailStatusUpdated).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2026-03-18T10:05:01.000Z"));
    await drainDurableHooks(fragment);

    expect(ctx.onEmailStatusUpdated).toHaveBeenCalledTimes(2);
    expect(ctx.onEmailStatusUpdated).toHaveBeenLastCalledWith(
      expect.objectContaining({
        emailMessageId: "msg_status_retry",
        providerEmailId: "re_status_retry",
        status: "delivered",
      }),
    );
  });

  test("rejects invalid webhook signature", async () => {
    verifyMock.mockImplementation(() => {
      throw new Error("invalid");
    });

    const response = await fragment.handler(
      new Request(webhookUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "svix-id": "id",
          "svix-timestamp": "123456",
          "svix-signature": "sig",
        },
        body: JSON.stringify({ type: "email.sent" }),
      }),
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.code).toBe("WEBHOOK_SIGNATURE_INVALID");
  });

  test("rejects webhook when resend secret missing", async () => {
    ctx.config.webhookSecret = "";

    const response = await fragment.handler(
      new Request(webhookUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "svix-id": "id",
          "svix-timestamp": "123456",
          "svix-signature": "sig",
        },
        body: JSON.stringify({ type: "email.sent" }),
      }),
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.code).toBe("WEBHOOK_ERROR");
  });
});
