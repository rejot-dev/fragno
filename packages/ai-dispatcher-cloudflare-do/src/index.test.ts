import { beforeEach, describe, expect, test, vi } from "vitest";
import { buildDatabaseFragmentsTest } from "@fragno-dev/test";
import { instantiate } from "@fragno-dev/core";
import type { TxResult } from "@fragno-dev/db";
import {
  aiFragmentDefinition,
  aiRoutesFactory,
  aiSchema,
  type AiFragmentConfig,
} from "@fragno-dev/fragment-ai";
import { createAiDispatcherDurableObject, type AiDispatcherDurableObjectState } from "./index";

const mockOpenAICreate = vi.fn(async () => {
  return {
    id: "resp_test",
    output_text: "Background response",
  } as { id: string; output_text?: string };
});

vi.mock("openai", () => {
  return {
    default: class MockOpenAI {
      responses = {
        create: mockOpenAICreate,
        retrieve: vi.fn(),
      };
    },
  };
});

describe("ai durable object dispatcher", async () => {
  const config: AiFragmentConfig = {
    defaultModel: { id: "gpt-test" },
    defaultDeepResearchModel: { id: "gpt-deep-research" },
    apiKey: "test-key",
  };

  const { fragments, test: testContext } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "drizzle-pglite" })
    .withFragment(
      "ai",
      instantiate(aiFragmentDefinition).withConfig(config).withRoutes([aiRoutesFactory]),
    )
    .build();

  const { fragment } = fragments.ai;
  const namespace = fragment.$internal.deps.namespace;
  const db = testContext.adapter.createQueryEngine(aiSchema, namespace);

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

  const createHandler = (alarmCalls: number[]) => {
    class Cursor {
      next() {
        return { done: true as const };
      }
      toArray() {
        return [];
      }
      one() {
        return {};
      }
      raw() {
        return [][Symbol.iterator]();
      }
      columnNames: string[] = [];
      get rowsRead() {
        return 0;
      }
      get rowsWritten() {
        return 0;
      }
      [Symbol.iterator]() {
        return [][Symbol.iterator]();
      }
    }

    const state = {
      id: {
        toString: () => "do-test",
        equals: (other: { toString(): string }) => other.toString() === "do-test",
      },
      storage: {
        sql: {
          exec: () => new Cursor(),
          Cursor,
          Statement: class {},
        },
        transaction: async <T>(closure: (txn: { rollback(): void }) => Promise<T>) =>
          await closure({ rollback: () => {} }),
        setAlarm: async (timestamp: number | Date) => {
          const value = typeof timestamp === "number" ? timestamp : timestamp.getTime();
          alarmCalls.push(value);
        },
        deleteAlarm: async () => {
          alarmCalls.push(-1);
        },
      },
      blockConcurrencyWhile: (_callback: () => Promise<void>) => {},
    } as unknown as AiDispatcherDurableObjectState;

    return createAiDispatcherDurableObject({
      namespace,
      createAdapter: () => testContext.adapter,
      migrateOnStartup: false,
      tickOptions: { maxRuns: 5, maxWebhookEvents: 5 },
      fragmentConfig: config,
    })(state, {});
  };

  test("executes runner ticks via fetch", async () => {
    const alarmCalls: number[] = [];
    const handler = createHandler(alarmCalls);

    const thread = await runService<{ id: string }>(() =>
      fragment.services.createThread({ title: "Tick Thread" }),
    );

    const message = await runService<{ id: string }>(() =>
      fragment.services.appendMessage({
        threadId: thread.id,
        role: "user",
        content: { type: "text", text: "Run this" },
        text: "Run this",
      }),
    );

    await runService<{ id: string }>(() =>
      fragment.services.createRun({
        threadId: thread.id,
        inputMessageId: message.id,
        executionMode: "background",
        type: "agent",
      }),
    );

    const tickResponse = await handler.fetch(
      new Request("https://example.com/api/ai/_runner/tick", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ maxRuns: 5, maxWebhookEvents: 5 }),
      }),
    );

    expect(tickResponse.ok).toBe(true);

    const result = (await tickResponse.json()) as {
      processedRuns: number;
      processedWebhookEvents: number;
    };
    expect(result.processedRuns).toBeGreaterThan(0);
    expect(result.processedWebhookEvents).toBe(0);

    expect(result.processedRuns).toBeGreaterThanOrEqual(0);
    expect(result.processedWebhookEvents).toBeGreaterThanOrEqual(0);
  });

  test("schedules alarms for future wakeups", async () => {
    const alarmCalls: number[] = [];
    const handler = createHandler(alarmCalls);

    const thread = await runService<{ id: string }>(() =>
      fragment.services.createThread({ title: "Alarm Thread" }),
    );

    const message = await runService<{ id: string }>(() =>
      fragment.services.appendMessage({
        threadId: thread.id,
        role: "user",
        content: { type: "text", text: "Wait" },
        text: "Wait",
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

    const nextAttemptAt = new Date(Date.now() + 50);
    await db.update("ai_run", run.id, (b) => b.set({ nextAttemptAt }));

    const start = Date.now();
    const tickResponse = await handler.fetch(
      new Request("https://example.com/api/ai/_runner/tick", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ maxRuns: 1, maxWebhookEvents: 1 }),
      }),
    );

    expect(tickResponse.ok).toBe(true);
    expect(alarmCalls.length).toBeGreaterThan(0);
    expect(alarmCalls[alarmCalls.length - 1]).toBeGreaterThanOrEqual(start);
  });
});
