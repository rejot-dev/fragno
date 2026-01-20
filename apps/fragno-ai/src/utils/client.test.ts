import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createServer, type Server } from "node:http";
import { instantiate } from "@fragno-dev/core";
import { buildDatabaseFragmentsTest } from "@fragno-dev/test";
import { aiFragmentDefinition, aiRoutesFactory } from "@fragno-dev/fragment-ai";
import { toNodeHandler } from "@fragno-dev/node";
import { createClient } from "./client.js";

describe("AI CLI client", async () => {
  const { fragments, test: testContext } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "drizzle-pglite" })
    .withFragment(
      "ai",
      instantiate(aiFragmentDefinition)
        .withConfig({
          defaultModel: { id: "gpt-test" },
          apiKey: "test-key",
          defaultDeepResearchModel: { id: "gpt-deep" },
        })
        .withRoutes([aiRoutesFactory]),
    )
    .build();

  const { fragment } = fragments.ai;
  let server: Server;
  let client: ReturnType<typeof createClient>;

  beforeAll(() => {
    server = createServer(toNodeHandler(fragment.handler));
    server.listen(0);

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Server address unavailable");
    }

    const baseUrl = `http://localhost:${address.port}${fragment.mountRoute}`;
    client = createClient({
      baseUrl,
      timeoutMs: 5000,
      retries: 0,
      retryDelayMs: 0,
    });
  });

  afterAll(async () => {
    server.close();
    await testContext.cleanup();
  });

  beforeEach(async () => {
    await testContext.resetDatabase();
  });

  test("creates and fetches a thread", async () => {
    const created = await client.createThread({ title: "Demo Thread" });
    expect(created["id"]).toBeTruthy();

    const fetched = await client.getThread({ threadId: String(created["id"]) });
    expect(fetched["title"]).toBe("Demo Thread");
  });

  test("appends and lists messages", async () => {
    const thread = await client.createThread({ title: "Message Thread" });
    const threadId = String(thread["id"]);

    await client.appendMessage({
      threadId,
      role: "user",
      content: { type: "text", text: "Hello" },
      text: "Hello",
    });

    const response = await client.listMessages({ threadId });
    expect(response.messages.length).toBe(1);
    expect(response.messages[0]?.["role"]).toBe("user");
  });

  test("creates and lists runs", async () => {
    const thread = await client.createThread({ title: "Run Thread" });
    const threadId = String(thread["id"]);

    const message = await client.appendMessage({
      threadId,
      role: "user",
      content: { type: "text", text: "Run it" },
      text: "Run it",
    });

    const run = await client.createRun({
      threadId,
      inputMessageId: String(message["id"]),
    });

    expect(run["id"]).toBeTruthy();

    const response = await client.listRuns({ threadId });
    expect(response.runs.length).toBe(1);
  });
});
