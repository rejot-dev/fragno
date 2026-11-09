import { afterAll, beforeEach, describe, expect, test, assert } from "vitest";

import { drainDurableHooks } from "@fragno-dev/test";

import type { ResendSendEmailInput } from "./routes";
import { resendSchema } from "./schema";
import {
  createResendTestContext,
  drainDurableHooksWithRetries,
  sendMock,
  verifyMock,
} from "./test-context";

describe("resend-fragment emails", async () => {
  const ctx = await createResendTestContext();
  const { fragment, callRoute, db } = ctx;

  const createOutboundMessage = async (overrides: Record<string, unknown> = {}) => {
    const values = overrides as {
      createdAt?: Date;
      occurredAt?: Date;
      updatedAt?: Date;
    };
    const createdAt =
      values.createdAt instanceof Date ? values.createdAt : new Date("2026-03-01T10:00:00.000Z");
    const occurredAt = values.occurredAt instanceof Date ? values.occurredAt : createdAt;
    const updatedAt = values.updatedAt instanceof Date ? values.updatedAt : createdAt;

    const uow = db.createUnitOfWork("outbound-msg").forSchema(resendSchema);
    uow.create("emailMessage", {
      direction: "outbound",
      threadId: null,
      status: "sent",
      providerEmailId: null,
      from: "Acme <hello@example.com>",
      to: ["user@example.com"],
      cc: null,
      bcc: null,
      replyTo: null,
      subject: "Subject",
      messageId: null,
      headers: null,
      html: "<p>Hi</p>",
      text: null,
      attachments: null,
      tags: null,
      occurredAt,
      scheduledAt: null,
      sentAt: occurredAt,
      lastEventType: null,
      lastEventAt: null,
      errorCode: null,
      errorMessage: null,
      createdAt,
      updatedAt,
      ...overrides,
    });
    const { success } = await uow.executeMutations();
    if (!success) {
      throw new Error("Failed to create email message");
    }
    return uow.getCreatedIds()[0]!;
  };

  beforeEach(async () => {
    await ctx.reset();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  test("queues email and sends via durable hook", async () => {
    sendMock.mockResolvedValue({
      data: { id: "re_123" },
      error: null,
      headers: null,
    });

    const response = await callRoute("POST", "/emails", {
      body: {
        to: "user@example.com",
        subject: "Hello",
        html: "<p>Hello</p>",
      },
    });

    assert(response.type === "json");
    if (response.type !== "json") {
      return;
    }

    const emailId = response.data.id;
    const queued = await ctx.getEmail(emailId);
    expect(queued).toBeTruthy();
    if (!queued) {
      throw new Error("Expected queued email record");
    }
    assert(queued.status === "queued");
    expect(queued.providerEmailId).toBeNull();

    await drainDurableHooks(fragment);

    expect(sendMock).toHaveBeenCalledTimes(1);
    const [, options] = sendMock.mock.calls[0] ?? [];
    expect(options).toEqual({ idempotencyKey: expect.any(String) });

    const updated = await ctx.getEmail(emailId);
    expect(updated).toBeTruthy();
    if (!updated) {
      throw new Error("Expected updated email record");
    }
    assert(updated.status === "sent");
    assert(updated.providerEmailId === "re_123");
    expect(updated.sentAt).toBeInstanceOf(Date);
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(updated.createdAt.getTime());
  });

  test("deduplicates queued email by Idempotency-Key", async () => {
    sendMock.mockResolvedValue({
      data: { id: "re_idempotent" },
      error: null,
      headers: null,
    });

    const input = {
      body: {
        to: "user@example.com",
        subject: "Welcome",
        html: "<p>Welcome</p>",
      },
      headers: { "Idempotency-Key": "auth:user-created:user-1:tx-1" },
    };

    const first = await callRoute("POST", "/emails", input);
    const second = await callRoute("POST", "/emails", input);

    assert(first.type === "json");
    assert(second.type === "empty");
    assert(second.status === 204);

    await drainDurableHooks(fragment);

    expect(sendMock).toHaveBeenCalledTimes(1);
    const emails = await callRoute("GET", "/emails");
    assert(emails.type === "json");
    expect(emails.data.emails).toHaveLength(1);
  });

  test("rejects an oversized Idempotency-Key", async () => {
    const response = await callRoute("POST", "/emails", {
      body: {
        to: "user@example.com",
        subject: "Welcome",
        html: "<p>Welcome</p>",
      },
      headers: { "Idempotency-Key": "x".repeat(111) },
    });

    assert(response.type === "error");
    assert(response.error.code === "INVALID_IDEMPOTENCY_KEY");
    assert(response.status === 400);
  });

  test("schedules emails via durable hooks processAt", async () => {
    sendMock.mockResolvedValue({
      data: { id: "re_sched" },
      error: null,
      headers: null,
    });

    const response = await callRoute("POST", "/emails", {
      body: {
        to: "user@example.com",
        subject: "Scheduled",
        html: "<p>Later</p>",
        scheduledIn: { minutes: 1 },
      },
    });

    assert(response.type === "json");
    if (response.type !== "json") {
      return;
    }

    const emailId = response.data.id;
    const queued = await ctx.getEmail(emailId);
    expect(queued).toBeTruthy();
    if (!queued) {
      throw new Error("Expected queued email record");
    }
    expect(queued.scheduledAt).toBeInstanceOf(Date);
    expect(queued.scheduledAt?.getTime()).toBeGreaterThan(queued.createdAt.getTime());
    assert(queued.status === "scheduled");

    await drainDurableHooks(fragment);

    const updated = await ctx.getEmail(emailId);
    expect(updated).toBeTruthy();
    if (!updated) {
      throw new Error("Expected updated email record");
    }
    assert(updated.status === "scheduled");
    expect(updated.sentAt).toBeNull();
    expect(sendMock).not.toHaveBeenCalled();
  });

  test("marks failed when Resend responds with error", async () => {
    sendMock.mockResolvedValue({
      data: null,
      error: {
        message: "Invalid from",
        name: "invalid_from_address",
        statusCode: 400,
      },
      headers: null,
    });

    const response = await callRoute("POST", "/emails", {
      body: {
        to: "user@example.com",
        subject: "Bad",
        html: "<p>Fail</p>",
      },
    });

    assert(response.type === "json");
    if (response.type !== "json") {
      return;
    }

    const emailId = response.data.id;
    await drainDurableHooks(fragment);

    const updated = await ctx.getEmail(emailId);
    expect(updated).toBeTruthy();
    if (!updated) {
      throw new Error("Expected updated email record");
    }
    assert(updated.status === "failed");
    assert(updated.errorCode === "invalid_from_address");
    assert(updated.errorMessage === "Invalid from");
  });

  test("retries when Resend throws, and sends once it answers", async () => {
    sendMock
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue({ data: { id: "re_after_retry" }, error: null, headers: null });

    const response = await callRoute("POST", "/emails", {
      body: {
        to: "user@example.com",
        subject: "Boom",
        html: "<p>Fail</p>",
      },
    });

    assert(response.type === "json");
    if (response.type !== "json") {
      return;
    }

    const emailId = response.data.id;
    await drainDurableHooks(fragment);

    // The network, not Resend, failed, so the email waits for the hook's next attempt.
    const waiting = await ctx.getEmail(emailId);
    assert(waiting?.status === "queued");
    assert(waiting.errorMessage === "boom");
    assert(waiting.errorCode === "Error");

    await drainDurableHooksWithRetries(fragment);
    const sent = await ctx.getEmail(emailId);
    assert(sent?.status === "sent");
    assert(sent.providerEmailId === "re_after_retry");
    assert(sent.errorCode === null);
    expect(sendMock).toHaveBeenCalledTimes(2);
    // Both attempts are one email to Resend.
    assert(
      sendMock.mock.calls[0]?.[1]?.idempotencyKey === sendMock.mock.calls[1]?.[1]?.idempotencyKey,
    );
  });

  test("gives each email queued in one transaction its own Resend key, kept across retries", async () => {
    // Whichever email goes first loses its answer once, and is retried.
    sendMock
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValue({ data: { id: "re_sent" }, error: null, headers: null });
    const queued = await fragment.inContext(async function () {
      return await this.handlerTx()
        .withServiceCalls(
          () =>
            [
              fragment.services.queueEmail({ to: "a@example.com", subject: "First", text: "One" }),
              fragment.services.queueEmail({ to: "b@example.com", subject: "Second", text: "Two" }),
            ] as const,
        )
        .transform(({ serviceResult }) => serviceResult)
        .execute();
    });

    await drainDurableHooksWithRetries(fragment);
    const keysBySubject = new Map<string, string[]>();
    for (const [payload, options] of sendMock.mock.calls) {
      keysBySubject.set(payload.subject, [
        ...(keysBySubject.get(payload.subject) ?? []),
        options.idempotencyKey,
      ]);
    }
    const [once, retried] = [...keysBySubject.values()].toSorted((a, b) => a.length - b.length);
    assert(once?.length === 1 && retried?.length === 2);
    assert(retried[0] === retried[1]);
    assert(once[0] !== retried[0]);
    for (const email of queued) {
      assert((await ctx.getEmail(email.id))?.status === "sent");
    }
  });

  test("reports statuses Resend sent before a retry learned the email was accepted", async () => {
    // Resend accepts the email, but its answer is lost; the retry gets the same email back.
    sendMock
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValue({ data: { id: "re_accepted" }, error: null, headers: null });
    const response = await callRoute("POST", "/emails", {
      body: { to: "user@example.com", subject: "Late", text: "Hello" },
    });
    assert(response.type === "json");
    const deliveredAt = new Date(Date.now() + 1_000).toISOString();
    await drainDurableHooksWithRetries(fragment);
    assert((await ctx.getEmail(response.data.id))?.status === "sent");

    const event = {
      type: "email.delivered",
      created_at: deliveredAt,
      data: {
        email_id: "re_accepted",
        from: "Acme <hello@example.com>",
        to: ["user@example.com"],
        subject: "Late",
        created_at: deliveredAt,
      },
    };
    verifyMock.mockReturnValue(event);
    const webhook = await fragment.handler(
      new Request(`http://localhost${fragment.mountRoute}/webhook`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "svix-id": "delivered-late",
          "svix-timestamp": "123456",
          "svix-signature": "sig",
        },
        body: JSON.stringify(event),
      }),
    );
    assert(webhook.status === 200);
    await drainDurableHooks(fragment);

    // The delivery came after acceptance, so it counts, however late the retry learned of it.
    assert((await ctx.getEmail(response.data.id))?.status === "delivered");
    expect(ctx.onEmailStatusUpdated).toHaveBeenCalledTimes(1);
  });

  test("marks failed once Resend returns no data on every attempt", async () => {
    sendMock.mockResolvedValue({ data: null, error: null, headers: null });

    const response = await callRoute("POST", "/emails", {
      body: {
        to: "user@example.com",
        subject: "No data",
        html: "<p>Fail</p>",
      },
    });

    assert(response.type === "json");
    if (response.type !== "json") {
      return;
    }

    const emailId = response.data.id;
    await drainDurableHooksWithRetries(fragment);

    const updated = await ctx.getEmail(emailId);
    expect(updated).toBeTruthy();
    if (!updated) {
      throw new Error("Expected updated email record");
    }
    expect(sendMock).toHaveBeenCalledTimes(10);
    assert(updated.status === "failed");
    assert(updated.errorCode === "missing_response");
    assert(updated.errorMessage === "Resend returned no data");
  });

  test("lists emails with cursor pagination", async () => {
    const firstId = await createOutboundMessage({
      id: "msg_first",
      providerEmailId: "re_first",
      subject: "First",
      occurredAt: new Date("2026-03-01T10:00:00.000Z"),
      sentAt: new Date("2026-03-01T10:00:00.000Z"),
      createdAt: new Date("2026-03-01T10:00:00.000Z"),
      updatedAt: new Date("2026-03-01T10:00:00.000Z"),
    });
    const secondId = await createOutboundMessage({
      id: "msg_second",
      providerEmailId: "re_second",
      subject: "Second",
      occurredAt: new Date("2026-03-02T10:00:00.000Z"),
      sentAt: new Date("2026-03-02T10:00:00.000Z"),
      createdAt: new Date("2026-03-02T10:00:00.000Z"),
      updatedAt: new Date("2026-03-02T10:00:00.000Z"),
    });
    const thirdId = await createOutboundMessage({
      id: "msg_third",
      providerEmailId: "re_third",
      subject: "Third",
      occurredAt: new Date("2026-03-03T10:00:00.000Z"),
      sentAt: new Date("2026-03-03T10:00:00.000Z"),
      createdAt: new Date("2026-03-03T10:00:00.000Z"),
      updatedAt: new Date("2026-03-03T10:00:00.000Z"),
    });

    const firstPage = await callRoute("GET", "/emails", {
      query: { order: "desc", pageSize: "2" },
    });

    assert(firstPage.type === "json");
    if (firstPage.type !== "json") {
      return;
    }

    expect(firstPage.data.emails.map((email) => email.id)).toEqual([
      thirdId.valueOf(),
      secondId.valueOf(),
    ]);
    assert(firstPage.data.hasNextPage);
    const cursor = firstPage.data.cursor;
    expect(cursor).toBeTruthy();
    if (!cursor) {
      return;
    }

    const secondPage = await callRoute("GET", "/emails", {
      query: { order: "desc", pageSize: "2", cursor },
    });

    assert(secondPage.type === "json");
    if (secondPage.type !== "json") {
      return;
    }

    expect(secondPage.data.emails.map((email) => email.id)).toEqual([firstId.valueOf()]);
    assert(!secondPage.data.hasNextPage);
  });

  test("lists emails with empty to list", async () => {
    const emailId = await createOutboundMessage({
      status: "queued",
      to: [],
      subject: "Empty to",
      html: "<p>Empty to</p>",
      sentAt: null,
      occurredAt: new Date("2026-03-01T12:00:00.000Z"),
      createdAt: new Date("2026-03-01T12:00:00.000Z"),
      updatedAt: new Date("2026-03-01T12:00:00.000Z"),
    });

    const response = await callRoute("GET", "/emails");

    assert(response.type === "json");
    if (response.type !== "json") {
      return;
    }

    const listed = response.data.emails.find((email) => email.id === emailId.valueOf());
    expect(listed).toBeTruthy();
    if (!listed) {
      return;
    }
    expect(listed.to).toEqual([]);
  });

  test("filters emails by status", async () => {
    await createOutboundMessage({
      id: "msg_sent",
      status: "sent",
      providerEmailId: "re_sent",
      subject: "Sent",
      html: "<p>Sent</p>",
      occurredAt: new Date("2026-03-01T10:00:00.000Z"),
      sentAt: new Date("2026-03-01T10:00:00.000Z"),
      createdAt: new Date("2026-03-01T10:00:00.000Z"),
      updatedAt: new Date("2026-03-01T10:00:00.000Z"),
    });
    await createOutboundMessage({
      id: "msg_failed",
      status: "failed",
      subject: "Failed",
      html: "<p>Failed</p>",
      sentAt: null,
      errorCode: "error",
      errorMessage: "Boom",
      occurredAt: new Date("2026-03-01T11:00:00.000Z"),
      createdAt: new Date("2026-03-01T11:00:00.000Z"),
      updatedAt: new Date("2026-03-01T11:00:00.000Z"),
    });

    const response = await callRoute("GET", "/emails", {
      query: { status: "failed" },
    });

    assert(response.type === "json");
    if (response.type !== "json") {
      return;
    }

    expect(response.data.emails).toHaveLength(1);
    assert(response.data.emails[0]?.status === "failed");
  });

  test("returns email detail including payload", async () => {
    const emailId = await createOutboundMessage({
      id: "msg_detail",
      status: "sent",
      providerEmailId: "re_detail",
      subject: "Detail",
      html: "<p>Detail</p>",
      text: "Plain detail",
      cc: ["cc@example.com"],
      bcc: ["bcc@example.com"],
      replyTo: ["reply@example.com"],
      tags: [{ name: "source", value: "test" }],
      headers: { "X-Env": "test" },
      lastEventType: "email.delivered",
      lastEventAt: new Date("2026-03-03T10:05:00.000Z"),
      occurredAt: new Date("2026-03-03T10:00:00.000Z"),
      sentAt: new Date("2026-03-03T10:00:00.000Z"),
      createdAt: new Date("2026-03-03T10:00:00.000Z"),
      updatedAt: new Date("2026-03-03T10:05:00.000Z"),
    });

    const response = await callRoute("GET", "/emails/:emailId", {
      pathParams: { emailId: emailId.valueOf() },
    });

    assert(response.type === "json");
    if (response.type !== "json") {
      return;
    }

    expect(response.data.id).toBe(emailId.valueOf());
    assert(response.data.resendId === "re_detail");
    expect(response.data.payload).toMatchObject({
      from: "Acme <hello@example.com>",
      to: ["user@example.com"],
      subject: "Detail",
      html: "<p>Detail</p>",
      text: "Plain detail",
      cc: ["cc@example.com"],
      bcc: ["bcc@example.com"],
      replyTo: ["reply@example.com"],
      tags: [{ name: "source", value: "test" }],
      headers: { "X-Env": "test" },
    });
    assert(response.data.lastEventType === "email.delivered");
  });

  test("returns 404 when email detail is missing", async () => {
    const response = await callRoute("GET", "/emails/:emailId", {
      pathParams: { emailId: "missing-email" },
    });

    assert(response.type === "error");
    if (response.type === "error") {
      assert(response.status === 404);
      assert(response.error.code === "EMAIL_NOT_FOUND");
    }
  });

  test("rejects missing to address", async () => {
    const response = await callRoute("POST", "/emails", {
      body: {
        subject: "Missing to",
        html: "<p>Hello</p>",
      } as unknown as ResendSendEmailInput,
    });

    assert(response.type === "error");
    if (response.type === "error") {
      assert(response.status === 400);
      assert(response.error.code === "FRAGNO_VALIDATION_ERROR");
    }
  });

  test("rejects empty to list", async () => {
    const response = await callRoute("POST", "/emails", {
      body: {
        to: [] as string[],
        subject: "Empty to",
        html: "<p>Hello</p>",
      } as unknown as ResendSendEmailInput,
    });

    assert(response.type === "error");
    if (response.type === "error") {
      assert(response.status === 400);
      assert(response.error.code === "FRAGNO_VALIDATION_ERROR");
    }
  });

  test("returns missing-from error when defaultFrom is not set", async () => {
    ctx.config.defaultFrom = undefined;

    const response = await callRoute("POST", "/emails", {
      body: {
        to: "user@example.com",
        subject: "Missing from",
        html: "<p>Missing</p>",
      },
    });

    assert(response.type === "error");
    if (response.type === "error") {
      assert(response.error.code === "MISSING_FROM");
    }
  });
});
