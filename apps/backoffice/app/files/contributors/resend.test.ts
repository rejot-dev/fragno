import { beforeEach, describe, expect, test, vi } from "vitest";

import { type MountedFileSystem } from "@/files";

import { resendFileContributor } from "./resend";

let threadSummaries: Array<{
  id: string;
  subject: string;
  normalizedSubject: string;
  participants: string[];
  messageCount: number;
  firstMessageAt: Date;
  lastMessageAt: Date;
  lastDirection: "inbound" | "outbound";
  lastMessagePreview: string | null;
  createdAt: Date;
  updatedAt: Date;
}> = [];
let threadMessages = new Map<string, ResendThreadMessageLike[]>();
let resendRequestHandler: (request: Request) => Response | Promise<Response> = () => {
  return Response.json({ message: "No handler configured." }, { status: 500 });
};

type ResendThreadMessageLike = {
  id: string;
  threadId: string;
  direction: "inbound" | "outbound";
  status: string;
  from: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  replyTo: string[];
  subject: string | null;
  normalizedSubject: string | null;
  participants: string[];
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  providerEmailId: string | null;
  attachments: unknown[];
  html: string | null;
  text: string | null;
  headers: Record<string, string> | null;
  occurredAt: Date | null;
  scheduledAt: Date | null;
  sentAt: Date | null;
  lastEventType: string | null;
  lastEventAt: Date | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
};

vi.mock("@/cloudflare/cloudflare-utils", () => ({
  getResendDurableObject: () => ({
    fetch: (request: Request) => resendRequestHandler(request),
  }),
}));

beforeEach(() => {
  threadSummaries = [
    {
      id: "thread-1",
      subject: "Invoice Update",
      normalizedSubject: "invoice update",
      participants: ["customer@example.com", "support@example.com"],
      messageCount: 2,
      firstMessageAt: new Date("2026-01-01T10:00:00.000Z"),
      lastMessageAt: new Date("2026-01-02T12:00:00.000Z"),
      lastDirection: "outbound",
      lastMessagePreview: null,
      createdAt: new Date("2026-01-01T10:00:00.000Z"),
      updatedAt: new Date("2026-01-02T12:00:00.000Z"),
    },
  ];
  threadMessages = new Map([
    [
      "thread-1",
      [
        {
          id: "m-1",
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
          participants: ["support@example.com", "customer@example.com"],
          messageId: null,
          inReplyTo: null,
          references: [],
          providerEmailId: "provider-msg-1",
          attachments: [],
          html: null,
          text: "Hello there",
          headers: null,
          occurredAt: new Date("2026-01-01T10:00:00.000Z"),
          scheduledAt: null,
          sentAt: new Date("2026-01-01T10:00:00.000Z"),
          lastEventType: null,
          lastEventAt: null,
          errorCode: null,
          errorMessage: null,
          createdAt: new Date("2026-01-01T10:00:00.000Z"),
          updatedAt: new Date("2026-01-01T10:00:00.000Z"),
        },
        {
          id: "m-2",
          threadId: "thread-1",
          direction: "inbound",
          status: "received",
          from: "customer@example.com",
          to: ["support@example.com"],
          cc: [],
          bcc: [],
          replyTo: [],
          subject: "Re: Invoice Update",
          normalizedSubject: "re: invoice update",
          participants: ["support@example.com", "customer@example.com"],
          messageId: null,
          inReplyTo: null,
          references: [],
          providerEmailId: null,
          attachments: [],
          html: null,
          text: "Thanks for the update",
          headers: null,
          occurredAt: new Date("2026-01-02T12:00:00.000Z"),
          scheduledAt: null,
          sentAt: null,
          lastEventType: null,
          lastEventAt: null,
          errorCode: null,
          errorMessage: null,
          createdAt: new Date("2026-01-02T12:00:00.000Z"),
          updatedAt: new Date("2026-01-02T12:00:00.000Z"),
        },
      ],
    ],
  ]);

  resendRequestHandler = (request: Request) => {
    const url = new URL(request.url);
    if (url.pathname === "/api/resend/threads") {
      return Response.json({
        threads: threadSummaries,
        hasNextPage: false,
      } as const);
    }

    const match = url.pathname.match(/^\/api\/resend\/threads\/([^/]+)\/messages$/);
    if (match) {
      const threadId = decodeURIComponent(match[1] ?? "");
      return Response.json({
        messages: threadMessages.get(threadId) ?? [],
        hasNextPage: false,
      } as const);
    }

    return Response.json({ message: "Not found" }, { status: 404 });
  };
});

