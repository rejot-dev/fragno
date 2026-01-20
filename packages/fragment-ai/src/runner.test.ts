import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { buildDatabaseFragmentsTest } from "@fragno-dev/test";
import { instantiate } from "@fragno-dev/core";
import type { TxResult } from "@fragno-dev/db";
import { aiFragmentDefinition } from "./definition";
import { createAiRunner } from "./runner";

const mockOpenAICreate = vi.fn(
  async (_options?: { input?: Array<{ role: string; content: string }> }) => {
    return {
      id: "resp_test",
      output_text: "Background response",
    };
  },
);

vi.mock("openai", () => {
  return {
    default: class MockOpenAI {
      responses = {
        create: mockOpenAICreate,
      };
    },
  };
});

describe("AI Fragment Runner", () => {
  const config = {
    defaultModel: { id: "gpt-test" },
    apiKey: "test-key",
  };

  const setup = async () => {
    const { fragments, test: testContext } = await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "drizzle-pglite" })
      .withFragment("ai", instantiate(aiFragmentDefinition).withConfig(config))
      .build();

    return { fragments, testContext };
  };

  type Setup = Awaited<ReturnType<typeof setup>>;

  let testContext: Setup["testContext"];
  let fragment: Setup["fragments"]["ai"]["fragment"];
  let db: Setup["fragments"]["ai"]["db"];

  beforeAll(async () => {
    const setupResult = await setup();
    testContext = setupResult.testContext;
    fragment = setupResult.fragments.ai.fragment;
    db = setupResult.fragments.ai.db;
  });

  const runService = <T>(call: () => unknown) =>
    fragment.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [call() as TxResult<unknown, unknown>] as const)
        .transform(({ serviceResult: [result] }) => result as T)
        .execute();
    });

  beforeEach(async () => {
    await testContext.resetDatabase();
    mockOpenAICreate.mockClear();
  });

  test("runner tick should execute queued background run", async () => {
    const thread = await runService<{ id: string }>(() =>
      fragment.services.createThread({
        title: "Runner Thread",
        openaiToolConfig: {
          tools: [{ type: "web_search" }],
          tool_choice: "auto",
        },
      }),
    );

    const message = await runService<{ id: string }>(() =>
      fragment.services.appendMessage({
        threadId: thread.id,
        role: "user",
        content: { type: "text", text: "Run this" },
        text: "Run this",
      }),
    );

    const run = await runService<{ id: string }>(() =>
      fragment.services.createRun({
        threadId: thread.id,
        inputMessageId: message.id,
        executionMode: "background",
        type: "agent",
      }),
    );

    const runner = createAiRunner({ db, config });
    const result = await runner.tick({ maxRuns: 1 });

    expect(result.processedRuns).toBe(1);
    expect(result.processedWebhookEvents).toBe(0);
    expect(mockOpenAICreate).toHaveBeenCalled();
    expect(mockOpenAICreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-test",
        tools: [{ type: "web_search" }],
        tool_choice: "auto",
      }),
      { idempotencyKey: `ai-run:${run.id}:attempt:1` },
    );

    const storedRun = await db.findFirst("ai_run", (b) =>
      b.whereIndex("primary", (eb) => eb("id", "=", run.id)),
    );
    expect(storedRun?.status).toBe("succeeded");
    expect(storedRun?.openaiResponseId).toBe("resp_test");
    expect(storedRun?.completedAt).toBeTruthy();

    const messages = await db.find("ai_message", (b) =>
      b.whereIndex("idx_ai_message_thread_createdAt", (eb) => eb("threadId", "=", thread.id)),
    );
    const assistantMessage = messages.find((entry) => entry.role === "assistant");
    expect(assistantMessage?.text).toBe("Background response");

    const events = await db.find("ai_run_event", (b) =>
      b.whereIndex("idx_ai_run_event_run_seq", (eb) => eb("runId", "=", run.id)),
    );
    expect(events.some((event) => event.type === "run.final")).toBe(true);
  });

  test("runner tick should use inputMessageId snapshot", async () => {
    const thread = await runService<{ id: string }>(() =>
      fragment.services.createThread({ title: "Snapshot Thread" }),
    );

    const firstMessage = await runService<{ id: string }>(() =>
      fragment.services.appendMessage({
        threadId: thread.id,
        role: "user",
        content: { type: "text", text: "First message" },
        text: "First message",
      }),
    );

    await runService(() =>
      fragment.services.createRun({
        threadId: thread.id,
        inputMessageId: firstMessage.id,
        executionMode: "background",
        type: "agent",
      }),
    );

    await runService(() =>
      fragment.services.appendMessage({
        threadId: thread.id,
        role: "user",
        content: { type: "text", text: "Second message" },
        text: "Second message",
      }),
    );

    const runner = createAiRunner({ db, config });
    await runner.tick({ maxRuns: 1 });

    const input = mockOpenAICreate.mock.calls.at(-1)?.[0]?.input as Array<{
      role: string;
      content: string;
    }>;

    expect(input?.some((entry) => entry.content === "First message")).toBe(true);
    expect(input?.some((entry) => entry.content === "Second message")).toBe(false);
  });
});
