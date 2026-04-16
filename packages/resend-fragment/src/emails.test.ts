import { afterAll, beforeEach, describe, expect, test } from "vitest";

import { drainDurableHooks } from "@fragno-dev/test";

import type { ResendSendEmailInput } from "./routes";
import { createResendTestContext, sendMock } from "./test-context";

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
      values["createdAt"] instanceof Date
        ? values["createdAt"]
        : new Date("2026-03-01T10:00:00.000Z");
    const occurredAt = values["occurredAt"] instanceof Date ? values["occurredAt"] : createdAt;
    const updatedAt = values["updatedAt"] instanceof Date ? values["updatedAt"] : createdAt;

    const uow = db.createUnitOfWork("outbound-msg");
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

    expect(response.type).toBe("json");
    if (response.type !== "json") {
      return;
    }

    const emailId = response.data.id;
    const queued = await ctx.getEmail(emailId);
    expect(queued).toBeTruthy();
    if (!queued) {
      throw new Error("Expected queued email record");
    }
    expect(queued.status).toBe("queued");
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
    expect(updated.status).toBe("sent");
    expect(updated.providerEmailId).toBe("re_123");
    expect(updated.sentAt).toBeInstanceOf(Date);
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(updated.createdAt.getTime());
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

    expect(response.type).toBe("json");
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
    expect(queued.status).toBe("scheduled");

    await drainDurableHooks(fragment);

    const updated = await ctx.getEmail(emailId);
    expect(updated).toBeTruthy();
    if (!updated) {
      throw new Error("Expected updated email record");
    }
    expect(updated.status).toBe("scheduled");
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

    expect(response.type).toBe("json");
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
    expect(updated.status).toBe("failed");
    expect(updated.errorCode).toBe("invalid_from_address");
    expect(updated.errorMessage).toBe("Invalid from");
  });

  test("marks failed when Resend throws", async () => {
    sendMock.mockRejectedValue(new Error("boom"));

    const response = await callRoute("POST", "/emails", {
      body: {
        to: "user@example.com",
        subject: "Boom",
        html: "<p>Fail</p>",
      },
    });

    expect(response.type).toBe("json");
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
    expect(updated.status).toBe("failed");
    expect(updated.errorMessage).toBe("boom");
    expect(updated.errorCode).toBe("Error");
  });

  test("marks failed when Resend returns no data", async () => {
    sendMock.mockResolvedValue({ data: null, error: null, headers: null });

    const response = await callRoute("POST", "/emails", {
      body: {
        to: "user@example.com",
        subject: "No data",
        html: "<p>Fail</p>",
      },
    });

    expect(response.type).toBe("json");
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
    expect(updated.status).toBe("failed");
    expect(updated.errorCode).toBe("missing_response");
    expect(updated.errorMessage).toBe("Resend returned no data");
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

    expect(firstPage.type).toBe("json");
    if (firstPage.type !== "json") {
      return;
    }

    expect(firstPage.data.emails.map((email) => email.id)).toEqual([
      thirdId.valueOf(),
      secondId.valueOf(),
    ]);
    expect(firstPage.data.hasNextPage).toBe(true);
    const cursor = firstPage.data.cursor;
    expect(cursor).toBeTruthy();
    if (!cursor) {
      return;
    }

    const secondPage = await callRoute("GET", "/emails", {
      query: { order: "desc", pageSize: "2", cursor },
    });

    expect(secondPage.type).toBe("json");
    if (secondPage.type !== "json") {
      return;
    }

    expect(secondPage.data.emails.map((email) => email.id)).toEqual([firstId.valueOf()]);
    expect(secondPage.data.hasNextPage).toBe(false);
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

    expect(response.type).toBe("json");
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

    expect(response.type).toBe("json");
    if (response.type !== "json") {
      return;
    }

    expect(response.data.emails).toHaveLength(1);
    expect(response.data.emails[0]?.status).toBe("failed");
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

    expect(response.type).toBe("json");
    if (response.type !== "json") {
      return;
    }

    expect(response.data.id).toBe(emailId.valueOf());
    expect(response.data.resendId).toBe("re_detail");
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
    expect(response.data.lastEventType).toBe("email.delivered");
  });

  test("returns 404 when email detail is missing", async () => {
    const response = await callRoute("GET", "/emails/:emailId", {
      pathParams: { emailId: "missing-email" },
    });

    expect(response.type).toBe("error");
    if (response.type === "error") {
      expect(response.status).toBe(404);
      expect(response.error.code).toBe("EMAIL_NOT_FOUND");
    }
  });

  test("rejects missing to address", async () => {
    const response = await callRoute("POST", "/emails", {
      body: {
        subject: "Missing to",
        html: "<p>Hello</p>",
      } as unknown as ResendSendEmailInput,
    });

    expect(response.type).toBe("error");
    if (response.type === "error") {
      expect(response.status).toBe(400);
      expect(response.error.code).toBe("FRAGNO_VALIDATION_ERROR");
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

    expect(response.type).toBe("error");
    if (response.type === "error") {
      expect(response.status).toBe(400);
      expect(response.error.code).toBe("FRAGNO_VALIDATION_ERROR");
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

    expect(response.type).toBe("error");
    if (response.type === "error") {
      expect(response.error.code).toBe("MISSING_FROM");
    }
  });
});
