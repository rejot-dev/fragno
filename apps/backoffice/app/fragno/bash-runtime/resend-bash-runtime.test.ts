import { describe, expect, it } from "vitest";

import { InMemoryFs } from "just-bash";

import { createBashHost, EMPTY_BASH_HOST_CONTEXT } from "./bash-host";
import { createRouteBackedResendRuntime, type ResendBashRuntime } from "./resend-bash-runtime";

const now = new Date("2026-01-02T12:00:00.000Z");

const createResendRuntime = (overrides: Partial<ResendBashRuntime> = {}): ResendBashRuntime => ({
  listThreads: async () => ({
    threads: [],
    hasNextPage: false,
  }),
  getThread: async ({ threadId }) => ({
    id: threadId,
    subject: "Invoice Update",
    normalizedSubject: "invoice update",
    participants: ["customer@example.com", "support@example.com"],
    messageCount: 2,
    firstMessageAt: now,
    lastMessageAt: now,
    lastDirection: "inbound",
    lastMessagePreview: "Thanks for the update",
    createdAt: now,
    updatedAt: now,
    replyToAddress: "reply@example.com",
  }),
  listThreadMessages: async () => ({
    messages: [],
    hasNextPage: false,
  }),
  getThreadSnapshot: async ({ threadId }) => ({
    thread: {
      id: threadId,
      subject: "Invoice Update",
      normalizedSubject: "invoice update",
      participants: ["customer@example.com", "support@example.com"],
      messageCount: 2,
      firstMessageAt: now,
      lastMessageAt: now,
      lastDirection: "inbound",
      lastMessagePreview: "Thanks for the update",
      createdAt: now,
      updatedAt: now,
      replyToAddress: "reply@example.com",
    },
    messages: [
      {
        id: "message-1",
        threadId,
        direction: "outbound",
        status: "sent",
        from: "support@example.com",
        to: ["customer@example.com"],
        cc: [],
        bcc: [],
        replyTo: [],
        subject: "Invoice Update",
        normalizedSubject: "invoice update",
        participants: ["customer@example.com", "support@example.com"],
        messageId: null,
        inReplyTo: null,
        references: [],
        providerEmailId: "provider-1",
        attachments: [],
        html: null,
        text: "Hello there",
        headers: null,
        occurredAt: now,
        scheduledAt: null,
        sentAt: now,
        lastEventType: null,
        lastEventAt: null,
        errorCode: null,
        errorMessage: null,
        createdAt: now,
        updatedAt: now,
      },
    ],
    hasNextPage: false,
    markdown: "# Invoice Update\n\n## Messages\n",
  }),
  replyToThread: async ({ threadId, subject, body }) => ({
    thread: {
      id: threadId,
      subject: subject ?? "Invoice Update",
      normalizedSubject: "invoice update",
      participants: ["customer@example.com", "support@example.com"],
      messageCount: 3,
      firstMessageAt: now,
      lastMessageAt: now,
      lastDirection: "outbound",
      lastMessagePreview: body,
      createdAt: now,
      updatedAt: now,
      replyToAddress: "reply@example.com",
    },
    message: {
      id: "message-reply-1",
      threadId,
      direction: "outbound",
      status: "queued",
      from: "support@example.com",
      to: ["customer@example.com"],
      cc: [],
      bcc: [],
      replyTo: [],
      subject: subject ?? "Invoice Update",
      normalizedSubject: "invoice update",
      participants: ["customer@example.com", "support@example.com"],
      messageId: null,
      inReplyTo: null,
      references: [],
      providerEmailId: null,
      attachments: [],
      html: null,
      text: body,
      headers: null,
      occurredAt: now,
      scheduledAt: null,
      sentAt: null,
      lastEventType: null,
      lastEventAt: null,
      errorCode: null,
      errorMessage: null,
      createdAt: now,
      updatedAt: now,
    },
  }),
  ...overrides,
});

