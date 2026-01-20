import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { buildDatabaseFragmentsTest } from "@fragno-dev/test";
import { instantiate } from "@fragno-dev/core";
import { aiFragmentDefinition } from "./definition";
import { aiRoutesFactory } from "./routes";
import { createAiRunner } from "./runner";
import OpenAI from "openai";

const mockOpenAIStreamEvents = [
  { type: "response.created", response: { id: "resp_test" } },
  {
    type: "response.output_item.added",
    item: {
      id: "item_call_1",
      type: "function_call",
      name: "lookupWeather",
      call_id: "call_1",
    },
  },
  {
    type: "response.function_call_arguments.delta",
    call_id: "call_1",
    delta: '{"location":"SF"',
  },
  {
    type: "response.function_call_arguments.done",
    call_id: "call_1",
    arguments: '{"location":"SF"}',
  },
  {
    type: "response.output_item.done",
    item: {
      id: "item_call_1",
      type: "function_call",
      name: "lookupWeather",
      call_id: "call_1",
      status: "completed",
      output: { ok: true },
    },
  },
  { type: "response.output_text.delta", delta: "Hello " },
  { type: "response.output_text.delta", delta: "world" },
  { type: "response.output_text.done", text: "Hello world" },
];

let nextOpenAIStreamFactory:
  | ((requestOptions?: { signal?: AbortSignal }) => AsyncIterable<Record<string, unknown>>)
  | null = null;

const mockOpenAICreate = vi.fn(
  async (
    _options?: unknown,
    requestOptions?: { signal?: AbortSignal },
  ): Promise<Record<string, unknown> | AsyncIterable<Record<string, unknown>>> => {
    if (nextOpenAIStreamFactory) {
      const factory = nextOpenAIStreamFactory;
      nextOpenAIStreamFactory = null;
      return factory(requestOptions);
    }

    async function* stream() {
      for (const event of mockOpenAIStreamEvents) {
        await Promise.resolve();
        yield event;
      }
    }

    return stream();
  },
);

const mockOpenAIRetrieve = vi.fn(async (id: string): Promise<Record<string, unknown>> => {
  return {
    id,
    output_text: "Recovered response",
    status: "completed",
  };
});

const mockOpenAIWebhookUnwrap = vi.fn(async (): Promise<Record<string, unknown>> => {
  return {
    id: "evt_test",
    type: "response.completed",
    data: { id: "resp_test" },
  };
});

vi.mock("openai", () => {
  class InvalidWebhookSignatureError extends Error {}

  return {
    default: class MockOpenAI {
      static InvalidWebhookSignatureError = InvalidWebhookSignatureError;

      responses = {
        create: mockOpenAICreate,
        retrieve: mockOpenAIRetrieve,
      };

      webhooks = {
        unwrap: mockOpenAIWebhookUnwrap,
      };
    },
  };
});

