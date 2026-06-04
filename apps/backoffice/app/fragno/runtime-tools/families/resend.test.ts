import { describe, expect, test, vi } from "vitest";

import type { BackofficeToolContext } from "../runtime-tools";
import { resendRuntimeTools, type ResendRuntime } from "./resend";

const now = new Date("2026-06-03T00:00:00.000Z");

const createThread = (id: string) => ({
  id,
  subject: "Question",
  normalizedSubject: "question",
  participants: [],
  messageCount: 0,
  firstMessageAt: now,
  lastMessageAt: now,
  lastDirection: null,
  lastMessagePreview: null,
  createdAt: now,
  updatedAt: now,
  replyToAddress: null,
});

const createMessage = (threadId: string) => ({
  id: "message-1",
  threadId,
  direction: "outbound" as const,
  status: "queued",
  from: "support@example.com",
  to: ["customer@example.com"],
  cc: [],
  bcc: [],
  replyTo: [],
  subject: "Question",
  normalizedSubject: "question",
  participants: ["support@example.com", "customer@example.com"],
  messageId: null,
  inReplyTo: null,
  references: [],
  providerEmailId: null,
  attachments: [],
  html: null,
  text: "Thanks",
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
});

const createRuntime = (): ResendRuntime =>
  ({
    listThreads: vi.fn(async () => ({ threads: [], hasNextPage: false })),
    getThread: vi.fn(async ({ threadId }) => createThread(threadId)),
    listThreadMessages: vi.fn(async () => ({ messages: [], hasNextPage: false })),
    getThreadSnapshot: vi.fn(async ({ threadId }) => ({
      thread: createThread(threadId),
      messages: [],
      hasNextPage: false,
      markdown: "# Question",
    })),
    replyToThread: vi.fn(async ({ threadId }) => ({
      thread: createThread(threadId),
      message: createMessage(threadId),
    })),
  }) as unknown as ResendRuntime;

describe("resend runtime tools", () => {
  test("define camelCase codemode names and legacy bash commands", () => {
    expect(resendRuntimeTools.map((tool) => [tool.name, tool.adapters?.bash?.command])).toEqual([
      ["getThread", "resend.threads.get"],
      ["listThreads", "resend.threads.list"],
      ["replyToThread", "resend.threads.reply"],
    ]);
  });

  test("parse and validate thread list input", () => {
    const listThreads = resendRuntimeTools[1];

    expect(
      listThreads.inputSchema.parse(
        listThreads.adapters!.bash!.parse([
          "--order",
          "desc",
          "--page-size",
          "10",
          "--cursor",
          "next",
        ]),
      ),
    ).toEqual({ order: "desc", pageSize: 10, cursor: "next" });
  });

  test("invokes the semantic runtime for codemode", async () => {
    const runtime = createRuntime();
    const context: BackofficeToolContext<{ resend: ResendRuntime }> = {
      runtimes: { resend: runtime },
    };

    await expect(
      resendRuntimeTools[2].execute({ threadId: "thread-1", body: "Thanks" }, context),
    ).resolves.toMatchObject({
      thread: { id: "thread-1", firstMessageAt: "2026-06-03T00:00:00.000Z" },
      message: { threadId: "thread-1", text: "Thanks" },
    });
    expect(runtime.replyToThread).toHaveBeenCalledWith({ threadId: "thread-1", body: "Thanks" });
  });

  test("formats resend.threads.get as markdown by default", async () => {
    const runtime = createRuntime();
    const context: BackofficeToolContext<{ resend: ResendRuntime }> = {
      runtimes: { resend: runtime },
    };
    const getThread = resendRuntimeTools[0];
    const output = await getThread.execute({ threadId: "thread-1" }, context);

    expect(getThread.adapters!.bash!.format!(output, { format: "text" })).toMatchObject({
      data: output,
      stdout: "# Question\n",
    });
  });
});
