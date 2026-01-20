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
    } as { id: string; output_text?: string };
  },
);

const mockOpenAIRetrieve = vi.fn(async (_responseId?: string) => {
  return {
    id: "resp_retrieved",
    status: "completed",
    output_text: "Retrieved response",
  } as { id: string; status: string; output_text?: string; usage?: unknown };
});

vi.mock("openai", () => {
  return {
    default: class MockOpenAI {
      responses = {
        create: mockOpenAICreate,
        retrieve: mockOpenAIRetrieve,
      };
    },
  };
});

describe("AI Fragment Runner", () => {
  const config = {
    defaultModel: { id: "gpt-test" },
    defaultDeepResearchModel: { id: "gpt-deep-research" },
    apiKey: "test-key",
    retries: { baseDelayMs: 1000 },
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
    mockOpenAIRetrieve.mockClear();
  });

  test("runner tick should execute queued background run", async () => {
    const thread = await runService<{ id: string }>(() =>
      fragment.services.createThread({
        title: "Runner Thread",
        openaiToolConfig: {
          stream: true,
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
        stream: false,
        tools: [{ type: "web_search" }],
        tool_choice: "auto",
      }),
      expect.objectContaining({
        idempotencyKey: `ai-run:${run.id}:attempt:1`,
        signal: expect.any(AbortSignal),
      }),
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

  test("runner tick should clean up retained run events and webhook events", async () => {
    const now = new Date("2024-01-03T00:00:00Z");
    const recentEventAt = new Date("2024-01-02T12:00:00Z");
    const retentionConfig = { ...config, storage: { retentionDays: 1 } };

    const thread = await runService<{ id: string }>(() =>
      fragment.services.createThread({ title: "Retention Thread" }),
    );

    const message = await runService<{ id: string }>(() =>
      fragment.services.appendMessage({
        threadId: thread.id,
        role: "user",
        content: { type: "text", text: "Retention check" },
        text: "Retention check",
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

    await db.update("ai_run", run.id, (b) =>
      b.set({
        status: "succeeded",
        updatedAt: now,
        completedAt: now,
      }),
    );

    await db.create("ai_run_event", {
      runId: run.id,
      threadId: thread.id,
      seq: 1,
      type: "run.meta",
      payload: null,
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });

    await db.create("ai_run_event", {
      runId: run.id,
      threadId: thread.id,
      seq: 2,
      type: "run.meta",
      payload: null,
      createdAt: recentEventAt,
    });

    await db.create("ai_openai_webhook_event", {
      openaiEventId: "evt_old",
      type: "response.completed",
      responseId: "resp_old",
      payload: { ok: true },
      receivedAt: new Date("2024-01-01T00:00:00Z"),
      processingAt: null,
      nextAttemptAt: null,
      processedAt: now,
      processingError: null,
    });

    await db.create("ai_openai_webhook_event", {
      openaiEventId: "evt_new",
      type: "response.completed",
      responseId: "resp_new",
      payload: { ok: true },
      receivedAt: recentEventAt,
      processingAt: null,
      nextAttemptAt: null,
      processedAt: now,
      processingError: null,
    });

    const runner = createAiRunner({
      db,
      config: retentionConfig,
      clock: { now: () => now },
    });

    await runner.tick({ maxRuns: 1, maxWebhookEvents: 1 });

    const runEvents = await db.find("ai_run_event", (b) => b.whereIndex("primary"));
    expect(runEvents).toHaveLength(1);
    expect(runEvents[0]?.createdAt.getTime()).toBe(recentEventAt.getTime());

    const webhookEvents = await db.find("ai_openai_webhook_event", (b) => b.whereIndex("primary"));
    expect(webhookEvents).toHaveLength(1);
    expect(webhookEvents[0]?.openaiEventId).toBe("evt_new");
  });

  test("runner tick should fail when tool policy denies tools", async () => {
    const thread = await runService<{ id: string }>(() =>
      fragment.services.createThread({
        title: "Policy Thread",
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
        content: { type: "text", text: "Should be denied" },
        text: "Should be denied",
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

    const toolPolicy = vi.fn().mockResolvedValue({ action: "deny", reason: "POLICY_DENIED" });
    const runner = createAiRunner({ db, config: { ...config, toolPolicy } });
    const result = await runner.tick({ maxRuns: 1 });

    expect(result.processedRuns).toBe(1);
    expect(mockOpenAICreate).not.toHaveBeenCalled();
    expect(toolPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ runId: run.id, threadId: thread.id }),
    );

    const storedRun = await db.findFirst("ai_run", (b) =>
      b.whereIndex("primary", (eb) => eb("id", "=", run.id)),
    );
    expect(storedRun?.status).toBe("failed");
    expect(storedRun?.error).toBe("POLICY_DENIED");
    expect(storedRun?.nextAttemptAt).toBeNull();
  });

  test("runner tick should execute queued foreground stream run", async () => {
    const thread = await runService<{ id: string }>(() =>
      fragment.services.createThread({ title: "Foreground Retry Thread" }),
    );

    const message = await runService<{ id: string }>(() =>
      fragment.services.appendMessage({
        threadId: thread.id,
        role: "user",
        content: { type: "text", text: "Retry this" },
        text: "Retry this",
      }),
    );

    const run = await runService<{ id: string }>(() =>
      fragment.services.createRun({
        threadId: thread.id,
        inputMessageId: message.id,
        executionMode: "foreground_stream",
        type: "agent",
      }),
    );

    const storedRun = await db.findFirst("ai_run", (b) =>
      b.whereIndex("primary", (eb) => eb("id", "=", run.id)),
    );
    expect(storedRun).toBeTruthy();

    await db.update("ai_run", storedRun!.id, (b) =>
      b.set({ status: "queued", updatedAt: new Date() }),
    );

    const runner = createAiRunner({ db, config });
    const result = await runner.tick({ maxRuns: 1 });

    expect(result.processedRuns).toBe(1);
    expect(mockOpenAICreate).toHaveBeenCalled();

    const updatedRun = await db.findFirst("ai_run", (b) =>
      b.whereIndex("primary", (eb) => eb("id", "=", run.id)),
    );
    expect(updatedRun?.status).toBe("succeeded");
    expect(updatedRun?.openaiResponseId).toBe("resp_test");
  });

  test("runner tick should schedule retry with backoff on failure", async () => {
    const fixedNow = new Date("2024-01-01T00:00:00Z");
    mockOpenAICreate.mockImplementationOnce(async () => {
      throw new Error("OpenAI down");
    });

    const thread = await runService<{ id: string }>(() =>
      fragment.services.createThread({ title: "Retry Thread" }),
    );

    const message = await runService<{ id: string }>(() =>
      fragment.services.appendMessage({
        threadId: thread.id,
        role: "user",
        content: { type: "text", text: "Retry this" },
        text: "Retry this",
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

    const storedRunBefore = await db.findFirst("ai_run", (b) =>
      b.whereIndex("primary", (eb) => eb("id", "=", run.id)),
    );
    expect(storedRunBefore).toBeTruthy();
    await db.update("ai_run", storedRunBefore!.id, (b) => b.set({ attempt: 2 }));

    const runner = createAiRunner({
      db,
      config,
      clock: { now: () => new Date(fixedNow.getTime()) },
    });
    await runner.tick({ maxRuns: 1 });

    const storedRun = await db.findFirst("ai_run", (b) =>
      b.whereIndex("primary", (eb) => eb("id", "=", run.id)),
    );
    expect(storedRun?.status).toBe("queued");
    expect(storedRun?.attempt).toBe(3);
    expect(storedRun?.completedAt).toBeNull();
    expect(storedRun?.error).toBe("OpenAI down");
    expect(storedRun?.nextAttemptAt?.getTime()).toBe(fixedNow.getTime() + 2000);
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

  test("runner tick should cap history messages when configured", async () => {
    const thread = await runService<{ id: string }>(() =>
      fragment.services.createThread({ title: "Trim Thread" }),
    );

    await runService(() =>
      fragment.services.appendMessage({
        threadId: thread.id,
        role: "user",
        content: { type: "text", text: "First message" },
        text: "First message",
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

    const thirdMessage = await runService<{ id: string }>(() =>
      fragment.services.appendMessage({
        threadId: thread.id,
        role: "user",
        content: { type: "text", text: "Third message" },
        text: "Third message",
      }),
    );

    await runService(() =>
      fragment.services.createRun({
        threadId: thread.id,
        inputMessageId: thirdMessage.id,
        executionMode: "background",
        type: "agent",
        systemPrompt: "System prompt",
      }),
    );

    const runner = createAiRunner({
      db,
      config: { ...config, history: { maxMessages: 2 } },
    });
    await runner.tick({ maxRuns: 1 });

    const input = mockOpenAICreate.mock.calls.at(-1)?.[0]?.input as Array<{
      role: string;
      content: string;
    }>;

    expect(input?.[0]?.content).toBe("System prompt");
    expect(input?.some((entry) => entry.content === "First message")).toBe(false);
    expect(input?.some((entry) => entry.content === "Second message")).toBe(true);
    expect(input?.some((entry) => entry.content === "Third message")).toBe(true);
  });

  test("runner tick should submit deep research run and process webhook event", async () => {
    const thread = await runService<{ id: string }>(() =>
      fragment.services.createThread({ title: "Deep Research Thread" }),
    );

    const message = await runService<{ id: string }>(() =>
      fragment.services.appendMessage({
        threadId: thread.id,
        role: "user",
        content: { type: "text", text: "Investigate this" },
        text: "Investigate this",
      }),
    );

    const run = await runService<{ id: string }>(() =>
      fragment.services.createRun({
        threadId: thread.id,
        inputMessageId: message.id,
        executionMode: "background",
        type: "deep_research",
      }),
    );

    mockOpenAICreate.mockResolvedValueOnce({ id: "resp_deep" });

    const runner = createAiRunner({ db, config });
    const submitResult = await runner.tick({ maxRuns: 1 });

    expect(submitResult.processedRuns).toBe(1);
    expect(mockOpenAICreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-deep-research",
        background: true,
      }),
      expect.objectContaining({
        idempotencyKey: `ai-run:${run.id}:attempt:1`,
      }),
    );

    const storedRun = await db.findFirst("ai_run", (b) =>
      b.whereIndex("primary", (eb) => eb("id", "=", run.id)),
    );
    expect(storedRun?.status).toBe("waiting_webhook");
    expect(storedRun?.openaiResponseId).toBe("resp_deep");

    await db.create("ai_openai_webhook_event", {
      openaiEventId: "evt_deep",
      type: "response.completed",
      responseId: "resp_deep",
      payload: { redacted: true },
      receivedAt: new Date(),
      processingAt: null,
      nextAttemptAt: null,
      processedAt: null,
      processingError: null,
    });

    mockOpenAIRetrieve.mockResolvedValueOnce({
      id: "resp_deep",
      status: "completed",
      output_text: "Deep research report",
      usage: { total_tokens: 42 },
    });

    const processResult = await runner.tick({ maxWebhookEvents: 1 });
    expect(processResult.processedWebhookEvents).toBe(1);

    const updatedRun = await db.findFirst("ai_run", (b) =>
      b.whereIndex("primary", (eb) => eb("id", "=", run.id)),
    );
    expect(updatedRun?.status).toBe("succeeded");
    expect(updatedRun?.completedAt).toBeTruthy();

    const artifacts = await db.find("ai_artifact", (b) => b.whereIndex("primary"));
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.type).toBe("deep_research_report");
    expect(artifacts[0]?.text).toBe("Deep research report");

    const artifactData = artifacts[0]?.data as {
      reportMarkdown?: string;
      openaiResponseId?: string;
      usage?: unknown;
    };
    expect(artifactData?.reportMarkdown).toBe("Deep research report");
    expect(artifactData?.openaiResponseId).toBe("resp_deep");
    expect(artifactData?.usage).toEqual({ total_tokens: 42 });

    const messages = await db.find("ai_message", (b) =>
      b.whereIndex("idx_ai_message_thread_createdAt", (eb) => eb("threadId", "=", thread.id)),
    );
    const artifactMessage = messages.find(
      (entry) => entry.role === "assistant" && entry.runId === run.id,
    );
    expect(artifactMessage?.content).toMatchObject({
      type: "artifactRef",
      artifactId: artifacts[0]?.id.toString(),
    });

    const webhookEvents = await db.find("ai_openai_webhook_event", (b) => b.whereIndex("primary"));
    expect(webhookEvents[0]?.processedAt).toBeTruthy();
    expect(webhookEvents[0]?.processingError).toBeNull();
  });

  test("runner tick should store deep research artifact in external storage", async () => {
    const artifactStore = {
      put: vi.fn(async () => ({ key: "artifact-key", metadata: { bucket: "reports" } })),
    };
    const runnerConfig = { ...config, storage: { artifactStore } };

    const thread = await runService<{ id: string }>(() =>
      fragment.services.createThread({ title: "Deep Research Stored Artifact" }),
    );

    const message = await runService<{ id: string }>(() =>
      fragment.services.appendMessage({
        threadId: thread.id,
        role: "user",
        content: { type: "text", text: "Store this" },
        text: "Store this",
      }),
    );

    const run = await runService<{ id: string }>(() =>
      fragment.services.createRun({
        threadId: thread.id,
        inputMessageId: message.id,
        executionMode: "background",
        type: "deep_research",
      }),
    );

    mockOpenAICreate.mockResolvedValueOnce({ id: "resp_store" });

    const runner = createAiRunner({ db, config: runnerConfig });
    await runner.tick({ maxRuns: 1 });

    await db.create("ai_openai_webhook_event", {
      openaiEventId: "evt_store",
      type: "response.completed",
      responseId: "resp_store",
      payload: { redacted: true },
      receivedAt: new Date(),
      processingAt: null,
      nextAttemptAt: null,
      processedAt: null,
      processingError: null,
    });

    mockOpenAIRetrieve.mockResolvedValueOnce({
      id: "resp_store",
      status: "completed",
      output_text: "Deep research report",
    });

    await runner.tick({ maxWebhookEvents: 1 });

    expect(artifactStore.put).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: run.id,
        threadId: thread.id,
        type: "deep_research_report",
        mimeType: "text/markdown",
        text: "Deep research report",
      }),
    );

    const artifacts = await db.find("ai_artifact", (b) => b.whereIndex("primary"));
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.storageKey).toBe("artifact-key");
    expect(artifacts[0]?.storageMeta).toEqual({ bucket: "reports" });
  });

  test("runner tick should fail when deep research artifact exceeds limit", async () => {
    const thread = await runService<{ id: string }>(() =>
      fragment.services.createThread({ title: "Deep Research Large Artifact" }),
    );

    const message = await runService<{ id: string }>(() =>
      fragment.services.appendMessage({
        threadId: thread.id,
        role: "user",
        content: { type: "text", text: "Oversize artifact" },
        text: "Oversize artifact",
      }),
    );

    const run = await runService<{ id: string }>(() =>
      fragment.services.createRun({
        threadId: thread.id,
        inputMessageId: message.id,
        executionMode: "background",
        type: "deep_research",
      }),
    );

    await db.update("ai_run", run.id, (b) =>
      b.set({ status: "waiting_webhook", openaiResponseId: "resp_large" }),
    );

    await db.create("ai_openai_webhook_event", {
      openaiEventId: "evt_large",
      type: "response.completed",
      responseId: "resp_large",
      payload: { redacted: true },
      receivedAt: new Date(),
      processingAt: null,
      nextAttemptAt: null,
      processedAt: null,
      processingError: null,
    });

    const largeText = "x".repeat(4096);
    mockOpenAIRetrieve.mockResolvedValueOnce({
      id: "resp_large",
      status: "completed",
      output_text: largeText,
    });

    const limitedConfig = { ...config, limits: { maxArtifactBytes: 512 } };
    const runner = createAiRunner({ db, config: limitedConfig });
    const processResult = await runner.tick({ maxWebhookEvents: 1 });

    expect(processResult.processedWebhookEvents).toBe(1);

    const updatedRun = await db.findFirst("ai_run", (b) =>
      b.whereIndex("primary", (eb) => eb("id", "=", run.id)),
    );
    expect(updatedRun?.status).toBe("failed");
    expect(updatedRun?.error).toBe("ARTIFACT_TOO_LARGE");

    const artifacts = await db.find("ai_artifact", (b) => b.whereIndex("primary"));
    expect(artifacts).toHaveLength(0);
  });

  test("runner tick should not duplicate artifacts for duplicate webhook events", async () => {
    const thread = await runService<{ id: string }>(() =>
      fragment.services.createThread({ title: "Deep Research Dedupe" }),
    );

    const message = await runService<{ id: string }>(() =>
      fragment.services.appendMessage({
        threadId: thread.id,
        role: "user",
        content: { type: "text", text: "Duplicate this" },
        text: "Duplicate this",
      }),
    );

    const run = await runService<{ id: string }>(() =>
      fragment.services.createRun({
        threadId: thread.id,
        inputMessageId: message.id,
        executionMode: "background",
        type: "deep_research",
      }),
    );

    await db.update("ai_run", run.id, (b) =>
      b.set({ status: "waiting_webhook", openaiResponseId: "resp_dupe" }),
    );

    await db.create("ai_openai_webhook_event", {
      openaiEventId: "evt_dupe_1",
      type: "response.completed",
      responseId: "resp_dupe",
      payload: { redacted: true },
      receivedAt: new Date(),
      processingAt: null,
      nextAttemptAt: null,
      processedAt: null,
      processingError: null,
    });

    await db.create("ai_openai_webhook_event", {
      openaiEventId: "evt_dupe_2",
      type: "response.completed",
      responseId: "resp_dupe",
      payload: { redacted: true },
      receivedAt: new Date(),
      processingAt: null,
      nextAttemptAt: null,
      processedAt: null,
      processingError: null,
    });

    mockOpenAIRetrieve.mockResolvedValue({
      id: "resp_dupe",
      status: "completed",
      output_text: "Duplicate report",
    });

    const runner = createAiRunner({ db, config });
    const result = await runner.tick({ maxWebhookEvents: 2 });

    expect(result.processedWebhookEvents).toBe(2);
    expect(mockOpenAIRetrieve).toHaveBeenCalledTimes(1);

    const artifacts = await db.find("ai_artifact", (b) => b.whereIndex("primary"));
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.text).toBe("Duplicate report");

    const messages = await db.find("ai_message", (b) =>
      b.whereIndex("idx_ai_message_thread_createdAt", (eb) => eb("threadId", "=", thread.id)),
    );
    const assistantMessages = messages.filter(
      (entry) => entry.role === "assistant" && entry.runId === run.id,
    );
    expect(assistantMessages).toHaveLength(1);
  });

  test("runner tick should back off webhook processing on retrieve failure", async () => {
    const fixedNow = new Date("2024-01-02T00:00:00Z");
    mockOpenAIRetrieve.mockRejectedValueOnce(new Error("OpenAI down"));

    const thread = await runService<{ id: string }>(() =>
      fragment.services.createThread({ title: "Webhook Retry Thread" }),
    );

    const message = await runService<{ id: string }>(() =>
      fragment.services.appendMessage({
        threadId: thread.id,
        role: "user",
        content: { type: "text", text: "Back off" },
        text: "Back off",
      }),
    );

    const run = await runService<{ id: string }>(() =>
      fragment.services.createRun({
        threadId: thread.id,
        inputMessageId: message.id,
        executionMode: "background",
        type: "deep_research",
      }),
    );

    await db.update("ai_run", run.id, (b) =>
      b.set({ status: "waiting_webhook", openaiResponseId: "resp_backoff" }),
    );

    await db.create("ai_openai_webhook_event", {
      openaiEventId: "evt_backoff",
      type: "response.completed",
      responseId: "resp_backoff",
      payload: { redacted: true },
      receivedAt: new Date(),
      processingAt: null,
      nextAttemptAt: null,
      processedAt: null,
      processingError: null,
    });

    const runner = createAiRunner({
      db,
      config,
      clock: { now: () => new Date(fixedNow.getTime()) },
    });
    const result = await runner.tick({ maxWebhookEvents: 1 });

    expect(result.processedWebhookEvents).toBe(0);
    expect(mockOpenAIRetrieve).toHaveBeenCalledTimes(1);

    const events = await db.find("ai_openai_webhook_event", (b) => b.whereIndex("primary"));
    expect(events[0]?.processingError).toBe("OpenAI down");
    expect(events[0]?.processedAt).toBeNull();
    expect(events[0]?.processingAt).toBeNull();
    expect(events[0]?.nextAttemptAt?.getTime()).toBe(fixedNow.getTime() + 1000);

    const retryResult = await runner.tick({ maxWebhookEvents: 1 });
    expect(retryResult.processedWebhookEvents).toBe(0);
    expect(mockOpenAIRetrieve).toHaveBeenCalledTimes(1);
  });

  test("runner tick should retry webhook events until the run has a response id", async () => {
    const fixedNow = new Date("2024-01-03T00:00:00Z");

    const thread = await runService<{ id: string }>(() =>
      fragment.services.createThread({ title: "Early Webhook Thread" }),
    );

    const message = await runService<{ id: string }>(() =>
      fragment.services.appendMessage({
        threadId: thread.id,
        role: "user",
        content: { type: "text", text: "Wait for response id" },
        text: "Wait for response id",
      }),
    );

    const run = await runService<{ id: string }>(() =>
      fragment.services.createRun({
        threadId: thread.id,
        inputMessageId: message.id,
        executionMode: "background",
        type: "deep_research",
      }),
    );

    await db.update("ai_run", run.id, (b) => b.set({ status: "waiting_webhook" }));

    await db.create("ai_openai_webhook_event", {
      openaiEventId: "evt_early",
      type: "response.completed",
      responseId: "resp_early",
      payload: { redacted: true },
      receivedAt: new Date(),
      processingAt: null,
      nextAttemptAt: null,
      processedAt: null,
      processingError: null,
    });

    mockOpenAIRetrieve.mockResolvedValue({
      id: "resp_early",
      status: "completed",
      output_text: "Late-bound response",
    });

    const runner = createAiRunner({
      db,
      config,
      clock: { now: () => new Date(fixedNow.getTime()) },
    });
    const firstAttempt = await runner.tick({ maxWebhookEvents: 1 });

    expect(firstAttempt.processedWebhookEvents).toBe(0);
    expect(mockOpenAIRetrieve).toHaveBeenCalledTimes(0);

    const queuedEvents = await db.find("ai_openai_webhook_event", (b) => b.whereIndex("primary"));
    expect(queuedEvents[0]?.processingError).toBe("RUN_NOT_FOUND");
    expect(queuedEvents[0]?.nextAttemptAt?.getTime()).toBe(fixedNow.getTime() + 1000);

    await db.update("ai_run", run.id, (b) =>
      b.set({ status: "waiting_webhook", openaiResponseId: "resp_early" }),
    );

    const retryRunner = createAiRunner({
      db,
      config,
      clock: { now: () => new Date(fixedNow.getTime() + 2000) },
    });
    const retryAttempt = await retryRunner.tick({ maxWebhookEvents: 1 });

    expect(retryAttempt.processedWebhookEvents).toBe(1);
    expect(mockOpenAIRetrieve).toHaveBeenCalledTimes(1);

    const updatedRun = await db.findFirst("ai_run", (b) =>
      b.whereIndex("primary", (eb) => eb("id", "=", run.id)),
    );
    expect(updatedRun?.status).toBe("succeeded");

    const artifacts = await db.find("ai_artifact", (b) => b.whereIndex("primary"));
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.text).toBe("Late-bound response");
  });

  test("runner tick should not double-process a run when ticks race", async () => {
    const thread = await runService<{ id: string }>(() =>
      fragment.services.createThread({ title: "Concurrent Run Thread" }),
    );

    const message = await runService<{ id: string }>(() =>
      fragment.services.appendMessage({
        threadId: thread.id,
        role: "user",
        content: { type: "text", text: "Race this" },
        text: "Race this",
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
    const [first, second] = await Promise.all([
      runner.tick({ maxRuns: 1 }),
      runner.tick({ maxRuns: 1 }),
    ]);

    expect(first.processedRuns + second.processedRuns).toBe(1);
    expect(mockOpenAICreate).toHaveBeenCalledTimes(1);

    const storedRun = await db.findFirst("ai_run", (b) =>
      b.whereIndex("primary", (eb) => eb("id", "=", run.id)),
    );
    expect(storedRun?.status).toBe("succeeded");

    const events = await db.find("ai_run_event", (b) =>
      b.whereIndex("idx_ai_run_event_run_seq", (eb) => eb("runId", "=", run.id)),
    );
    expect(events.filter((event) => event.type === "run.final")).toHaveLength(1);
  });

  test("runner tick should not double-process a webhook event when ticks race", async () => {
    const thread = await runService<{ id: string }>(() =>
      fragment.services.createThread({ title: "Concurrent Webhook Thread" }),
    );

    const message = await runService<{ id: string }>(() =>
      fragment.services.appendMessage({
        threadId: thread.id,
        role: "user",
        content: { type: "text", text: "Webhook race" },
        text: "Webhook race",
      }),
    );

    const run = await runService<{ id: string }>(() =>
      fragment.services.createRun({
        threadId: thread.id,
        inputMessageId: message.id,
        executionMode: "background",
        type: "deep_research",
      }),
    );

    await db.update("ai_run", run.id, (b) =>
      b.set({ status: "waiting_webhook", openaiResponseId: "resp_race" }),
    );

    await db.create("ai_openai_webhook_event", {
      openaiEventId: "evt_race",
      type: "response.completed",
      responseId: "resp_race",
      payload: { redacted: true },
      receivedAt: new Date(),
      processingAt: null,
      nextAttemptAt: null,
      processedAt: null,
      processingError: null,
    });

    mockOpenAIRetrieve.mockResolvedValueOnce({
      id: "resp_race",
      status: "completed",
      output_text: "Race complete",
    });

    const runner = createAiRunner({ db, config });
    const [first, second] = await Promise.all([
      runner.tick({ maxWebhookEvents: 1 }),
      runner.tick({ maxWebhookEvents: 1 }),
    ]);

    expect(first.processedWebhookEvents + second.processedWebhookEvents).toBe(1);
    expect(mockOpenAIRetrieve).toHaveBeenCalledTimes(1);

    const artifacts = await db.find("ai_artifact", (b) => b.whereIndex("primary"));
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.text).toBe("Race complete");
  });

  test("runner tick should apply config options and thinking level to OpenAI calls", async () => {
    const customConfig = {
      ...config,
      temperature: 0.2,
      maxTokens: 128,
      sessionId: "session_test",
      openai: { reasoningSummary: "detailed" as const, serviceTier: "scale" },
    };

    const { fragments, test: customTestContext } = await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "drizzle-pglite" })
      .withFragment("ai", instantiate(aiFragmentDefinition).withConfig(customConfig))
      .build();

    await customTestContext.resetDatabase();
    mockOpenAICreate.mockClear();

    const customFragment = fragments.ai.fragment;
    const customDb = fragments.ai.db;

    const runService = <T>(call: () => unknown) =>
      customFragment.inContext(function () {
        return this.handlerTx()
          .withServiceCalls(() => [call() as TxResult<unknown, unknown>] as const)
          .transform(({ serviceResult: [result] }) => result as T)
          .execute();
      });

    const thread = await runService<{ id: string }>(() =>
      customFragment.services.createThread({ title: "Config Thread" }),
    );

    const message = await runService<{ id: string }>(() =>
      customFragment.services.appendMessage({
        threadId: thread.id,
        role: "user",
        content: { type: "text", text: "Apply options" },
        text: "Apply options",
      }),
    );

    await runService<{ id: string }>(() =>
      customFragment.services.createRun({
        threadId: thread.id,
        inputMessageId: message.id,
        executionMode: "background",
        type: "agent",
        thinkingLevel: "high",
      }),
    );

    const runner = createAiRunner({ db: customDb, config: customConfig });
    await runner.tick({ maxRuns: 1 });

    const [options] = mockOpenAICreate.mock.calls.at(-1) ?? [];
    expect(options).toEqual(
      expect.objectContaining({
        temperature: 0.2,
        max_output_tokens: 128,
        prompt_cache_key: "session_test",
        service_tier: "scale",
        reasoning: { effort: "high", summary: "detailed" },
      }),
    );
  });
});
