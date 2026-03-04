import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { buildDatabaseFragmentsTest, drainDurableHooks } from "@fragno-dev/test";
import { instantiate } from "@fragno-dev/core";
import { resendFragmentDefinition } from "./definition";
import type { ResendFragmentConfig } from "./definition";
import { resendRoutesFactory, type ResendSendEmailInput } from "./routes";
import type { WebhookEventPayload } from "resend";

const sendMock = vi.fn();
const verifyMock = vi.fn();

vi.mock("resend", () => {
  return {
    Resend: vi.fn().mockImplementation(() => ({
      emails: { send: sendMock },
      webhooks: { verify: verifyMock },
    })),
  };
});

describe("resend-fragment", async () => {
  const onEmailStatusUpdated = vi.fn();
  const config: ResendFragmentConfig = {
    apiKey: "re_test",
    webhookSecret: "whsec_test",
    defaultFrom: "Acme <hello@example.com>",
    onEmailStatusUpdated,
  };

  const { fragments, test: testContext } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "kysely-sqlite" })
    .withFragment(
      "resend",
      instantiate(resendFragmentDefinition).withConfig(config).withRoutes([resendRoutesFactory]),
    )
    .build();

  const { fragment, db } = fragments.resend;

  const getEmail = async (id: string) =>
    db.findFirst("email", (b) => b.whereIndex("primary", (eb) => eb("id", "=", id)));

  beforeEach(async () => {
    await testContext.resetDatabase();
    sendMock.mockReset();
    verifyMock.mockReset();
    onEmailStatusUpdated.mockReset();
    config.defaultFrom = "Acme <hello@example.com>";
    config.webhookSecret = "whsec_test";
  });

  afterAll(async () => {
    await testContext.cleanup();
  });

  test("queues email and sends via durable hook", async () => {
    sendMock.mockResolvedValue({ data: { id: "re_123" }, error: null, headers: null });

    const response = await fragment.callRoute("POST", "/emails", {
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
    const queued = await getEmail(emailId);
    expect(queued).toBeTruthy();
    if (!queued) {
      throw new Error("Expected queued email record");
    }
    expect(queued.status).toBe("queued");

    await drainDurableHooks(fragment);

    expect(sendMock).toHaveBeenCalledTimes(1);
    const [, options] = sendMock.mock.calls[0] ?? [];
    expect(options).toEqual({ idempotencyKey: expect.any(String) });

    const updated = await getEmail("re_123");
    expect(updated).toBeTruthy();
    if (!updated) {
      throw new Error("Expected updated email record");
    }
    expect(updated.status).toBe("sent");
    expect(updated.id.valueOf()).toBe("re_123");
    expect(updated.sentAt).toBeInstanceOf(Date);
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(updated.createdAt.getTime());

    const stale = await getEmail(emailId);
    expect(stale).toBeNull();
  });

  test("schedules emails via durable hooks processAt", async () => {
    sendMock.mockResolvedValue({ data: { id: "re_sched" }, error: null, headers: null });

    const response = await fragment.callRoute("POST", "/emails", {
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
    const queued = await getEmail(emailId);
    expect(queued).toBeTruthy();
    if (!queued) {
      throw new Error("Expected queued email record");
    }
    expect(queued.scheduledAt).toBeInstanceOf(Date);
    expect(queued.scheduledAt?.getTime()).toBeGreaterThan(queued.createdAt.getTime());
    expect(queued.status).toBe("scheduled");

    await drainDurableHooks(fragment);

    const updated = await getEmail(emailId);
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
      error: { message: "Invalid from", name: "invalid_from_address", statusCode: 400 },
      headers: null,
    });

    const response = await fragment.callRoute("POST", "/emails", {
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

    const updated = await getEmail(emailId);
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

    const response = await fragment.callRoute("POST", "/emails", {
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

    const updated = await getEmail(emailId);
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

    const response = await fragment.callRoute("POST", "/emails", {
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

    const updated = await getEmail(emailId);
    expect(updated).toBeTruthy();
    if (!updated) {
      throw new Error("Expected updated email record");
    }
    expect(updated.status).toBe("failed");
    expect(updated.errorCode).toBe("missing_response");
    expect(updated.errorMessage).toBe("Resend returned no data");
  });

  test("lists emails with cursor pagination", async () => {
    const basePayload = {
      from: "Acme <hello@example.com>",
      to: ["user@example.com"],
      html: "<p>Hi</p>",
    };

    const firstId = await db.create("email", {
      id: "re_first",
      status: "sent",
      from: basePayload.from,
      to: basePayload.to,
      subject: "First",
      html: basePayload.html,
      text: null,
      cc: null,
      bcc: null,
      replyTo: null,
      tags: null,
      headers: null,
      scheduledAt: null,
      sentAt: new Date("2026-03-01T10:00:00.000Z"),
      lastEventType: null,
      lastEventAt: null,
      errorCode: null,
      errorMessage: null,
      createdAt: new Date("2026-03-01T10:00:00.000Z"),
      updatedAt: new Date("2026-03-01T10:00:00.000Z"),
    });
    const secondId = await db.create("email", {
      id: "re_second",
      status: "sent",
      from: basePayload.from,
      to: basePayload.to,
      subject: "Second",
      html: basePayload.html,
      text: null,
      cc: null,
      bcc: null,
      replyTo: null,
      tags: null,
      headers: null,
      scheduledAt: null,
      sentAt: new Date("2026-03-02T10:00:00.000Z"),
      lastEventType: null,
      lastEventAt: null,
      errorCode: null,
      errorMessage: null,
      createdAt: new Date("2026-03-02T10:00:00.000Z"),
      updatedAt: new Date("2026-03-02T10:00:00.000Z"),
    });
    const thirdId = await db.create("email", {
      id: "re_third",
      status: "sent",
      from: basePayload.from,
      to: basePayload.to,
      subject: "Third",
      html: basePayload.html,
      text: null,
      cc: null,
      bcc: null,
      replyTo: null,
      tags: null,
      headers: null,
      scheduledAt: null,
      sentAt: new Date("2026-03-03T10:00:00.000Z"),
      lastEventType: null,
      lastEventAt: null,
      errorCode: null,
      errorMessage: null,
      createdAt: new Date("2026-03-03T10:00:00.000Z"),
      updatedAt: new Date("2026-03-03T10:00:00.000Z"),
    });

    const firstPage = await fragment.callRoute("GET", "/emails", {
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

    const secondPage = await fragment.callRoute("GET", "/emails", {
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
    const emailId = await db.create("email", {
      status: "queued",
      from: "Acme <hello@example.com>",
      to: [],
      subject: "Empty to",
      html: "<p>Empty to</p>",
      text: null,
      cc: null,
      bcc: null,
      replyTo: null,
      tags: null,
      headers: null,
      scheduledAt: null,
      sentAt: null,
      lastEventType: null,
      lastEventAt: null,
      errorCode: null,
      errorMessage: null,
      createdAt: new Date("2026-03-01T12:00:00.000Z"),
      updatedAt: new Date("2026-03-01T12:00:00.000Z"),
    });

    const response = await fragment.callRoute("GET", "/emails");

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
    await db.create("email", {
      id: "re_sent",
      status: "sent",
      from: "Acme <hello@example.com>",
      to: ["user@example.com"],
      subject: "Sent",
      html: "<p>Sent</p>",
      text: null,
      cc: null,
      bcc: null,
      replyTo: null,
      tags: null,
      headers: null,
      scheduledAt: null,
      sentAt: new Date("2026-03-01T10:00:00.000Z"),
      lastEventType: null,
      lastEventAt: null,
      errorCode: null,
      errorMessage: null,
    });
    await db.create("email", {
      status: "failed",
      from: "Acme <hello@example.com>",
      to: ["user@example.com"],
      subject: "Failed",
      html: "<p>Failed</p>",
      text: null,
      cc: null,
      bcc: null,
      replyTo: null,
      tags: null,
      headers: null,
      scheduledAt: null,
      sentAt: null,
      lastEventType: null,
      lastEventAt: null,
      errorCode: "error",
      errorMessage: "Boom",
    });

    const response = await fragment.callRoute("GET", "/emails", {
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
    const emailId = await db.create("email", {
      id: "re_detail",
      status: "sent",
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
      scheduledAt: null,
      sentAt: new Date("2026-03-03T10:00:00.000Z"),
      lastEventType: "email.delivered",
      lastEventAt: new Date("2026-03-03T10:05:00.000Z"),
      errorCode: null,
      errorMessage: null,
      createdAt: new Date("2026-03-03T10:00:00.000Z"),
      updatedAt: new Date("2026-03-03T10:05:00.000Z"),
    });

    const response = await fragment.callRoute("GET", "/emails/:emailId", {
      pathParams: { emailId: emailId.valueOf() },
    });

    expect(response.type).toBe("json");
    if (response.type !== "json") {
      return;
    }

    expect(response.data.id).toBe(emailId.valueOf());
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
    const response = await fragment.callRoute("GET", "/emails/:emailId", {
      pathParams: { emailId: "missing-email" },
    });

    expect(response.type).toBe("error");
    if (response.type === "error") {
      expect(response.status).toBe(404);
      expect(response.error.code).toBe("EMAIL_NOT_FOUND");
    }
  });

  test("webhook updates email status and triggers callback", async () => {
    const resendId = "re_webhook";
    const emailId = await db.create("email", {
      id: resendId,
      status: "sent",
      from: "Acme <hello@example.com>",
      to: ["user@example.com"],
      subject: "Webhook",
      html: "<p>Webhook</p>",
      text: null,
      cc: null,
      bcc: null,
      replyTo: null,
      tags: null,
      headers: null,
      scheduledAt: null,
      sentAt: new Date(),
      lastEventType: null,
      lastEventAt: null,
      errorCode: null,
      errorMessage: null,
    });

    const event: WebhookEventPayload = {
      type: "email.delivered",
      created_at: new Date().toISOString(),
      data: {
        email_id: resendId,
        created_at: new Date().toISOString(),
        from: "Acme <hello@example.com>",
        to: ["user@example.com"],
        subject: "Webhook",
      },
    };

    const rawBody = JSON.stringify({ type: "email.delivered" });
    verifyMock.mockReturnValue(event);

    const response = await fragment.handler(
      new Request(`http://localhost${fragment.mountRoute}/resend/webhook`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "svix-id": "msg_1",
          "svix-timestamp": "ts_1",
          "svix-signature": "sig_1",
        },
        body: rawBody,
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ success: true });

    expect(verifyMock).toHaveBeenCalledWith({
      payload: rawBody,
      headers: {
        id: "msg_1",
        timestamp: "ts_1",
        signature: "sig_1",
      },
      webhookSecret: config.webhookSecret,
    });

    await drainDurableHooks(fragment);

    const updated = await getEmail(emailId.valueOf());
    expect(updated).toBeTruthy();
    if (!updated) {
      throw new Error("Expected updated email record");
    }
    expect(updated.status).toBe("delivered");
    expect(updated.lastEventType).toBe("email.delivered");
    expect(onEmailStatusUpdated).toHaveBeenCalledTimes(1);
    expect(onEmailStatusUpdated).toHaveBeenCalledWith(
      expect.objectContaining({
        emailId: emailId.valueOf(),
        resendId,
        status: "delivered",
        eventType: "email.delivered",
      }),
    );
  });

  test("webhook updates status when sentAt is missing", async () => {
    const resendId = "re_webhook_missing_sent";
    await db.create("email", {
      id: resendId,
      status: "sent",
      from: "Acme <hello@example.com>",
      to: ["user@example.com"],
      subject: "Webhook missing sent",
      html: "<p>Webhook</p>",
      text: null,
      cc: null,
      bcc: null,
      replyTo: null,
      tags: null,
      headers: null,
      scheduledAt: null,
      sentAt: null,
      lastEventType: null,
      lastEventAt: null,
      errorCode: null,
      errorMessage: null,
    });

    const event: WebhookEventPayload = {
      type: "email.delivered",
      created_at: new Date().toISOString(),
      data: {
        email_id: resendId,
        created_at: new Date().toISOString(),
        from: "Acme <hello@example.com>",
        to: ["user@example.com"],
        subject: "Webhook missing sent",
      },
    };

    const rawBody = JSON.stringify({ type: "email.delivered" });
    verifyMock.mockReturnValue(event);

    const response = await fragment.handler(
      new Request(`http://localhost${fragment.mountRoute}/resend/webhook`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "svix-id": "msg_3",
          "svix-timestamp": "ts_3",
          "svix-signature": "sig_3",
        },
        body: rawBody,
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ success: true });

    await drainDurableHooks(fragment);

    const updated = await getEmail(resendId);
    expect(updated).toBeTruthy();
    if (!updated) {
      throw new Error("Expected updated email record");
    }
    expect(updated.status).toBe("delivered");
    expect(updated.lastEventType).toBe("email.delivered");
    expect(updated.sentAt).toBeNull();
    expect(onEmailStatusUpdated).toHaveBeenCalledTimes(1);
    expect(onEmailStatusUpdated).toHaveBeenCalledWith(
      expect.objectContaining({
        emailId: resendId,
        resendId,
        status: "delivered",
        eventType: "email.delivered",
      }),
    );
  });

  test("webhook ignores out-of-order events", async () => {
    const resendId = "re_webhook_order";
    const lastEventAt = new Date("2026-03-03T10:05:00.000Z");
    const emailId = await db.create("email", {
      id: resendId,
      status: "delivered",
      from: "Acme <hello@example.com>",
      to: ["user@example.com"],
      subject: "Out of order",
      html: "<p>Out of order</p>",
      text: null,
      cc: null,
      bcc: null,
      replyTo: null,
      tags: null,
      headers: null,
      scheduledAt: null,
      sentAt: new Date("2026-03-03T10:00:00.000Z"),
      lastEventType: "email.delivered",
      lastEventAt,
      errorCode: null,
      errorMessage: null,
    });

    const event: WebhookEventPayload = {
      type: "email.sent",
      created_at: "2026-03-03T10:01:00.000Z",
      data: {
        email_id: resendId,
        created_at: "2026-03-03T10:00:00.000Z",
        from: "Acme <hello@example.com>",
        to: ["user@example.com"],
        subject: "Out of order",
      },
    };

    const rawBody = JSON.stringify({ type: "email.sent" });
    verifyMock.mockReturnValue(event);

    const response = await fragment.handler(
      new Request(`http://localhost${fragment.mountRoute}/resend/webhook`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "svix-id": "msg_2",
          "svix-timestamp": "ts_2",
          "svix-signature": "sig_2",
        },
        body: rawBody,
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ success: true });

    await drainDurableHooks(fragment);

    const updated = await getEmail(emailId.valueOf());
    expect(updated).toBeTruthy();
    if (!updated) {
      throw new Error("Expected updated email record");
    }
    expect(updated.status).toBe("delivered");
    expect(updated.lastEventType).toBe("email.delivered");
    expect(updated.lastEventAt?.getTime()).toBe(lastEventAt.getTime());
    expect(onEmailStatusUpdated).not.toHaveBeenCalled();
  });

  test("webhook rejects invalid signatures", async () => {
    verifyMock.mockImplementation(() => {
      throw new Error("invalid");
    });

    const response = await fragment.handler(
      new Request(`http://localhost${fragment.mountRoute}/resend/webhook`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "svix-id": "msg_1",
          "svix-timestamp": "ts_1",
          "svix-signature": "sig_1",
        },
        body: JSON.stringify({ type: "email.sent" }),
      }),
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.code).toBe("WEBHOOK_SIGNATURE_INVALID");
  });

  test("webhook rejects missing signature headers", async () => {
    const response = await fragment.handler(
      new Request(`http://localhost${fragment.mountRoute}/resend/webhook`, {
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

  test("webhook rejects missing request body", async () => {
    const response = await fragment.handler(
      new Request(`http://localhost${fragment.mountRoute}/resend/webhook`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "svix-id": "msg_1",
          "svix-timestamp": "ts_1",
          "svix-signature": "sig_1",
        },
      }),
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.code).toBe("WEBHOOK_ERROR");
  });

  test("rejects missing to address", async () => {
    const response = await fragment.callRoute("POST", "/emails", {
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
    const response = await fragment.callRoute("POST", "/emails", {
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
    config.defaultFrom = undefined;

    const response = await fragment.callRoute("POST", "/emails", {
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
