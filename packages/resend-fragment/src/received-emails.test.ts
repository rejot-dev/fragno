import { afterAll, beforeEach, describe, expect, test } from "vitest";

import { createResendTestContext, receivingGetMock, receivingListMock } from "./test-context";

describe("resend-fragment received emails", async () => {
  const ctx = await createResendTestContext();
  const { callRoute } = ctx;

  beforeEach(async () => {
    await ctx.reset();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  test("lists received emails from the Resend API", async () => {
    receivingListMock.mockResolvedValue({
      data: {
        object: "list",
        has_more: false,
        data: [
          {
            id: "recv_123",
            from: "Acme <inbound@example.com>",
            to: ["hello@example.com"],
            cc: ["team@example.com"],
            bcc: [],
            reply_to: ["reply@example.com"],
            subject: "Inbound hello",
            message_id: "<message-123@example.com>",
            created_at: "2026-03-18T10:00:00.000Z",
            attachments: [
              {
                id: "att_123",
                filename: "avatar.png",
                size: 1234,
                content_type: "image/png",
                content_disposition: "inline",
                content_id: "img001",
              },
            ],
          },
        ],
      },
      error: null,
    });

    const response = await callRoute("GET", "/received-emails");

    expect(receivingListMock).toHaveBeenCalledWith({ limit: 50 });
    expect(response.type).toBe("json");
    if (response.type !== "json") {
      return;
    }

    expect(response.data).toEqual({
      emails: [
        {
          id: "recv_123",
          from: "Acme <inbound@example.com>",
          to: ["hello@example.com"],
          cc: ["team@example.com"],
          bcc: [],
          replyTo: ["reply@example.com"],
          subject: "Inbound hello",
          messageId: "<message-123@example.com>",
          attachments: [
            {
              id: "att_123",
              filename: "avatar.png",
              size: 1234,
              contentType: "image/png",
              contentDisposition: "inline",
              contentId: "img001",
            },
          ],
          attachmentCount: 1,
          createdAt: "2026-03-18T10:00:00.000Z",
        },
      ],
      hasNextPage: false,
    });
  });

  test("fetches received email detail from the Resend API", async () => {
    receivingGetMock.mockResolvedValue({
      data: {
        object: "email",
        id: "recv_detail",
        from: "Acme <inbound@example.com>",
        to: ["support@example.com"],
        cc: [],
        bcc: ["audit@example.com"],
        reply_to: ["reply@example.com"],
        subject: "Inbound detail",
        message_id: "<message-detail@example.com>",
        created_at: "2026-03-18T11:00:00.000Z",
        html: "<p>Hello inbound</p>",
        text: "Hello inbound",
        headers: {
          "x-custom": "value",
        },
        raw: {
          download_url: "https://example.com/raw.eml",
          expires_at: "2026-03-18T12:00:00.000Z",
        },
        attachments: [
          {
            id: "att_detail",
            filename: "report.pdf",
            size: 9876,
            content_type: "application/pdf",
            content_disposition: "attachment",
            content_id: null,
          },
        ],
      },
      error: null,
      headers: null,
    });

    const response = await callRoute("GET", "/received-emails/:emailId", {
      pathParams: { emailId: "recv_detail" },
    });

    expect(receivingGetMock).toHaveBeenCalledWith("recv_detail");
    expect(response.type).toBe("json");
    if (response.type !== "json") {
      return;
    }

    expect(response.data).toEqual({
      id: "recv_detail",
      from: "Acme <inbound@example.com>",
      to: ["support@example.com"],
      cc: [],
      bcc: ["audit@example.com"],
      replyTo: ["reply@example.com"],
      subject: "Inbound detail",
      messageId: "<message-detail@example.com>",
      attachments: [
        {
          id: "att_detail",
          filename: "report.pdf",
          size: 9876,
          contentType: "application/pdf",
          contentDisposition: "attachment",
          contentId: null,
        },
      ],
      attachmentCount: 1,
      createdAt: "2026-03-18T11:00:00.000Z",
      html: "<p>Hello inbound</p>",
      text: "Hello inbound",
      headers: {
        "x-custom": "value",
      },
      raw: {
        downloadUrl: "https://example.com/raw.eml",
        expiresAt: "2026-03-18T12:00:00.000Z",
      },
    });
  });
});
