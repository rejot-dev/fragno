import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { buildDatabaseFragmentsTest } from "@fragno-dev/test";
import { instantiate } from "@fragno-dev/core";
import { aiFragmentDefinition } from "./definition";
import { aiRoutesFactory } from "./routes";
import OpenAI from "openai";

const mockOpenAIStreamEvents = [
  { type: "response.created", response: { id: "resp_test" } },
  { type: "response.output_text.delta", delta: "Hello " },
  { type: "response.output_text.delta", delta: "world" },
  { type: "response.output_text.done", text: "Hello world" },
];

const mockOpenAICreate = vi.fn(async () => {
  async function* stream() {
    for (const event of mockOpenAIStreamEvents) {
      await Promise.resolve();
      yield event;
    }
  }

  return stream();
});

const mockOpenAIWebhookUnwrap = vi.fn(async () => {
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
      };

      webhooks = {
        unwrap: mockOpenAIWebhookUnwrap,
      };
    },
  };
});

describe("AI Fragment Routes", () => {
  const setup = async () => {
    const { fragments, test: testContext } = await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "drizzle-pglite" })
      .withFragment(
        "ai",
        instantiate(aiFragmentDefinition)
          .withConfig({
            defaultModel: { id: "gpt-test" },
            apiKey: "test-key",
            webhookSecret: "whsec_test",
          })
          .withRoutes([aiRoutesFactory]),
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

  test("runs stream route should stream events and finalize run", async () => {
    const thread = await fragment.callRoute("POST", "/threads", {
      body: { title: "Stream Thread" },
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
    expect(runEventTypes).toEqual(["run.meta", "output.text.done", "run.final"]);

    expect(mockOpenAICreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-test",
        stream: true,
      }),
    );
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
      seq: 1,
      type: "run.meta",
      payload: { ok: true },
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });

    await db.create("ai_run_event", {
      runId: run.data.id,
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