describe("resend bash runtime", () => {
  it("renders markdown by default for resend.threads.get", async () => {
    const { bash, commandCallsResult } = createBashHost({
      fs: new InMemoryFs(),
      context: {
        ...EMPTY_BASH_HOST_CONTEXT,
        resend: {
          runtime: createResendRuntime(),
        },
      },
    });

    const result = await bash.exec("resend.threads.get --thread-id thread-1");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("# Invoice Update");
    expect(commandCallsResult).toEqual([
      {
        command: "resend.threads.get",
        output: expect.stringContaining("# Invoice Update"),
        exitCode: 0,
      },
    ]);
  });

  it("returns structured json when requested from resend.threads.get", async () => {
    const { bash } = createBashHost({
      fs: new InMemoryFs(),
      context: {
        ...EMPTY_BASH_HOST_CONTEXT,
        resend: {
          runtime: createResendRuntime(),
        },
      },
    });

    const result = await bash.exec("resend.threads.get --thread-id thread-1 --format json");

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      thread: {
        id: "thread-1",
        replyToAddress: "reply@example.com",
      },
      hasNextPage: false,
      markdown: expect.stringContaining("# Invoice Update"),
    });
  });

  it("lists threads as json by default", async () => {
    const { bash, commandCallsResult } = createBashHost({
      fs: new InMemoryFs(),
      context: {
        ...EMPTY_BASH_HOST_CONTEXT,
        resend: {
          runtime: createResendRuntime({
            listThreads: async () => ({
              threads: [
                {
                  id: "thread-1",
                  subject: "Invoice Update",
                  normalizedSubject: "invoice update",
                  participants: ["customer@example.com", "support@example.com"],
                  messageCount: 2,
                  firstMessageAt: now,
                  lastMessageAt: now,
                  lastDirection: "inbound",
                  lastMessagePreview: "Thanks for the update",
                  createdAt: now,
                  updatedAt: now,
                },
              ],
              hasNextPage: false,
            }),
          }),
        },
      },
    });

    const result = await bash.exec("resend.threads.list --page-size 10");

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      threads: [
        {
          id: "thread-1",
          subject: "Invoice Update",
        },
      ],
      hasNextPage: false,
    });
    expect(commandCallsResult).toEqual([
      {
        command: "resend.threads.list",
        output: expect.stringContaining('"threads"'),
        exitCode: 0,
      },
    ]);
  });

  it("replies to a thread and returns structured json by default", async () => {
    const { bash, commandCallsResult } = createBashHost({
      fs: new InMemoryFs(),
      context: {
        ...EMPTY_BASH_HOST_CONTEXT,
        resend: {
          runtime: createResendRuntime(),
        },
      },
    });

    const result = await bash.exec(
      'resend.threads.reply --thread-id thread-1 --subject "Re: Invoice Update" --body "Thanks for the update"',
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      thread: {
        id: "thread-1",
      },
      message: {
        threadId: "thread-1",
        text: "Thanks for the update",
        subject: "Re: Invoice Update",
      },
    });
    expect(commandCallsResult).toEqual([
      {
        command: "resend.threads.reply",
        output: expect.stringContaining('"message"'),
        exitCode: 0,
      },
    ]);
  });

  it("loads thread detail and messages from the route-backed resend runtime", async () => {
    const requests: string[] = [];
    const runtime = createRouteBackedResendRuntime({
      baseUrl: "https://resend.do",
      fetch: async (request) => {
        const url = new URL(request.url);
        requests.push(`${request.method} ${url.pathname}${url.search}`);

        if (url.pathname === "/api/resend/threads/thread-1") {
          return Response.json({
            id: "thread-1",
            subject: "Invoice Update",
            normalizedSubject: "invoice update",
            participants: ["customer@example.com", "support@example.com"],
            messageCount: 2,
            firstMessageAt: now,
            lastMessageAt: now,
            lastDirection: "inbound",
            lastMessagePreview: "Thanks for the update",
            createdAt: now,
            updatedAt: now,
            replyToAddress: "reply@example.com",
          });
        }

        if (url.pathname === "/api/resend/threads/thread-1/messages") {
          return Response.json({
            messages: [
              {
                id: "message-1",
                threadId: "thread-1",
                direction: "outbound",
                status: "sent",
                from: "support@example.com",
                to: ["customer@example.com"],
                cc: [],
                bcc: [],
                replyTo: [],
                subject: "Invoice Update",
                normalizedSubject: "invoice update",
                participants: ["customer@example.com", "support@example.com"],
                messageId: null,
                inReplyTo: null,
                references: [],
                providerEmailId: "provider-1",
                attachments: [],
                html: null,
                text: "Hello there",
                headers: null,
                occurredAt: now,
                scheduledAt: null,
                sentAt: now,
                lastEventType: null,
                lastEventAt: null,
                errorCode: null,
                errorMessage: null,
                createdAt: now,
                updatedAt: now,
              },
            ],
            hasNextPage: false,
          });
        }

        return Response.json({ message: "Not found", code: "THREAD_NOT_FOUND" }, { status: 404 });
      },
    });

    const snapshot = await runtime.getThreadSnapshot({
      threadId: "thread-1",
      order: "asc",
      pageSize: 25,
    });

    expect(snapshot).toMatchObject({
      thread: {
        id: "thread-1",
        replyToAddress: "reply@example.com",
      },
      messages: [
        {
          id: "message-1",
          threadId: "thread-1",
        },
      ],
      hasNextPage: false,
      markdown: expect.stringContaining("# Invoice Update"),
    });
    expect(requests).toEqual([
      "GET /api/resend/threads/thread-1",
      "GET /api/resend/threads/thread-1/messages?pageSize=25&order=asc",
    ]);
  });

  it("posts replies through the route-backed resend runtime", async () => {
    const requests: Array<{ method: string; path: string; body?: unknown }> = [];
    const runtime = createRouteBackedResendRuntime({
      baseUrl: "https://resend.do",
      fetch: async (request) => {
        const url = new URL(request.url);
        const body = request.method === "POST" ? await request.json() : undefined;
        requests.push({
          method: request.method,
          path: `${url.pathname}${url.search}`,
          body,
        });

        if (url.pathname === "/api/resend/threads/thread-1" && request.method === "GET") {
          return Response.json({
            id: "thread-1",
            subject: "Invoice Update",
            normalizedSubject: "invoice update",
            participants: ["customer@example.com", "support@example.com"],
            messageCount: 2,
            firstMessageAt: now,
            lastMessageAt: now,
            lastDirection: "inbound",
            lastMessagePreview: "Can you help?",
            createdAt: now,
            updatedAt: now,
            replyToAddress: "reply@example.com",
          });
        }

        if (url.pathname === "/api/resend/threads/thread-1/messages" && request.method === "GET") {
          return Response.json({
            messages: [
              {
                id: "message-inbound-1",
                threadId: "thread-1",
                direction: "inbound",
                status: "received",
                from: "customer@example.com",
                to: ["support@example.com"],
                cc: [],
                bcc: [],
                replyTo: ["customer-reply@example.com"],
                subject: "Invoice Update",
                normalizedSubject: "invoice update",
                participants: ["customer@example.com", "support@example.com"],
                messageId: null,
                inReplyTo: null,
                references: [],
                providerEmailId: null,
                attachments: [],
                html: null,
                text: "Can you help?",
                headers: null,
                occurredAt: now,
                scheduledAt: null,
                sentAt: now,
                lastEventType: null,
                lastEventAt: null,
                errorCode: null,
                errorMessage: null,
                createdAt: now,
                updatedAt: now,
              },
            ],
            hasNextPage: false,
          });
        }

        if (url.pathname === "/api/resend/threads/thread-1/reply") {
          return Response.json({
            thread: {
              id: "thread-1",
              subject: "Re: Invoice Update",
              normalizedSubject: "invoice update",
              participants: ["customer@example.com", "support@example.com"],
              messageCount: 3,
              firstMessageAt: now,
              lastMessageAt: now,
              lastDirection: "outbound",
              lastMessagePreview: "Thanks for the update",
              createdAt: now,
              updatedAt: now,
              replyToAddress: "reply@example.com",
            },
            message: {
              id: "message-reply-1",
              threadId: "thread-1",
              direction: "outbound",
              status: "queued",
              from: "support@example.com",
              to: ["customer-reply@example.com"],
              cc: [],
              bcc: [],
              replyTo: [],
              subject: "Re: Invoice Update",
              normalizedSubject: "invoice update",
              participants: ["customer@example.com", "support@example.com"],
              messageId: null,
              inReplyTo: null,
              references: [],
              providerEmailId: null,
              attachments: [],
              html: null,
              text: "Thanks for the update",
              headers: null,
              occurredAt: now,
              scheduledAt: null,
              sentAt: null,
              lastEventType: null,
              lastEventAt: null,
              errorCode: null,
              errorMessage: null,
              createdAt: now,
              updatedAt: now,
            },
          });
        }

        return Response.json({ message: "Not found", code: "THREAD_NOT_FOUND" }, { status: 404 });
      },
    });

    const reply = await runtime.replyToThread({
      threadId: "thread-1",
      subject: "Re: Invoice Update",
      body: "Thanks for the update",
    });

    expect(reply).toMatchObject({
      thread: { id: "thread-1" },
      message: {
        threadId: "thread-1",
        text: "Thanks for the update",
        subject: "Re: Invoice Update",
      },
    });
    expect(requests).toEqual([
      {
        method: "GET",
        path: "/api/resend/threads/thread-1",
        body: undefined,
      },
      {
        method: "GET",
        path: "/api/resend/threads/thread-1/messages?pageSize=100&order=desc",
        body: undefined,
      },
      {
        method: "POST",
        path: "/api/resend/threads/thread-1/reply",
        body: {
          to: ["customer-reply@example.com"],
          subject: "Re: Invoice Update",
          text: "Thanks for the update",
        },
      },
    ]);
  });
});
