import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { buildDatabaseFragmentsTest } from "@fragno-dev/test";
import type { TxResult } from "@fragno-dev/db";
import { instantiate } from "@fragno-dev/core";
import { aiFragmentDefinition } from "./definition";

const MAX_PAGE_SIZE = 100;

describe("AI Fragment Services", () => {
  const dispatcher = {
    wake: vi.fn(),
  };

  const setup = async () => {
    const { fragments, test: testContext } = await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "drizzle-pglite" })
      .withFragment(
        "ai",
        instantiate(aiFragmentDefinition).withConfig({
          defaultModel: { id: "gpt-test" },
          dispatcher,
        }),
      )
      .build();

    const { fragment, db } = fragments.ai;
    return { fragments, testContext, fragment, db };
  };

  type Setup = Awaited<ReturnType<typeof setup>>;

  let testContext: Setup["testContext"];
  let fragment: Setup["fragment"];
  let db: Setup["db"];

  beforeAll(async () => {
    ({ testContext, fragment, db } = await setup());
  });

  const runService = <T>(call: () => unknown) =>
    fragment.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [call() as TxResult<unknown, unknown>] as const)
        .transform(({ serviceResult: [result] }) => result)
        .execute();
    }) as Promise<T>;

  beforeEach(async () => {
    await testContext.resetDatabase();
    dispatcher.wake.mockReset();
  });

  test("createThread should persist thread defaults", async () => {
    const thread = await runService<{ id: string; defaultModelId: string }>(() =>
      fragment.services.createThread({ title: "Demo" }),
    );

    expect(thread.id).toBeTruthy();
    expect(thread.defaultModelId).toBe("gpt-test");

    const [stored] = await db.find("ai_thread", (b) => b.whereIndex("primary"));
    expect(stored).toMatchObject({
      title: "Demo",
      defaultModelId: "gpt-test",
      defaultThinkingLevel: "off",
    });
  });

  test("listThreads should return threads", async () => {
    await runService(() => fragment.services.createThread({ title: "Thread A" }));

    const listed = await runService<{ threads: Array<{ title: string | null }> }>(() =>
      fragment.services.listThreads(),
    );

    expect(listed.threads).toHaveLength(1);
    expect(listed.threads[0]?.title).toBe("Thread A");
  });

  test("listThreads should cap page size", async () => {
    const totalThreads = MAX_PAGE_SIZE + 5;
    for (let i = 0; i < totalThreads; i += 1) {
      await runService(() => fragment.services.createThread({ title: `Thread ${i}` }));
    }

    const listed = await runService<{ threads: Array<{ id: string }> }>(() =>
      fragment.services.listThreads({ pageSize: MAX_PAGE_SIZE + 50 }),
    );

    expect(listed.threads).toHaveLength(MAX_PAGE_SIZE);
  });

  test("appendMessage and listMessages should persist messages", async () => {
    const thread = await runService<{ id: string }>(() =>
      fragment.services.createThread({ title: "Thread B" }),
    );

    const message = await runService<{ id: string }>(() =>
      fragment.services.appendMessage({
        threadId: thread.id,
        role: "user",
        content: { type: "text", text: "Hello" },
        text: "Hello",
      }),
    );

    const listed = await runService<{ messages: Array<{ id: string; text: string | null }> }>(() =>
      fragment.services.listMessages({ threadId: thread.id }),
    );

    expect(listed.messages).toHaveLength(1);
    expect(listed.messages[0]?.id).toBe(message.id);
    expect(listed.messages[0]?.text).toBe("Hello");
  });

  test("listMessages should cap page size", async () => {
    const thread = await runService<{ id: string }>(() =>
      fragment.services.createThread({ title: "Thread B2" }),
    );

    const totalMessages = MAX_PAGE_SIZE + 5;
    for (let i = 0; i < totalMessages; i += 1) {
      await runService(() =>
        fragment.services.appendMessage({
          threadId: thread.id,
          role: "user",
          content: { type: "text", text: `Message ${i}` },
          text: `Message ${i}`,
        }),
      );
    }

    const listed = await runService<{ messages: Array<{ id: string }> }>(() =>
      fragment.services.listMessages({ threadId: thread.id, pageSize: MAX_PAGE_SIZE + 25 }),
    );

    expect(listed.messages).toHaveLength(MAX_PAGE_SIZE);
  });

  test("createRun and listRuns should persist runs", async () => {
    const thread = await runService<{ id: string }>(() =>
      fragment.services.createThread({ title: "Thread C" }),
    );

    const message = await runService<{ id: string }>(() =>
      fragment.services.appendMessage({
        threadId: thread.id,
        role: "user",
        content: { type: "text", text: "Run please" },
        text: "Run please",
      }),
    );

    const run = await runService<{ id: string; status: string }>(() =>
      fragment.services.createRun({
        threadId: thread.id,
        inputMessageId: message.id,
        type: "agent",
      }),
    );

    expect(run.status).toBe("queued");

    const listed = await runService<{ runs: Array<{ id: string }> }>(() =>
      fragment.services.listRuns({ threadId: thread.id }),
    );

    expect(listed.runs).toHaveLength(1);
    expect(listed.runs[0]?.id).toBe(run.id);
  });

  test("createRun should wake dispatcher for queued runs", async () => {
    const thread = await runService<{ id: string }>(() =>
      fragment.services.createThread({ title: "Thread D" }),
    );

    await runService<{ id: string }>(() =>
      fragment.services.appendMessage({
        threadId: thread.id,
        role: "user",
        content: { type: "text", text: "Queue me" },
        text: "Queue me",
      }),
    );

    const run = await runService<{ id: string }>(() =>
      fragment.services.createRun({ threadId: thread.id, type: "agent" }),
    );

    expect(dispatcher.wake).toHaveBeenCalledTimes(1);
    expect(dispatcher.wake).toHaveBeenCalledWith({
      type: "run.queued",
      runId: run.id,
    });
  });

  test("claimNextRuns should claim due queued runs", async () => {
    const now = new Date("2024-01-01T00:00:00Z");

    const thread = await runService<{ id: string }>(() =>
      fragment.services.createThread({ title: "Thread E" }),
    );

    const message = await runService<{ id: string }>(() =>
      fragment.services.appendMessage({
        threadId: thread.id,
        role: "user",
        content: { type: "text", text: "Please run" },
        text: "Please run",
      }),
    );

    const runOne = await runService<{ id: string }>(() =>
      fragment.services.createRun({
        threadId: thread.id,
        inputMessageId: message.id,
        type: "agent",
      }),
    );

    const runTwo = await runService<{ id: string }>(() =>
      fragment.services.createRun({
        threadId: thread.id,
        inputMessageId: message.id,
        type: "agent",
      }),
    );

    const storedRunTwo = await db.findFirst("ai_run", (b) =>
      b.whereIndex("primary", (eb) => eb("id", "=", runTwo.id)),
    );
    expect(storedRunTwo).toBeTruthy();

    await db.update("ai_run", storedRunTwo!.id, (b) =>
      b.set({ nextAttemptAt: new Date("2024-01-02T00:00:00Z") }),
    );

    const claimed = await runService<{
      runs: Array<{ id: string; status: string; startedAt: Date }>;
    }>(() => fragment.services.claimNextRuns({ maxRuns: 2, now }));

    expect(claimed.runs).toHaveLength(1);
    expect(claimed.runs[0]?.id).toBe(runOne.id);
    expect(claimed.runs[0]?.status).toBe("running");
    expect(claimed.runs[0]?.startedAt).toEqual(now);

    const storedRunOne = await db.findFirst("ai_run", (b) =>
      b.whereIndex("primary", (eb) => eb("id", "=", runOne.id)),
    );

    expect(storedRunOne?.status).toBe("running");
    expect(storedRunOne?.startedAt).toEqual(now);
  });

  test("recordOpenAIWebhookEvent should be idempotent", async () => {
    const first = await runService<{ created: boolean }>(() =>
      fragment.services.recordOpenAIWebhookEvent({
        openaiEventId: "evt_1",
        type: "response.completed",
        responseId: "resp_1",
        payload: { ok: true },
      }),
    );

    const second = await runService<{ created: boolean }>(() =>
      fragment.services.recordOpenAIWebhookEvent({
        openaiEventId: "evt_1",
        type: "response.completed",
        responseId: "resp_1",
        payload: { ok: true },
      }),
    );

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);

    const events = await db.find("ai_openai_webhook_event", (b) => b.whereIndex("primary"));
    expect(events).toHaveLength(1);
  });

  test("recordOpenAIWebhookEvent should wake dispatcher on create", async () => {
    await runService(() =>
      fragment.services.recordOpenAIWebhookEvent({
        openaiEventId: "evt_2",
        type: "response.completed",
        responseId: "resp_2",
        payload: { ok: true },
      }),
    );

    expect(dispatcher.wake).toHaveBeenCalledTimes(1);
    expect(dispatcher.wake).toHaveBeenCalledWith({
      type: "openai.webhook.received",
      openaiEventId: "evt_2",
      responseId: "resp_2",
    });
  });

  test("recordOpenAIWebhookEvent should update run with last webhook event id", async () => {
    const thread = await runService<{ id: string }>(() =>
      fragment.services.createThread({ title: "Webhook Run Thread" }),
    );

    const message = await runService<{ id: string }>(() =>
      fragment.services.appendMessage({
        threadId: thread.id,
        role: "user",
        content: { type: "text", text: "Attach webhook" },
        text: "Attach webhook",
      }),
    );

    const run = await runService<{ id: string }>(() =>
      fragment.services.createRun({
        threadId: thread.id,
        inputMessageId: message.id,
        type: "agent",
      }),
    );

    const storedRun = await db.findFirst("ai_run", (b) =>
      b.whereIndex("primary", (eb) => eb("id", "=", run.id)),
    );
    expect(storedRun).toBeTruthy();

    await db.update("ai_run", storedRun!.id, (b) => b.set({ openaiResponseId: "resp_match" }));

    await runService(() =>
      fragment.services.recordOpenAIWebhookEvent({
        openaiEventId: "evt_run",
        type: "response.completed",
        responseId: "resp_match",
        payload: { ok: true },
      }),
    );

    const storedEvent = await db.findFirst("ai_openai_webhook_event", (b) =>
      b.whereIndex("idx_ai_openai_webhook_event_openaiEventId", (eb) =>
        eb("openaiEventId", "=", "evt_run"),
      ),
    );
    expect(storedEvent).toBeTruthy();

    const updatedRun = await db.findFirst("ai_run", (b) =>
      b.whereIndex("primary", (eb) => eb("id", "=", run.id)),
    );

    expect(updatedRun?.openaiLastWebhookEventId).toBe(storedEvent!.id.toString());
  });

  test("claimNextWebhookEvents should return unprocessed events", async () => {
    await runService(() =>
      fragment.services.recordOpenAIWebhookEvent({
        openaiEventId: "evt_3",
        type: "response.completed",
        responseId: "resp_3",
        payload: { ok: true },
      }),
    );

    await runService(() =>
      fragment.services.recordOpenAIWebhookEvent({
        openaiEventId: "evt_4",
        type: "response.completed",
        responseId: "resp_4",
        payload: { ok: true },
      }),
    );

    const processedEvent = await db.findFirst("ai_openai_webhook_event", (b) =>
      b.whereIndex("idx_ai_openai_webhook_event_openaiEventId", (eb) =>
        eb("openaiEventId", "=", "evt_4"),
      ),
    );
    expect(processedEvent).toBeTruthy();

    await db.update("ai_openai_webhook_event", processedEvent!.id, (b) =>
      b.set({ processedAt: new Date("2024-01-01T00:00:00Z") }),
    );

    const claimed = await runService<{ events: Array<{ openaiEventId: string }> }>(() =>
      fragment.services.claimNextWebhookEvents({ maxEvents: 5 }),
    );

    expect(claimed.events).toHaveLength(1);
    expect(claimed.events[0]?.openaiEventId).toBe("evt_3");
  });
});