describe("AI Fragment Routes", () => {
  const dispatcher = {
    wake: vi.fn(),
  };

  const setup = async () => {
    const config = {
      defaultModel: { id: "gpt-test" },
      apiKey: "test-key",
      webhookSecret: "whsec_test",
      defaultDeepResearchModel: { id: "gpt-deep-research" },
      dispatcher,
    };
    const { fragments, test: testContext } = await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "drizzle-pglite" })
      .withFragment(
        "ai",
        instantiate(aiFragmentDefinition).withConfig(config).withRoutes([aiRoutesFactory]),
      )
      .build();

    return { fragments, testContext, config };
  };

  type Setup = Awaited<ReturnType<typeof setup>>;

  let testContext: Setup["testContext"];
  let fragment: Setup["fragments"]["ai"]["fragment"];
  let db: Setup["fragments"]["ai"]["db"];
  let config: Setup["config"];

  beforeAll(async () => {
    const setupResult = await setup();
    testContext = setupResult.testContext;
    fragment = setupResult.fragments.ai.fragment;
    db = setupResult.fragments.ai.db;
    config = setupResult.config;
  });

  beforeEach(async () => {
    await testContext.resetDatabase();
    nextOpenAIStreamFactory = null;
    dispatcher.wake.mockReset();
  });

  test("threads routes should create and list threads", async () => {
    const created = await fragment.callRoute("POST", "/threads", {
      body: { title: "Thread One" },
    });

    expect(created.type).toBe("json");
    if (created.type !== "json") {
      return;
    }

    const threadId = created.data.id;
    expect(created.data.defaultModelId).toBe("gpt-test");

    const listed = await fragment.callRoute("GET", "/threads");
    expect(listed.type).toBe("json");
    if (listed.type === "json") {
      expect(listed.data.threads).toHaveLength(1);
      expect(listed.data.threads[0]?.id).toBe(threadId);
    }

    const fetched = await fragment.callRoute("GET", "/threads/:threadId", {
      pathParams: { threadId },
    });
    expect(fetched.type).toBe("json");
    if (fetched.type === "json") {
      expect(fetched.data.id).toBe(threadId);
      expect(fetched.data.title).toBe("Thread One");
    }
  });

  test("messages routes should append and list messages", async () => {
    const thread = await fragment.callRoute("POST", "/threads", {
      body: { title: "Thread Two" },
    });

    expect(thread.type).toBe("json");
    if (thread.type !== "json") {
      return;
    }

    const message = await fragment.callRoute("POST", "/threads/:threadId/messages", {
      pathParams: { threadId: thread.data.id },
      body: {
        role: "user",
        content: { type: "text", text: "Hello" },
        text: "Hello",
      },
    });

    expect(message.type).toBe("json");
    if (message.type !== "json") {
      return;
    }

    const listed = await fragment.callRoute("GET", "/threads/:threadId/messages", {
      pathParams: { threadId: thread.data.id },
    });
    expect(listed.type).toBe("json");
    if (listed.type === "json") {
      expect(listed.data.messages).toHaveLength(1);
      expect(listed.data.messages[0]?.id).toBe(message.data.id);
    }
  });

  test("runs routes should create, list, get, and cancel runs", async () => {
    const thread = await fragment.callRoute("POST", "/threads", {
      body: { title: "Thread Three" },
    });
    expect(thread.type).toBe("json");
    if (thread.type !== "json") {
      return;
    }

    const message = await fragment.callRoute("POST", "/threads/:threadId/messages", {
      pathParams: { threadId: thread.data.id },
      body: {
        role: "user",
        content: { type: "text", text: "Run it" },
        text: "Run it",
      },
    });
    expect(message.type).toBe("json");
    if (message.type !== "json") {
      return;
    }

    const run = await fragment.callRoute("POST", "/threads/:threadId/runs", {
      pathParams: { threadId: thread.data.id },
      body: { inputMessageId: message.data.id, type: "agent" },
    });
    expect(run.type).toBe("json");
    if (run.type !== "json") {
      return;
    }

    const listed = await fragment.callRoute("GET", "/threads/:threadId/runs", {
      pathParams: { threadId: thread.data.id },
    });
    expect(listed.type).toBe("json");
    if (listed.type === "json") {
      expect(listed.data.runs).toHaveLength(1);
      expect(listed.data.runs[0]?.id).toBe(run.data.id);
    }

    const fetched = await fragment.callRoute("GET", "/runs/:runId", {
      pathParams: { runId: run.data.id },
    });
    expect(fetched.type).toBe("json");
    if (fetched.type === "json") {
      expect(fetched.data.id).toBe(run.data.id);
      expect(fetched.data.status).toBe(run.data.status);
    }

    const cancelled = await fragment.callRoute("POST", "/runs/:runId/cancel", {
      pathParams: { runId: run.data.id },
    });
    expect(cancelled.type).toBe("json");
    if (cancelled.type === "json") {
      expect(cancelled.data.status).toBe("cancelled");
    }
  });

  test("runs route should reject foreground stream executionMode", async () => {
    const thread = await fragment.callRoute("POST", "/threads", {
      body: { title: "Invalid Run Thread" },
    });
    expect(thread.type).toBe("json");
    if (thread.type !== "json") {
      return;
    }

    const message = await fragment.callRoute("POST", "/threads/:threadId/messages", {
      pathParams: { threadId: thread.data.id },
      body: {
        role: "user",
        content: { type: "text", text: "Bad run" },
        text: "Bad run",
      },
    });
    expect(message.type).toBe("json");
    if (message.type !== "json") {
      return;
    }

    const response = await fragment.handler(
      new Request(`http://localhost/api/ai/threads/${thread.data.id}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          inputMessageId: message.data.id,
          type: "agent",
          executionMode: "foreground_stream",
        }),
      }),
    );

    expect(response.status).toBe(400);
  });

  test("runs stream route should reject deep research runs", async () => {
    const thread = await fragment.callRoute("POST", "/threads", {
      body: { title: "Invalid Stream Thread" },
    });
    expect(thread.type).toBe("json");
    if (thread.type !== "json") {
      return;
    }

    const message = await fragment.callRoute("POST", "/threads/:threadId/messages", {
      pathParams: { threadId: thread.data.id },
      body: {
        role: "user",
        content: { type: "text", text: "Stream deep research" },
        text: "Stream deep research",
      },
    });
    expect(message.type).toBe("json");
    if (message.type !== "json") {
      return;
    }

    const response = await fragment.handler(
      new Request(`http://localhost/api/ai/threads/${thread.data.id}/runs:stream`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          inputMessageId: message.data.id,
          type: "deep_research",
        }),
      }),
    );

    expect(response.status).toBe(400);
  });

  test("admin delete run should remove run data", async () => {
    const thread = await fragment.callRoute("POST", "/threads", {
      body: { title: "Thread Run Delete" },
    });
    expect(thread.type).toBe("json");
    if (thread.type !== "json") {
      return;
    }

    const message = await fragment.callRoute("POST", "/threads/:threadId/messages", {
      pathParams: { threadId: thread.data.id },
      body: {
        role: "user",
        content: { type: "text", text: "Delete run" },
        text: "Delete run",
      },
    });
    expect(message.type).toBe("json");
    if (message.type !== "json") {
      return;
    }

    const run = await fragment.callRoute("POST", "/threads/:threadId/runs", {
      pathParams: { threadId: thread.data.id },
      body: {
        inputMessageId: message.data.id,
        type: "agent",
      },
    });
    expect(run.type).toBe("json");
    if (run.type !== "json") {
      return;
    }

    const now = new Date();
    await db.create("ai_run_event", {
      runId: run.data.id,
      threadId: thread.data.id,
      seq: 1,
      type: "run.meta",
      payload: { runId: run.data.id },
      createdAt: now,
    });
    await db.create("ai_tool_call", {
      runId: run.data.id,
      threadId: thread.data.id,
      toolCallId: "call-1",
      toolName: "demo",
      args: { input: "ok" },
      status: "completed",
      result: { ok: true },
      isError: 0,
      createdAt: now,
      updatedAt: now,
    });
    await db.create("ai_artifact", {
      runId: run.data.id,
      threadId: thread.data.id,
      type: "deep_research_report",
      title: "Report",
      mimeType: "text/markdown",
      storageKey: null,
      storageMeta: null,
      data: { content: "Hello" },
      text: "Hello",
      createdAt: now,
      updatedAt: now,
    });

    const deleted = await fragment.callRoute("DELETE", "/admin/runs/:runId", {
      pathParams: { runId: run.data.id },
    });
    expect(deleted.type).toBe("json");
    if (deleted.type !== "json") {
      return;
    }
    expect(deleted.data.ok).toBe(true);

    const storedRun = await db.findFirst("ai_run", (b) =>
      b.whereIndex("primary", (eb) => eb("id", "=", run.data.id)),
    );
    expect(storedRun).toBeNull();

    const runEvents = await db.find("ai_run_event", (b) =>
      b.whereIndex("idx_ai_run_event_run_seq", (eb) => eb("runId", "=", run.data.id)),
    );
    expect(runEvents).toHaveLength(0);

    const toolCalls = await db.find("ai_tool_call", (b) =>
      b.whereIndex("idx_ai_tool_call_run_toolCallId", (eb) => eb("runId", "=", run.data.id)),
    );
    expect(toolCalls).toHaveLength(0);

    const artifacts = await db.find("ai_artifact", (b) =>
      b.whereIndex("idx_ai_artifact_run_createdAt", (eb) => eb("runId", "=", run.data.id)),
    );
    expect(artifacts).toHaveLength(0);
  });

  test("runs stream route should stream events and finalize run", async () => {
    const thread = await fragment.callRoute("POST", "/threads", {
      body: {
        title: "Stream Thread",
        openaiToolConfig: {
          tools: [{ type: "web_search" }],
          tool_choice: "auto",
        },
      },
    });
    expect(thread.type).toBe("json");
    if (thread.type !== "json") {
      return;
    }

    const message = await fragment.callRoute("POST", "/threads/:threadId/messages", {
      pathParams: { threadId: thread.data.id },
      body: {
        role: "user",
        content: { type: "text", text: "Stream it" },
        text: "Stream it",
      },
    });
    expect(message.type).toBe("json");
    if (message.type !== "json") {
      return;
    }

    const response = await fragment.callRoute("POST", "/threads/:threadId/runs:stream", {
      pathParams: { threadId: thread.data.id },
      body: { inputMessageId: message.data.id, type: "agent" },
    });
    expect(response.type).toBe("jsonStream");
    if (response.type !== "jsonStream") {
      return;
    }

    const events = [];
    for await (const event of response.stream) {
      events.push(event);
    }

    expect(events[0]).toMatchObject({ type: "run.meta", threadId: thread.data.id });
    expect(events.some((event) => event.type === "tool.call.started")).toBe(true);
    expect(events.some((event) => event.type === "tool.call.arguments.delta")).toBe(true);
    expect(events.some((event) => event.type === "tool.call.arguments.done")).toBe(true);
    expect(events.some((event) => event.type === "tool.call.output")).toBe(true);
    expect(
      events.some((event) => event.type === "tool.call.status" && event.status === "in_progress"),
    ).toBe(true);
    expect(
      events.some((event) => event.type === "tool.call.status" && event.status === "completed"),
    ).toBe(true);
    expect(events.some((event) => event.type === "output.text.delta")).toBe(true);
    expect(events.some((event) => event.type === "output.text.done")).toBe(true);
    expect(events[events.length - 1]).toMatchObject({ type: "run.final", status: "succeeded" });

    const runs = await db.find("ai_run", (b) => b.whereIndex("primary"));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("succeeded");
    expect(runs[0]?.openaiResponseId).toBe("resp_test");

    const messages = await db.find("ai_message", (b) => b.whereIndex("primary"));
    expect(messages.some((msg) => msg.role === "assistant")).toBe(true);

    const runId = runs[0] ? String(runs[0].id) : "";
    const runEvents = await db.find("ai_run_event", (b) => b.whereIndex("primary"));
    const runEventTypes = runEvents
      .filter((event) => event.runId === runId)
      .sort((a, b) => a.seq - b.seq)
      .map((event) => event.type);
    expect(runEventTypes).toEqual(["run.meta", "run.status", "output.text.done", "run.final"]);

    expect(mockOpenAICreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-test",
        stream: true,
        tools: [{ type: "web_search" }],
        tool_choice: "auto",
      }),
      expect.objectContaining({
        idempotencyKey: `ai-run:${runId}:attempt:1`,
        signal: expect.any(AbortSignal),
      }),
    );
  });

  test("runs stream route should honor tool policy denials", async () => {
    mockOpenAICreate.mockClear();
    const toolPolicy = vi.fn().mockResolvedValue({ action: "deny", reason: "POLICY_DENIED" });
    const { fragments } = await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "drizzle-pglite" })
      .withFragment(
        "ai",
        instantiate(aiFragmentDefinition)
          .withConfig({ ...config, toolPolicy })
          .withRoutes([aiRoutesFactory]),
      )
      .build();

    const localFragment = fragments.ai.fragment;
    const localDb = fragments.ai.db;

    const thread = await localFragment.callRoute("POST", "/threads", {
      body: {
        title: "Policy Stream Thread",
        openaiToolConfig: { tools: [{ type: "web_search" }], tool_choice: "auto" },
      },
    });
    expect(thread.type).toBe("json");
    if (thread.type !== "json") {
      return;
    }

    const message = await localFragment.callRoute("POST", "/threads/:threadId/messages", {
      pathParams: { threadId: thread.data.id },
      body: {
        role: "user",
        content: { type: "text", text: "Policy check" },
        text: "Policy check",
      },
    });
    expect(message.type).toBe("json");
    if (message.type !== "json") {
      return;
    }

    const response = await localFragment.callRoute("POST", "/threads/:threadId/runs:stream", {
      pathParams: { threadId: thread.data.id },
      body: { inputMessageId: message.data.id, type: "agent" },
    });
    expect(response.type).toBe("jsonStream");
    if (response.type !== "jsonStream") {
      return;
    }

    const events = [];
    for await (const event of response.stream) {
      events.push(event);
    }

    expect(events[events.length - 1]).toMatchObject({ type: "run.final", status: "failed" });
    expect(mockOpenAICreate).not.toHaveBeenCalled();
    expect(toolPolicy).toHaveBeenCalledWith(expect.objectContaining({ threadId: thread.data.id }));

    const storedRun = await localDb.findFirst("ai_run", (b) =>
      b.whereIndex("idx_ai_run_thread_createdAt", (eb) => eb("threadId", "=", thread.data.id)),
    );
    expect(storedRun?.status).toBe("failed");
    expect(storedRun?.error).toBe("POLICY_DENIED");
  });

  test("runs stream route should preserve reasoning tool config", async () => {
    mockOpenAICreate.mockClear();

    const thread = await fragment.callRoute("POST", "/threads", {
      body: {
        title: "Reasoning Thread",
        openaiToolConfig: {
          reasoning: { effort: "high", summary: "concise" },
        },
      },
    });
    expect(thread.type).toBe("json");
    if (thread.type !== "json") {
      return;
    }

    const message = await fragment.callRoute("POST", "/threads/:threadId/messages", {
      pathParams: { threadId: thread.data.id },
      body: {
        role: "user",
        content: { type: "text", text: "Keep reasoning config" },
        text: "Keep reasoning config",
      },
    });
    expect(message.type).toBe("json");
    if (message.type !== "json") {
      return;
    }

    const response = await fragment.callRoute("POST", "/threads/:threadId/runs:stream", {
      pathParams: { threadId: thread.data.id },
      body: { inputMessageId: message.data.id, type: "agent" },
    });
    expect(response.type).toBe("jsonStream");
    if (response.type !== "jsonStream") {
      return;
    }

    for await (const _event of response.stream) {
      // Drain stream for completion.
    }

    expect(mockOpenAICreate).toHaveBeenCalled();
    const [options] = mockOpenAICreate.mock.calls[0] ?? [];
    expect(options).toMatchObject({
      reasoning: { effort: "high", summary: "concise" },
    });
  });

  test("runs stream route should cap history and honor inputMessageId", async () => {
    mockOpenAICreate.mockClear();
    const { fragments } = await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "drizzle-pglite" })
      .withFragment(
        "ai",
        instantiate(aiFragmentDefinition)
          .withConfig({ ...config, history: { maxMessages: 2 } })
          .withRoutes([aiRoutesFactory]),
      )
      .build();

    const localFragment = fragments.ai.fragment;

    const thread = await localFragment.callRoute("POST", "/threads", {
      body: { title: "History Stream Thread" },
    });
    expect(thread.type).toBe("json");
    if (thread.type !== "json") {
      return;
    }

    await localFragment.callRoute("POST", "/threads/:threadId/messages", {
      pathParams: { threadId: thread.data.id },
      body: {
        role: "user",
        content: { type: "text", text: "one" },
        text: "one",
      },
    });

    await localFragment.callRoute("POST", "/threads/:threadId/messages", {
      pathParams: { threadId: thread.data.id },
      body: {
        role: "assistant",
        content: { type: "text", text: "two" },
        text: "two",
      },
    });

    const messageThree = await localFragment.callRoute("POST", "/threads/:threadId/messages", {
      pathParams: { threadId: thread.data.id },
      body: {
        role: "user",
        content: { type: "text", text: "three" },
        text: "three",
      },
    });
    expect(messageThree.type).toBe("json");
    if (messageThree.type !== "json") {
      return;
    }

    await localFragment.callRoute("POST", "/threads/:threadId/messages", {
      pathParams: { threadId: thread.data.id },
      body: {
        role: "user",
        content: { type: "text", text: "four" },
        text: "four",
      },
    });

    const response = await localFragment.callRoute("POST", "/threads/:threadId/runs:stream", {
      pathParams: { threadId: thread.data.id },
      body: { inputMessageId: messageThree.data.id, type: "agent" },
    });
    expect(response.type).toBe("jsonStream");
    if (response.type !== "jsonStream") {
      return;
    }

    for await (const _event of response.stream) {
      // Drain stream for completion.
    }

    expect(mockOpenAICreate).toHaveBeenCalled();
    const [options] = mockOpenAICreate.mock.calls.at(-1) ?? [];
    const input = (options as { input?: unknown } | undefined)?.input;
    expect(input).toEqual([
      { role: "assistant", content: "two" },
      { role: "user", content: "three" },
    ]);
  });

  test("runs stream route should compact history when compactor is provided", async () => {
    mockOpenAICreate.mockClear();
    const compactor = vi.fn(
      (_context: { truncatedMessages: Array<{ role: string; content: string }> }) => ({
        summary: "Summary: one",
      }),
    );
    const { fragments } = await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "drizzle-pglite" })
      .withFragment(
        "ai",
        instantiate(aiFragmentDefinition)
          .withConfig({ ...config, history: { maxMessages: 2, compactor } })
          .withRoutes([aiRoutesFactory]),
      )
      .build();

    const localFragment = fragments.ai.fragment;

    const thread = await localFragment.callRoute("POST", "/threads", {
      body: { title: "Compact Stream Thread" },
    });
    expect(thread.type).toBe("json");
    if (thread.type !== "json") {
      return;
    }

    await localFragment.callRoute("POST", "/threads/:threadId/messages", {
      pathParams: { threadId: thread.data.id },
      body: {
        role: "user",
        content: { type: "text", text: "one" },
        text: "one",
      },
    });

    await localFragment.callRoute("POST", "/threads/:threadId/messages", {
      pathParams: { threadId: thread.data.id },
      body: {
        role: "assistant",
        content: { type: "text", text: "two" },
        text: "two",
      },
    });

    const messageThree = await localFragment.callRoute("POST", "/threads/:threadId/messages", {
      pathParams: { threadId: thread.data.id },
      body: {
        role: "user",
        content: { type: "text", text: "three" },
        text: "three",
      },
    });
    expect(messageThree.type).toBe("json");
    if (messageThree.type !== "json") {
      return;
    }

    const response = await localFragment.callRoute("POST", "/threads/:threadId/runs:stream", {
      pathParams: { threadId: thread.data.id },
      body: { inputMessageId: messageThree.data.id, type: "agent" },
    });
    expect(response.type).toBe("jsonStream");
    if (response.type !== "jsonStream") {
      return;
    }

    for await (const _event of response.stream) {
      // Drain stream for completion.
    }

    expect(compactor).toHaveBeenCalledTimes(1);
    const context = compactor.mock.calls[0]?.[0] as
      | { truncatedMessages?: Array<{ role: string; content: string }> }
      | undefined;
    expect(context?.truncatedMessages).toEqual([{ role: "user", content: "one" }]);

    const [options] = mockOpenAICreate.mock.calls.at(-1) ?? [];
    const input = (options as { input?: unknown } | undefined)?.input;
    expect(input).toEqual([
      { role: "system", content: "Summary: one" },
      { role: "assistant", content: "two" },
      { role: "user", content: "three" },
    ]);
  });

  test("runs stream route should persist final message after client disconnect", async () => {
    const thread = await fragment.callRoute("POST", "/threads", {
      body: { title: "Disconnect Thread" },
    });
    expect(thread.type).toBe("json");
    if (thread.type !== "json") {
      return;
    }

    const message = await fragment.callRoute("POST", "/threads/:threadId/messages", {
      pathParams: { threadId: thread.data.id },
      body: {
        role: "user",
        content: { type: "text", text: "Disconnect test" },
        text: "Disconnect test",
      },
    });
    expect(message.type).toBe("json");
    if (message.type !== "json") {
      return;
    }

    const response = await fragment.callRouteRaw("POST", "/threads/:threadId/runs:stream", {
      pathParams: { threadId: thread.data.id },
      body: { inputMessageId: message.data.id, type: "agent" },
    });
    expect(response.headers.get("content-type") || "").toContain("application/x-ndjson");

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("Missing response body reader");
    }

    await reader.read();
    await reader.cancel();
    reader.releaseLock();

    const waitFor = async (check: () => Promise<boolean>) => {
      const startedAt = Date.now();
      while (Date.now() - startedAt < 1000) {
        if (await check()) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("Run did not finalize in time");
    };

    await waitFor(async () => {
      const runs = await db.find("ai_run", (b) => b.whereIndex("primary"));
      return runs.length > 0 && runs[0]?.status === "succeeded";
    });

    const messages = await db.find("ai_message", (b) => b.whereIndex("primary"));
    expect(messages.some((msg) => msg.role === "assistant")).toBe(true);
  });

  test("runs stream route should recover when stream fails after response id", async () => {
    nextOpenAIStreamFactory = async function* () {
      yield { type: "response.created", response: { id: "resp_recover" } };
      await Promise.resolve();
      throw new Error("Stream failed");
    };

    const thread = await fragment.callRoute("POST", "/threads", {
      body: { title: "Recover Thread" },
    });
    expect(thread.type).toBe("json");
    if (thread.type !== "json") {
      return;
    }

    const message = await fragment.callRoute("POST", "/threads/:threadId/messages", {
      pathParams: { threadId: thread.data.id },
      body: {
        role: "user",
        content: { type: "text", text: "Recover test" },
        text: "Recover test",
      },
    });
    expect(message.type).toBe("json");
    if (message.type !== "json") {
      return;
    }

    const response = await fragment.callRoute("POST", "/threads/:threadId/runs:stream", {
      pathParams: { threadId: thread.data.id },
      body: { inputMessageId: message.data.id, type: "agent" },
    });
    expect(response.type).toBe("jsonStream");
    if (response.type !== "jsonStream") {
      return;
    }

    for await (const _event of response.stream) {
      // Drain stream; recovery happens server-side.
    }

    expect(mockOpenAIRetrieve).toHaveBeenCalledWith("resp_recover");

    const runs = await db.find("ai_run", (b) => b.whereIndex("primary"));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("succeeded");

    const messages = await db.find("ai_message", (b) => b.whereIndex("primary"));
    expect(messages.some((msg) => msg.text === "Recovered response")).toBe(true);
  });

  test("runs stream route should queue retry when stream breaks before response id", async () => {
    nextOpenAIStreamFactory = async function* () {
      yield { type: "response.output_text.delta", delta: "Partial " };
      throw new Error("Stream failed early");
    };

    const thread = await fragment.callRoute("POST", "/threads", {
      body: { title: "Early Failure Thread" },
    });
    expect(thread.type).toBe("json");
    if (thread.type !== "json") {
      return;
    }

    const message = await fragment.callRoute("POST", "/threads/:threadId/messages", {
      pathParams: { threadId: thread.data.id },
      body: {
        role: "user",
        content: { type: "text", text: "Early failure test" },
        text: "Early failure test",
      },
    });
    expect(message.type).toBe("json");
    if (message.type !== "json") {
      return;
    }

    const response = await fragment.callRoute("POST", "/threads/:threadId/runs:stream", {
      pathParams: { threadId: thread.data.id },
      body: { inputMessageId: message.data.id, type: "agent" },
    });
    expect(response.type).toBe("jsonStream");
    if (response.type !== "jsonStream") {
      return;
    }

    const events: Array<{ type: string; status?: string }> = [];
    for await (const event of response.stream) {
      events.push(event as { type: string; status?: string });
    }

    expect(events[events.length - 1]).toMatchObject({ type: "run.final", status: "queued" });

    const runs = await db.find("ai_run", (b) => b.whereIndex("primary"));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("queued");
    expect(runs[0]?.openaiResponseId).toBeNull();
    expect(runs[0]?.attempt).toBe(2);
    expect(runs[0]?.nextAttemptAt).toBeTruthy();
    expect(dispatcher.wake).toHaveBeenCalledWith({
      type: "run.queued",
      runId: runs[0]?.id.toString(),
    });

    const messages = await db.find("ai_message", (b) => b.whereIndex("primary"));
    expect(messages.some((msg) => msg.role === "assistant")).toBe(false);
  });

  test("runs stream route should cancel in-process run", async () => {
    nextOpenAIStreamFactory = (requestOptions) => {
      async function* stream() {
        yield { type: "response.created", response: { id: "resp_cancel" } };

        const signal = requestOptions?.signal;
        if (!signal) {
          throw new Error("Abort signal missing");
        }

        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener("abort", () => resolve(), { once: true });
        });

        const abortError = new Error("Aborted");
        abortError.name = "AbortError";
        throw abortError;
      }

      return stream();
    };

    const thread = await fragment.callRoute("POST", "/threads", {
      body: { title: "Cancel Stream Thread" },
    });
    expect(thread.type).toBe("json");
    if (thread.type !== "json") {
      return;
    }

    const message = await fragment.callRoute("POST", "/threads/:threadId/messages", {
      pathParams: { threadId: thread.data.id },
      body: {
        role: "user",
        content: { type: "text", text: "Cancel stream" },
        text: "Cancel stream",
      },
    });
    expect(message.type).toBe("json");
    if (message.type !== "json") {
      return;
    }

    const response = await fragment.callRoute("POST", "/threads/:threadId/runs:stream", {
      pathParams: { threadId: thread.data.id },
      body: { inputMessageId: message.data.id, type: "agent" },
    });
    expect(response.type).toBe("jsonStream");
    if (response.type !== "jsonStream") {
      return;
    }

    const iterator = response.stream[Symbol.asyncIterator]();
    const first = await iterator.next();
    const runMeta = first.value;
    expect(runMeta).toMatchObject({ type: "run.meta" });

    if (runMeta && runMeta.type === "run.meta") {
      await fragment.callRoute("POST", "/runs/:runId/cancel", {
        pathParams: { runId: runMeta.runId },
      });
    }

    const remainingEvents = [];
    while (true) {
      const next = await iterator.next();
      if (next.done) {
        break;
      }
      remainingEvents.push(next.value);
    }

    const finalEvent = remainingEvents[remainingEvents.length - 1];
    expect(finalEvent).toMatchObject({ type: "run.final", status: "cancelled" });

    const runs = await db.find("ai_run", (b) => b.whereIndex("primary"));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("cancelled");
  });

  test("run events route should list persisted run events", async () => {
    const thread = await fragment.callRoute("POST", "/threads", {
      body: { title: "Thread Four" },
    });
    expect(thread.type).toBe("json");
    if (thread.type !== "json") {
      return;
    }

    const message = await fragment.callRoute("POST", "/threads/:threadId/messages", {
      pathParams: { threadId: thread.data.id },
      body: {
        role: "user",
        content: { type: "text", text: "Run events" },
        text: "Run events",
      },
    });
    expect(message.type).toBe("json");
    if (message.type !== "json") {
      return;
    }

    const run = await fragment.callRoute("POST", "/threads/:threadId/runs", {
      pathParams: { threadId: thread.data.id },
      body: { inputMessageId: message.data.id, type: "agent" },
    });
    expect(run.type).toBe("json");
    if (run.type !== "json") {
      return;
    }

    await db.create("ai_run_event", {
      runId: run.data.id,
      threadId: thread.data.id,
      seq: 1,
      type: "run.meta",
      payload: { ok: true },
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });

    await db.create("ai_run_event", {
      runId: run.data.id,
      threadId: thread.data.id,
      seq: 2,
      type: "run.final",
      payload: { ok: true },
      createdAt: new Date("2024-01-01T00:00:01Z"),
    });

    const events = await fragment.callRoute("GET", "/runs/:runId/events", {
      pathParams: { runId: run.data.id },
    });
    expect(events.type).toBe("json");
    if (events.type === "json") {
      expect(events.data.events).toHaveLength(2);
      expect(events.data.events[0]?.seq).toBe(1);
      expect(events.data.events[1]?.seq).toBe(2);
    }
  });

  test("artifact routes should list and fetch artifacts", async () => {
    const thread = await fragment.callRoute("POST", "/threads", {
      body: { title: "Thread Five" },
    });
    expect(thread.type).toBe("json");
    if (thread.type !== "json") {
      return;
    }

    const message = await fragment.callRoute("POST", "/threads/:threadId/messages", {
      pathParams: { threadId: thread.data.id },
      body: {
        role: "user",
        content: { type: "text", text: "Artifacts" },
        text: "Artifacts",
      },
    });
    expect(message.type).toBe("json");
    if (message.type !== "json") {
      return;
    }

    const run = await fragment.callRoute("POST", "/threads/:threadId/runs", {
      pathParams: { threadId: thread.data.id },
      body: { inputMessageId: message.data.id, type: "agent" },
    });
    expect(run.type).toBe("json");
    if (run.type !== "json") {
      return;
    }

    const now = new Date("2024-01-01T00:00:00Z");
    const artifactId = await db.create("ai_artifact", {
      runId: run.data.id,
      threadId: thread.data.id,
      type: "deep_research_report",
      title: "Report",
      mimeType: "text/markdown",
      storageKey: null,
      storageMeta: null,
      data: { markdown: "Hello" },
      text: "Hello",
      createdAt: now,
      updatedAt: now,
    });

    const artifacts = await fragment.callRoute("GET", "/runs/:runId/artifacts", {
      pathParams: { runId: run.data.id },
    });
    expect(artifacts.type).toBe("json");
    if (artifacts.type === "json") {
      expect(artifacts.data.artifacts).toHaveLength(1);
      expect(artifacts.data.artifacts[0]?.id).toBe(artifactId.toString());
    }

    const artifact = await fragment.callRoute("GET", "/artifacts/:artifactId", {
      pathParams: { artifactId: artifactId.toString() },
    });
    expect(artifact.type).toBe("json");
    if (artifact.type === "json") {
      expect(artifact.data.id).toBe(artifactId.toString());
      expect(artifact.data.title).toBe("Report");
    }
  });

  test("webhooks route should verify and store OpenAI events", async () => {
    mockOpenAIWebhookUnwrap.mockResolvedValueOnce({
      id: "evt_123",
      type: "response.completed",
      data: { id: "resp_123" },
    });

    const request = new Request("http://localhost/api/ai/webhooks/openai", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "webhook-id": "wh_123",
        "webhook-timestamp": "123",
        "webhook-signature": "sig",
      },
      body: JSON.stringify({ test: true }),
    });

    const response = await fragment.handler(request);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });

    const events = await db.find("ai_openai_webhook_event", (b) => b.whereIndex("primary"));
    expect(events).toHaveLength(1);
    expect(events[0]?.openaiEventId).toBe("evt_123");
    expect(events[0]?.responseId).toBe("resp_123");
    expect(events[0]?.type).toBe("response.completed");
    expect(events[0]?.payload).toEqual({ redacted: true });
  });

  test("webhooks route should honor rate limiting", async () => {
    const rateLimiter = vi.fn().mockReturnValue(false);
    const { fragments } = await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "drizzle-pglite" })
      .withFragment(
        "ai",
        instantiate(aiFragmentDefinition)
          .withConfig({ ...config, rateLimiter })
          .withRoutes([aiRoutesFactory]),
      )
      .build();

    const request = new Request("http://localhost/api/ai/webhooks/openai", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "webhook-id": "wh_rate",
        "webhook-timestamp": "123",
        "webhook-signature": "sig",
      },
      body: JSON.stringify({}),
    });

    const response = await fragments.ai.fragment.handler(request);
    expect(response.status).toBe(429);
    expect(rateLimiter).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "webhook_openai", headers: expect.any(Headers) }),
    );

    const events = await fragments.ai.db.find("ai_openai_webhook_event", (b) =>
      b.whereIndex("primary"),
    );
    expect(events).toHaveLength(0);
  });

  test("webhooks route should persist raw payload when enabled", async () => {
    mockOpenAIWebhookUnwrap.mockResolvedValueOnce({
      id: "evt_raw",
      type: "response.completed",
      data: { id: "resp_raw" },
      extra: { detail: "payload" },
    });

    const { fragments: rawFragments } = await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "drizzle-pglite" })
      .withFragment(
        "ai",
        instantiate(aiFragmentDefinition)
          .withConfig({
            defaultModel: { id: "gpt-test" },
            apiKey: "test-key",
            webhookSecret: "whsec_test",
            storage: { persistOpenAIRawResponses: true },
          })
          .withRoutes([aiRoutesFactory]),
      )
      .build();

    const request = new Request("http://localhost/api/ai/webhooks/openai", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "webhook-id": "wh_raw",
        "webhook-timestamp": "123",
        "webhook-signature": "sig",
      },
      body: JSON.stringify({ test: true }),
    });

    const response = await rawFragments.ai.fragment.handler(request);
    expect(response.status).toBe(200);

    const events = await rawFragments.ai.db.find("ai_openai_webhook_event", (b) =>
      b.whereIndex("primary"),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      id: "evt_raw",
      type: "response.completed",
      data: { id: "resp_raw" },
      extra: { detail: "payload" },
    });
  });

  test("webhooks route should reject invalid signatures", async () => {
    mockOpenAIWebhookUnwrap.mockRejectedValueOnce(
      new OpenAI.InvalidWebhookSignatureError("bad signature"),
    );

    const request = new Request("http://localhost/api/ai/webhooks/openai", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "webhook-id": "wh_456",
        "webhook-timestamp": "456",
        "webhook-signature": "bad",
      },
      body: JSON.stringify({ test: false }),
    });

    const response = await fragment.handler(request);
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: "INVALID_SIGNATURE" });

    const events = await db.find("ai_openai_webhook_event", (b) => b.whereIndex("primary"));
    expect(events).toHaveLength(0);
  });

  test("deep research webhook should persist artifact after runner tick", async () => {
    const thread = await fragment.callRoute("POST", "/threads", {
      body: { title: "Deep Research Thread" },
    });
    expect(thread.type).toBe("json");
    if (thread.type !== "json") {
      return;
    }

    const threadId = thread.data.id;
    const message = await fragment.callRoute("POST", "/threads/:threadId/messages", {
      pathParams: { threadId },
      body: {
        role: "user",
        content: { type: "text", text: "Investigate this" },
        text: "Investigate this",
      },
    });
    expect(message.type).toBe("json");
    if (message.type !== "json") {
      return;
    }

    const run = await fragment.callRoute("POST", "/threads/:threadId/runs", {
      pathParams: { threadId },
      body: {
        type: "deep_research",
        executionMode: "background",
        inputMessageId: message.data.id,
      },
    });
    expect(run.type).toBe("json");
    if (run.type !== "json") {
      return;
    }

    mockOpenAICreate.mockResolvedValueOnce({ id: "resp_deep_e2e" });
    const runner = createAiRunner({ db, config });
    await runner.tick({ maxRuns: 1 });

    mockOpenAIWebhookUnwrap.mockResolvedValueOnce({
      id: "evt_deep_e2e",
      type: "response.completed",
      data: { id: "resp_deep_e2e" },
    });

    const webhookRequest = new Request("http://localhost/api/ai/webhooks/openai", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "webhook-id": "wh_e2e",
        "webhook-timestamp": "123",
        "webhook-signature": "sig",
      },
      body: JSON.stringify({ test: true }),
    });

    const webhookResponse = await fragment.handler(webhookRequest);
    expect(webhookResponse.status).toBe(200);

    mockOpenAIRetrieve.mockResolvedValueOnce({
      id: "resp_deep_e2e",
      status: "completed",
      output_text: "Deep research report",
      usage: { total_tokens: 42 },
    });

    await runner.tick({ maxWebhookEvents: 1 });

    const artifacts = await db.find("ai_artifact", (b) => b.whereIndex("primary"));
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.type).toBe("deep_research_report");
    expect(artifacts[0]?.text).toBe("Deep research report");

    const storedRun = await db.findFirst("ai_run", (b) =>
      b.whereIndex("primary", (eb) => eb("id", "=", run.data.id)),
    );
    expect(storedRun?.status).toBe("succeeded");
  });

  test("runner tick route should be disabled by default", async () => {
    const request = new Request("http://localhost/api/ai/_runner/tick", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });

    const response = await fragment.handler(request);
    expect(response.status).toBe(404);
  });

  test("runner tick route should honor rate limiting", async () => {
    const rateLimiter = vi.fn().mockReturnValue(false);
    const tick = vi.fn();

    const { fragments } = await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "drizzle-pglite" })
      .withFragment(
        "ai",
        instantiate(aiFragmentDefinition)
          .withConfig({
            ...config,
            enableRunnerTick: true,
            runner: { tick },
            rateLimiter,
          })
          .withRoutes([aiRoutesFactory]),
      )
      .build();

    const request = new Request("http://localhost/api/ai/_runner/tick", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });

    const response = await fragments.ai.fragment.handler(request);
    expect(response.status).toBe(429);
    expect(rateLimiter).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "runner_tick", headers: expect.any(Headers) }),
    );
    expect(tick).not.toHaveBeenCalled();
  });

  test("runner tick route should call runner when enabled", async () => {
    const tick = vi.fn().mockResolvedValue({
      processedRuns: 2,
      processedWebhookEvents: 1,
    });

    const { fragments } = await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "drizzle-pglite" })
      .withFragment(
        "ai",
        instantiate(aiFragmentDefinition)
          .withConfig({
            defaultModel: { id: "gpt-test" },
            apiKey: "test-key",
            enableRunnerTick: true,
            runner: { tick },
          })
          .withRoutes([aiRoutesFactory]),
      )
      .build();

    const response = await fragments.ai.fragment.callRoute("POST", "/_runner/tick", {
      body: { maxRuns: 3, maxWebhookEvents: 2 },
    });

    expect(response.type).toBe("json");
    if (response.type === "json") {
      expect(response.data).toEqual({ processedRuns: 2, processedWebhookEvents: 1 });
    }

    expect(tick).toHaveBeenCalledWith({ maxRuns: 3, maxWebhookEvents: 2 });
  });
});