describe("resend file contributor", () => {
  test("createFileSystem returns null when resendRuntime is not provided", () => {
    const resolved = resendFileContributor.createFileSystem?.({
      orgId: "org_123",
    });

    expect(resolved).toBeNull();
  });

  test("accepts an injected resend runtime", async () => {
    const resolved = await resendFileContributor.createFileSystem?.({
      orgId: "org_123",
      resendRuntime: {
        baseUrl: "https://pi.internal",
        fetch: async (request: Request) => await resendRequestHandler(request),
      },
    });

    expect(resolved).not.toBeNull();
    if (!resolved) {
      throw new Error("Expected contributor filesystem to be resolved.");
    }

    const fs = ("fs" in resolved ? resolved.fs : resolved) as MountedFileSystem;
    await expect(fs.readdir("/resend")).resolves.toEqual(["thread-1.md"]);
  });

  test("loads thread list and renders markdown files", async () => {
    const resolved = await resendFileContributor.createFileSystem?.({
      orgId: "org_123",
      resendRuntime: {
        baseUrl: "https://pi.internal",
        fetch: async (request: Request) => await resendRequestHandler(request),
      },
    });

    expect(resolved).not.toBeNull();
    if (!resolved) {
      throw new Error("Expected contributor filesystem to be resolved.");
    }

    const fs = ("fs" in resolved ? resolved.fs : resolved) as MountedFileSystem;
    const markdown = await fs.readFile("/resend/thread-1.md");
    await expect(fs.readdir("/resend")).resolves.toEqual(["thread-1.md"]);

    expect(markdown).toContain("# Invoice Update");
    expect(markdown).toContain("### Message 1: Outbound (you sent)");
    expect(markdown).toContain("### Message 2: Inbound (received)");
    expect(markdown).toContain("- **From:** support@example.com");
    expect(markdown).toContain("- **From:** customer@example.com");

    const detail = await fs.describeEntry?.("/resend/thread-1.md");
    expect(detail).toMatchObject({
      kind: "file",
      path: "/resend/thread-1.md",
      metadata: {
        messageCount: 2,
        threadId: "thread-1",
      },
    });
    expect(fs.getAllPaths()).toEqual(["/resend"]);
  });

  test("reads fresh thread lists and thread content on every access", async () => {
    const resolved = await resendFileContributor.createFileSystem?.({
      orgId: "org_123",
      backend: "pi",
      resendRuntime: {
        baseUrl: "https://pi.internal",
        fetch: async (request: Request) => await resendRequestHandler(request),
      },
    });

    expect(resolved).not.toBeNull();
    if (!resolved) {
      throw new Error("Expected contributor filesystem to be resolved.");
    }

    const fs = ("fs" in resolved ? resolved.fs : resolved) as MountedFileSystem;

    await expect(fs.readdir("/resend")).resolves.toEqual(["thread-1.md"]);
    await expect(fs.readFile("/resend/thread-1.md")).resolves.toContain("Thanks for the update");

    threadSummaries = [
      {
        ...threadSummaries[0]!,
        messageCount: 3,
        lastDirection: "inbound",
        lastMessageAt: new Date("2026-01-03T09:00:00.000Z"),
        updatedAt: new Date("2026-01-03T09:00:00.000Z"),
      },
      {
        id: "thread-2",
        subject: "New Thread",
        normalizedSubject: "new thread",
        participants: ["new@example.com", "support@example.com"],
        messageCount: 1,
        firstMessageAt: new Date("2026-01-03T11:00:00.000Z"),
        lastMessageAt: new Date("2026-01-03T11:00:00.000Z"),
        lastDirection: "inbound",
        lastMessagePreview: "Fresh message",
        createdAt: new Date("2026-01-03T11:00:00.000Z"),
        updatedAt: new Date("2026-01-03T11:00:00.000Z"),
      },
    ];
    threadMessages.set("thread-1", [
      ...(threadMessages.get("thread-1") ?? []),
      {
        id: "m-3",
        threadId: "thread-1",
        direction: "inbound",
        status: "received",
        from: "customer@example.com",
        to: ["support@example.com"],
        cc: [],
        bcc: [],
        replyTo: [],
        subject: "Re: Invoice Update",
        normalizedSubject: "re: invoice update",
        participants: ["support@example.com", "customer@example.com"],
        messageId: null,
        inReplyTo: null,
        references: [],
        providerEmailId: null,
        attachments: [],
        html: null,
        text: "One more update",
        headers: null,
        occurredAt: new Date("2026-01-03T09:00:00.000Z"),
        scheduledAt: null,
        sentAt: null,
        lastEventType: null,
        lastEventAt: null,
        errorCode: null,
        errorMessage: null,
        createdAt: new Date("2026-01-03T09:00:00.000Z"),
        updatedAt: new Date("2026-01-03T09:00:00.000Z"),
      },
    ]);
    threadMessages.set("thread-2", [
      {
        id: "m-4",
        threadId: "thread-2",
        direction: "inbound",
        status: "received",
        from: "new@example.com",
        to: ["support@example.com"],
        cc: [],
        bcc: [],
        replyTo: [],
        subject: "New Thread",
        normalizedSubject: "new thread",
        participants: ["new@example.com", "support@example.com"],
        messageId: null,
        inReplyTo: null,
        references: [],
        providerEmailId: null,
        attachments: [],
        html: null,
        text: "Fresh message",
        headers: null,
        occurredAt: new Date("2026-01-03T11:00:00.000Z"),
        scheduledAt: null,
        sentAt: null,
        lastEventType: null,
        lastEventAt: null,
        errorCode: null,
        errorMessage: null,
        createdAt: new Date("2026-01-03T11:00:00.000Z"),
        updatedAt: new Date("2026-01-03T11:00:00.000Z"),
      },
    ]);

    await expect(fs.readdir("/resend")).resolves.toEqual(["thread-2.md", "thread-1.md"]);
    await expect(fs.readFile("/resend/thread-1.md")).resolves.toContain("One more update");
    await expect(fs.readFile("/resend/thread-2.md")).resolves.toContain("Fresh message");
  });
});
