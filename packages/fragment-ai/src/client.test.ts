import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { buildDatabaseFragmentsTest } from "@fragno-dev/test";
import { instantiate } from "@fragno-dev/core";
import { aiFragmentDefinition } from "./definition";
import { aiRoutesFactory } from "./routes";
import { createAiFragmentClients } from "./index";

const mockOpenAIStreamEvents = [
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

vi.mock("openai", () => {
  return {
    default: class MockOpenAI {
      responses = {
        create: mockOpenAICreate,
      };
    },
  };
});

describe("AI Fragment Client", () => {
  const setup = async () => {
    const { fragments, test: testContext } = await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "drizzle-pglite" })
      .withFragment(
        "ai",
        instantiate(aiFragmentDefinition)
          .withConfig({
            defaultModel: { id: "gpt-test" },
            apiKey: "test-key",
          })
          .withRoutes([aiRoutesFactory]),
      )
      .build();

    return { fragments, testContext };
  };

  type Setup = Awaited<ReturnType<typeof setup>>;

  let testContext: Setup["testContext"];
  let fragment: Setup["fragments"]["ai"]["fragment"];

  beforeAll(async () => {
    const setupResult = await setup();
    testContext = setupResult.testContext;
    fragment = setupResult.fragments.ai.fragment;
  });

  beforeEach(async () => {
    await testContext.resetDatabase();
    mockOpenAICreate.mockClear();
    vi.stubGlobal("window", {} as Window);
    vi.stubGlobal("addEventListener", vi.fn());
    vi.stubGlobal("removeEventListener", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("startRunStream should update stream stores and invalidate runs list", async () => {
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

    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      return fragment.handler(request);
    });

    const clients = createAiFragmentClients({
      baseUrl: "http://localhost",
      fetcherConfig: { type: "function", fetcher },
    });

    const runsStore = clients.useRuns.store({ path: { threadId: thread.data.id } });

    type RunsStoreValue = {
      loading?: boolean;
      data?: { runs?: Array<unknown> };
    };

    const waitForStore = (
      predicate: (value: RunsStoreValue) => boolean,
      store: { listen: (callback: (value: unknown) => void) => () => void },
    ) =>
      new Promise<RunsStoreValue>((resolve) => {
        const unsubscribe = store.listen((value) => {
          const typedValue = value as RunsStoreValue;
          if (predicate(typedValue)) {
            unsubscribe();
            resolve(typedValue);
          }
        });
      });

    await waitForStore((value) => !value.loading && value.data?.runs?.length === 0, runsStore);

    const runStream = clients.useRunStream.obj;
    await runStream.startRunStream({
      threadId: thread.data.id,
      input: { inputMessageId: message.data.id, type: "agent" },
    });

    const runsResult = await waitForStore(
      (value) => !value.loading && value.data?.runs?.length === 1,
      runsStore,
    );

    expect(runsResult.data?.runs).toHaveLength(1);
    expect(runStream.text.get()).toBe("Hello world");
    expect(runStream.events.get().some((event) => event.type === "run.final")).toBe(true);

    const runsCalls = fetcher.mock.calls.filter(([input, init]) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const method = request.method ?? "GET";
      return method === "GET" && url.pathname.endsWith(`/api/ai/threads/${thread.data.id}/runs`);
    });

    expect(runsCalls.length).toBeGreaterThanOrEqual(2);
  });
});
