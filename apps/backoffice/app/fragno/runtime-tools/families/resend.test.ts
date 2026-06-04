import { describe, expect, test, vi } from "vitest";

import type { BackofficeToolContext } from "../runtime-tools";
import { resendRuntimeTools, type ResendRuntime } from "./resend";

const createRuntime = (): ResendRuntime =>
  ({
    listThreads: vi.fn(async () => ({ threads: [], hasNextPage: false })),
    getThread: vi.fn(async ({ threadId }) => ({
      id: threadId,
      subject: "Question",
      participants: [],
      messageCount: 0,
      firstMessageAt: null,
      lastMessageAt: null,
      lastDirection: null,
      replyToAddress: null,
    })),
    listThreadMessages: vi.fn(async () => ({ messages: [], hasNextPage: false })),
    getThreadSnapshot: vi.fn(async ({ threadId }) => ({
      thread: {
        id: threadId,
        subject: "Question",
        participants: [],
        messageCount: 0,
        firstMessageAt: null,
        lastMessageAt: null,
        lastDirection: null,
        replyToAddress: null,
      },
      messages: [],
      hasNextPage: false,
      markdown: "# Question",
    })),
    replyToThread: vi.fn(async ({ threadId }) => ({ threadId, queued: true })),
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
    ).resolves.toEqual({ threadId: "thread-1", queued: true });
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
