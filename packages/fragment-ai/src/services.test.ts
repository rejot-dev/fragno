import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { buildDatabaseFragmentsTest } from "@fragno-dev/test";
import type { TxResult } from "@fragno-dev/db";
import { instantiate } from "@fragno-dev/core";
import { aiFragmentDefinition } from "./definition";

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
});
