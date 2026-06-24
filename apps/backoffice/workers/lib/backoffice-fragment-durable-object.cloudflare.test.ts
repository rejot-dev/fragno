import { runInDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vitest";

import { env } from "cloudflare:workers";

import { createBackofficeFragmentDurableObject } from "./backoffice-fragment-durable-object";

type TestStoredConfig = {
  scope: { kind: "org"; orgId: string };
  value: string;
};

type TestOutboxItem = {
  id: string;
  type: string;
  createdAt: string;
  dispatchedAt?: string;
  attempts?: number;
  lastError?: string;
  payload: string;
  failUntilAttempt?: number;
};

type OutboxHarnessEnv = typeof env & {
  OUTBOX_HARNESS: DurableObjectNamespace;
};

const getStub = (name: string) => {
  const namespace = (env as OutboxHarnessEnv).OUTBOX_HARNESS;
  return namespace.get(namespace.idFromName(name));
};

const runOutboxHarness = async <TResult>(
  stub: DurableObjectStub,
  callback: (harness: {
    host: ReturnType<
      typeof createBackofficeFragmentDurableObject<
        TestStoredConfig,
        TestStoredConfig,
        Record<string, never>,
        TestOutboxItem
      >
    >;
    state: DurableObjectState;
  }) => Promise<TResult> | TResult,
) =>
  await runInDurableObject(stub, async (_instance, state) => {
    const host = createBackofficeFragmentDurableObject<
      TestStoredConfig,
      TestStoredConfig,
      Record<string, never>,
      TestOutboxItem
    >({
      name: "OutboxHarness",
      state,
      env: env as unknown as CloudflareEnv,
      configKey: "outbox-harness-config",
      outboxKey: "outbox-harness-outbox",
      createRuntime: () => ({}),
      outbox: {
        retryDelayMs: 1,
        dispatch: async (item) => {
          const attempts = item.attempts ?? 0;
          if (item.failUntilAttempt !== undefined && attempts < item.failUntilAttempt) {
            throw new Error(`planned failure ${attempts + 1}`);
          }

          if (item.payload === "enqueue-during-dispatch") {
            await state.storage.put("outbox-harness-outbox:event-concurrent", {
              id: "event-concurrent",
              type: "test.event",
              createdAt: "2026-06-09T00:01:00.000Z",
              payload: "concurrent",
            });
          }

          const dispatches =
            (await state.storage.get<Array<{ id: string; payload: string }>>("dispatches")) ?? [];
          await state.storage.put("dispatches", [
            ...dispatches,
            { id: item.id, payload: item.payload },
          ]);
        },
      },
    });

    await state.storage.put("outbox-harness-config", {
      scope: { kind: "org", orgId: "org-1" },
      value: "configured",
    });
    return await callback({ host, state });
  });

describe("createBackofficeFragmentDurableObject outbox", () => {
  test("persists an outbox item and dispatches it from alarm processing", async () => {
    const stub = getStub("outbox-success");

    await runOutboxHarness(stub, async ({ host }) => {
      await host.dispatch({
        id: "event-1",
        type: "test.event",
        createdAt: "2026-06-09T00:00:00.000Z",
        payload: "hello",
      });
    });

    await expect(
      runOutboxHarness(stub, async ({ state }) => (await state.storage.get("dispatches")) ?? []),
    ).resolves.toEqual([]);

    await runOutboxHarness(stub, async ({ host }) => {
      await host.alarm();
    });

    await expect(
      runOutboxHarness(stub, async ({ state }) => ({
        dispatches: (await state.storage.get("dispatches")) ?? [],
        outbox: [
          ...(
            await state.storage.list<TestOutboxItem>({ prefix: "outbox-harness-outbox:" })
          ).values(),
        ],
      })),
    ).resolves.toMatchObject({
      dispatches: [{ id: "event-1", payload: "hello" }],
      outbox: [{ id: "event-1", dispatchedAt: expect.any(String), lastError: undefined }],
    });
  });

  test("preserves outbox items added while dispatch is running", async () => {
    const stub = getStub("outbox-concurrent-append");

    await runOutboxHarness(stub, async ({ host }) => {
      await host.dispatch({
        id: "event-1",
        type: "test.event",
        createdAt: "2026-06-09T00:00:00.000Z",
        payload: "enqueue-during-dispatch",
      });
    });

    await runOutboxHarness(stub, async ({ host }) => {
      await host.alarm();
    });

    await expect(
      runOutboxHarness(stub, async ({ state }) => [
        ...(
          await state.storage.list<TestOutboxItem>({ prefix: "outbox-harness-outbox:" })
        ).values(),
      ]),
    ).resolves.toMatchObject([
      { id: "event-1", dispatchedAt: expect.any(String) },
      { id: "event-concurrent" },
    ]);
  });

  test("records failed attempts and retries pending items on the next alarm processing", async () => {
    const stub = getStub("outbox-retry");

    await runOutboxHarness(stub, async ({ host }) => {
      await host.dispatch({
        id: "event-retry",
        type: "test.event",
        createdAt: "2026-06-09T00:00:00.000Z",
        payload: "retry me",
        failUntilAttempt: 1,
      });
    });

    await runOutboxHarness(stub, async ({ host }) => {
      await host.alarm();
    });

    await expect(
      runOutboxHarness(stub, async ({ state }) => ({
        dispatches: (await state.storage.get("dispatches")) ?? [],
        outbox: [
          ...(
            await state.storage.list<TestOutboxItem>({ prefix: "outbox-harness-outbox:" })
          ).values(),
        ],
      })),
    ).resolves.toMatchObject({
      dispatches: [],
      outbox: [{ id: "event-retry", attempts: 1, lastError: "planned failure 1" }],
    });

    await runOutboxHarness(stub, async ({ host }) => {
      await host.alarm();
    });

    await expect(
      runOutboxHarness(stub, async ({ state }) => ({
        dispatches: (await state.storage.get("dispatches")) ?? [],
        outbox: [
          ...(
            await state.storage.list<TestOutboxItem>({ prefix: "outbox-harness-outbox:" })
          ).values(),
        ],
      })),
    ).resolves.toMatchObject({
      dispatches: [{ id: "event-retry", payload: "retry me" }],
      outbox: [
        { id: "event-retry", attempts: 1, dispatchedAt: expect.any(String), lastError: undefined },
      ],
    });
  });
});
