import { describe, expect, test, vi, assert } from "vitest";

import type { PiManagerRuntime } from "@/fragno/pi-manager/pi-manager-runtime";

import {
  createTrustedSystemBackofficeToolContext,
  type BackofficeToolContext,
} from "../runtime-tools";
import { piRuntimeTools } from "./pi";

const actors = {
  initiator: {
    scope: "internal" as const,
    type: "service",
    id: "pi-runtime-tool-test",
    role: "initiator" as const,
  },
  principal: null,
  delegation: [],
};

function createManagerSession(sessionId = "session-1") {
  return {
    name: "Support",
    model: { provider: "openai", modelId: "gpt-6-luna" },
    instructions: "Help the support team.",
    billingOrganizationId: null,
    scope: { kind: "system" as const },
    sessionId,
    actors,
  };
}

function createRuntimeSessionOutput(sessionId = "session-1") {
  return {
    sessionId,
    name: "Support",
    model: { provider: "openai", modelId: "gpt-6-luna" },
    instructions: "Help the support team.",
    billingOrganizationId: null,
  };
}

function createRuntime(): PiManagerRuntime {
  const session = createManagerSession();
  const directorySession = { ...session, createdAt: "2026-10-03T00:00:00.000Z" };
  return {
    createSession: vi.fn(async () => session),
    getSession: vi.fn(async () => ({
      ...directorySession,
      view: { conversation: { id: 1 } as never, entries: [], docs: {} },
    })),
    listSessions: vi.fn(async () => ({
      sessions: [directorySession],
      cursor: null,
      hasNextPage: false,
    })),
    submitPrompt: vi.fn(async () => ({ submissionId: 1, requestId: "request-1" })),
    getSubmission: vi.fn(async () => ({ status: "done" }) as never),
    runPrompt: vi.fn(async ({ content }) => ({
      ...directorySession,
      view: { conversation: { id: 1 } as never, entries: [], docs: {} },
      submission: { status: "done" } as never,
      assistantText: `echo: ${content}`,
    })),
    abortSession: vi.fn(async () => undefined),
  };
}

function createContext(runtime: PiManagerRuntime): BackofficeToolContext<{ pi: PiManagerRuntime }> {
  return createTrustedSystemBackofficeToolContext({ runtimes: { pi: runtime } });
}

describe("durable Pi runtime tools", () => {
  test("parses the durable session creation contract", () => {
    const createSessionTool = piRuntimeTools[0];

    expect(
      createSessionTool.inputSchema.parse(
        createSessionTool.adapters!.bash!.parse([
          "--request-id",
          "workflow-1:create-agent",
          "--model-json",
          '{"provider":"openai","modelId":"gpt-6-luna"}',
          "--name",
          "support",
          "--instructions",
          "Help the support team.",
        ]),
      ),
    ).toEqual({
      requestId: "workflow-1:create-agent",
      model: { provider: "openai", modelId: "gpt-6-luna" },
      name: "support",
      instructions: "Help the support team.",
    });
  });

  test("does not accept workflow-harness session options", () => {
    const createSessionTool = piRuntimeTools[0];
    assert(
      !createSessionTool.inputSchema.safeParse({
        model: { provider: "openai", modelId: "gpt-6-luna" },
        tags: ["legacy"],
      }).success,
    );
  });

  test("keeps session scope and actor provenance out of runtime results", async () => {
    const runtime = createRuntime();
    const directorySession = {
      ...createRuntimeSessionOutput(),
      createdAt: "2026-10-03T00:00:00.000Z",
    };
    const view = { conversation: { id: 1 }, entries: [], docs: {} };

    await expect(piRuntimeTools[0].execute({}, createContext(runtime))).resolves.toEqual(
      createRuntimeSessionOutput(),
    );
    await expect(
      piRuntimeTools[1].execute({ sessionId: "session-1" }, createContext(runtime)),
    ).resolves.toEqual({ ...directorySession, view });
    await expect(
      piRuntimeTools[2].execute({ pageSize: 10 }, createContext(runtime)),
    ).resolves.toEqual({
      sessions: [directorySession],
      cursor: null,
      hasNextPage: false,
    });

    expect(runtime.listSessions).toHaveBeenCalledWith({ pageSize: 10 });
  });

  test("admits and waits for a durable prompt", async () => {
    const runtime = createRuntime();
    await expect(
      piRuntimeTools[5].execute(
        { sessionId: "session-1", content: "Hello", requestId: "request-1" },
        createContext(runtime),
      ),
    ).resolves.toEqual({
      ...createRuntimeSessionOutput(),
      createdAt: "2026-10-03T00:00:00.000Z",
      view: { conversation: { id: 1 }, entries: [], docs: {} },
      submission: { status: "done" },
      assistantText: "echo: Hello",
    });
    expect(runtime.runPrompt).toHaveBeenCalledWith({
      sessionId: "session-1",
      content: "Hello",
      requestId: "request-1",
    });
  });

  test("aborts durable agent work", async () => {
    const runtime = createRuntime();
    await expect(
      piRuntimeTools[6].execute({ sessionId: "session-1" }, createContext(runtime)),
    ).resolves.toEqual({ aborted: true });
    expect(runtime.abortSession).toHaveBeenCalledWith({ sessionId: "session-1" });
  });
});
