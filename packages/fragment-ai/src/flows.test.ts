import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { buildDatabaseFragmentsTest } from "@fragno-dev/test";
import { instantiate } from "@fragno-dev/core";
import { aiFragmentDefinition } from "./definition";
import { aiRoutesFactory } from "./routes";
import { createAiRunner } from "./runner";

const mockOpenAIStreamEvents = [
  { type: "response.created", response: { id: "resp_stream" } },
  { type: "response.output_text.delta", delta: "Hello " },
  { type: "response.output_text.done", text: "Hello world" },
];

const mockOpenAICreate = vi.fn(async (options?: { stream?: boolean; background?: boolean }) => {
  if (options?.stream) {
    async function* stream() {
      for (const event of mockOpenAIStreamEvents) {
        await Promise.resolve();
        yield event;
      }
    }
    return stream();
  }

  if (options?.background) {
    return { id: "resp_deep", status: "completed" };
  }

  return { id: "resp_bg", status: "completed", output_text: "Background response" };
});

const mockOpenAIRetrieve = vi.fn(async (responseId?: string) => {
  return {
    id: responseId ?? "resp_deep",
    status: "completed",
    output_text: "Deep research report",
  };
});

const mockOpenAIWebhookUnwrap = vi.fn(async () => {
  return {
    id: "evt_deep",
    type: "response.completed",
    data: { id: "resp_deep" },
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

describe("AI Fragment Example Flow", () => {
  const config = {
    defaultModel: { id: "gpt-test" },
    defaultDeepResearchModel: { id: "gpt-deep-research" },
    apiKey: "test-key",
    webhookSecret: "whsec_test",
  };

  const setup = async () => {
    const { fragments, test: testContext } = await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "drizzle-pglite" })
      .withFragment(
        "ai",
        instantiate(aiFragmentDefinition).withConfig(config).withRoutes([aiRoutesFactory]),
      )
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

  beforeEach(async () => {
    await testContext.resetDatabase();
    mockOpenAICreate.mockClear();
    mockOpenAIRetrieve.mockClear();
    mockOpenAIWebhookUnwrap.mockClear();
  });

  test("manual example flow should complete with persisted data", async () => {
    const thread = await fragment.callRoute("POST", "/threads", {
      body: { title: "Flow Thread" },
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

    const streamResponse = await fragment.callRoute("POST", "/threads/:threadId/runs:stream", {
      pathParams: { threadId: thread.data.id },
      body: { inputMessageId: message.data.id, type: "agent" },
    });
    expect(streamResponse.type).toBe("jsonStream");
    if (streamResponse.type !== "jsonStream") {
      return;
    }

    for await (const _event of streamResponse.stream) {
      // Consume stream to completion.
    }

    const backgroundRun = await fragment.callRoute("POST", "/threads/:threadId/runs", {
      pathParams: { threadId: thread.data.id },
      body: { inputMessageId: message.data.id, executionMode: "background", type: "agent" },
    });
    expect(backgroundRun.type).toBe("json");
    if (backgroundRun.type !== "json") {
      return;
    }

    const runner = createAiRunner({ db, config });
    await runner.tick({ maxRuns: 10, maxWebhookEvents: 10 });

    const deepResearchRun = await fragment.callRoute("POST", "/threads/:threadId/runs", {
      pathParams: { threadId: thread.data.id },
      body: { inputMessageId: message.data.id, executionMode: "background", type: "deep_research" },
    });
    expect(deepResearchRun.type).toBe("json");
    if (deepResearchRun.type !== "json") {
      return;
    }

    await runner.tick({ maxRuns: 10, maxWebhookEvents: 10 });

    const webhookRequest = new Request("http://localhost/api/ai/webhooks/openai", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "webhook-id": "wh_flow",
        "webhook-timestamp": "123",
        "webhook-signature": "sig",
      },
      body: JSON.stringify({ test: true }),
    });
    const webhookResponse = await fragment.handler(webhookRequest);
    expect(webhookResponse.status).toBe(200);

    await runner.tick({ maxRuns: 10, maxWebhookEvents: 10 });

    const runs = await db.find("ai_run", (b) => b.whereIndex("primary"));
    expect(runs).toHaveLength(3);
    expect(runs.some((run) => run.status === "succeeded")).toBe(true);

    const messages = await db.find("ai_message", (b) => b.whereIndex("primary"));
    expect(messages.some((msg) => msg.role === "assistant")).toBe(true);

    const artifacts = await db.find("ai_artifact", (b) => b.whereIndex("primary"));
    expect(artifacts).toHaveLength(1);

    const runEvents = await db.find("ai_run_event", (b) => b.whereIndex("primary"));
    expect(runEvents.length).toBeGreaterThan(0);
  });
});
