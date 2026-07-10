import { describe, expect, it, assert } from "vitest";

import { workflowsSchema } from "@fragno-dev/workflows/schema";
import {
  IDBCursor,
  IDBDatabase,
  IDBFactory,
  IDBIndex,
  IDBKeyRange,
  IDBObjectStore,
  IDBOpenDBRequest,
  IDBRequest,
  IDBTransaction,
} from "fake-indexeddb";

import {
  IndexedDbAdapter,
  createLofiQueryStore,
  createLofiRuntime,
  uowOperationsToLofiMutations,
  type LofiMutation,
  type LofiRuntime,
} from "@fragno-dev/lofi";

import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";

import { recordFauxPiHarnessPrompt } from "../pi-test-utils";
import {
  emptyPiWorkflowSessionProjectionState,
  projectPiWorkflowSession,
} from "../workflow-session-projection";
import type { PiHarnessInternalOptions } from "./run-pi-harness-step";

const workflowName = "outbox-size-benchmark";
const responseText = "x".repeat(10_000);

const serializedByteSize = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value), "utf8");

const installFakeIndexedDb = () => {
  globalThis.indexedDB = new IDBFactory();
  globalThis.IDBCursor = IDBCursor;
  globalThis.IDBDatabase = IDBDatabase;
  globalThis.IDBIndex = IDBIndex;
  globalThis.IDBKeyRange = IDBKeyRange;
  globalThis.IDBObjectStore = IDBObjectStore;
  globalThis.IDBOpenDBRequest = IDBOpenDBRequest;
  globalThis.IDBRequest = IDBRequest;
  globalThis.IDBTransaction = IDBTransaction;
};

const recordOutboxMutations = async (
  sessionId: string,
  internal?: PiHarnessInternalOptions,
): Promise<LofiMutation[]> => {
  const recording = await recordFauxPiHarnessPrompt({
    workflowName,
    sessionId,
    operation: { kind: "prompt", args: ["measure stream size"] },
    responses: [fauxAssistantMessage(fauxText(responseText), { timestamp: 1 })],
    fauxProviderOptions: { tokenSize: { min: 1, max: 1 }, tokensPerSecond: 0 },
    internal,
  });

  return uowOperationsToLofiMutations(recording.mutations);
};

const recordOutboxSize = async (internal?: PiHarnessInternalOptions): Promise<number> =>
  serializedByteSize(
    await recordOutboxMutations(
      `message-update-${internal?.compactMessageUpdateEmissions === false ? "legacy" : "compact"}`,
      internal,
    ),
  );

type ProjectionInput = Parameters<typeof projectPiWorkflowSession>[0];
type MeasuredProjectionMetrics = { projectionRuns: number; projectionMs: number };

const createMeasuredSessionProjectionDataStore = (
  runtime: LofiRuntime,
  sessionId: string,
  metrics: MeasuredProjectionMetrics,
) =>
  createLofiQueryStore(
    runtime,
    ({ forSchema }) =>
      forSchema(workflowsSchema).findFirst("workflow_instance", (instance) =>
        instance
          .whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
            eb.and(eb("workflowName", "=", workflowName), eb("instanceId", "=", sessionId)),
          )
          .joinMany("workflowSteps", "workflow_step", (step) =>
            step
              .onIndex("idx_workflow_step_instanceRef_createdAt", (eb) =>
                eb("instanceRef", "=", eb.parent("id")),
              )
              .orderByIndex("idx_workflow_step_instanceRef_createdAt", "asc"),
          )
          .joinMany("workflowStepEmissions", "workflow_step_emission", (emission) =>
            emission
              .onIndex("idx_workflow_step_emission_instance_createdAt_sequence_id", (eb) =>
                eb("instanceRef", "=", eb.parent("id")),
              )
              .orderByIndex("idx_workflow_step_emission_instance_createdAt_sequence_id", "asc"),
          ),
      ),
    {
      initialData: emptyPiWorkflowSessionProjectionState(),
      map: ([rawInstance]) => {
        const startedAt = performance.now();
        metrics.projectionRuns += 1;
        const instance = rawInstance as
          | (NonNullable<ProjectionInput["instance"]> & {
              workflowSteps: ProjectionInput["workflowSteps"];
              workflowStepEmissions: ProjectionInput["workflowStepEmissions"];
            })
          | null;
        const projection = projectPiWorkflowSession({
          workflowName,
          sessionId,
          instance,
          workflowSteps: instance?.workflowSteps ?? [],
          workflowStepEmissions: instance?.workflowStepEmissions ?? [],
        });
        metrics.projectionMs += performance.now() - startedAt;
        return projection;
      },
    },
  );

type MeasuredProjectionStore = ReturnType<typeof createMeasuredSessionProjectionDataStore>;
type MeasuredProjectionState = ReturnType<MeasuredProjectionStore["get"]>;

const waitForSettledProjectionUpdate = (
  store: MeasuredProjectionStore,
  previousUpdatedAt: number | undefined,
): Promise<ReturnType<typeof store.get>> =>
  waitForProjectionState(
    store,
    (state) =>
      state.synced &&
      !state.loading &&
      state.updatedAt !== undefined &&
      state.updatedAt !== previousUpdatedAt,
  );

const waitForProjectionState = (
  store: MeasuredProjectionStore,
  predicate: (state: MeasuredProjectionState) => boolean,
  timeoutMs = 5000,
): Promise<MeasuredProjectionState> => {
  const current = store.get();
  if (predicate(current)) {
    return Promise.resolve(current);
  }

  return new Promise((resolve, reject) => {
    let unlisten: () => void = () => undefined;
    const timeout = setTimeout(() => {
      unlisten();
      reject(new Error("Timed out waiting for projection state."));
    }, timeoutMs);
    unlisten = store.listen((state) => {
      if (predicate(state)) {
        clearTimeout(timeout);
        unlisten();
        resolve(state);
      }
    });
  });
};

const chunked = <T>(items: readonly T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
};

const delay = async (ms: number): Promise<void> =>
  await new Promise((resolve) => setTimeout(resolve, ms));

const projectedAssistantTextLength = (state: MeasuredProjectionState): number => {
  const message = state.data.state.messages.at(-1);
  if (message?.role !== "assistant") {
    return 0;
  }
  const content = message.content[0];
  return content?.type === "text" ? content.text.length : 0;
};

describe("runPiHarnessStep outbox stream size", () => {
  it("uses compact message_update emissions by default", async () => {
    expect(await recordOutboxSize()).toBeLessThan(2_000_000);
  });

  it("measures compact projection query/store update cost", async () => {
    const sessionId = "compact-projection-compute";
    const mutations = await recordOutboxMutations(sessionId);
    const mutationBytes = serializedByteSize(mutations);

    installFakeIndexedDb();
    const adapter = new IndexedDbAdapter({
      dbName: `pi-harness-outbox-size-${Math.random().toString(16).slice(2)}`,
      endpointName: "pi-harness-outbox-size",
      schemas: [{ schema: workflowsSchema }],
    });
    const runtime = createLofiRuntime({
      endpointName: "pi-harness-outbox-size",
      adapter,
      outboxUrl: "https://example.com/outbox",
      fetch: (async () => new Response(JSON.stringify([]))) as typeof fetch,
    });
    const metrics = { projectionRuns: 0, projectionMs: 0 };
    const store = createMeasuredSessionProjectionDataStore(runtime, sessionId, metrics);
    let storeUpdates = 0;
    const unlisten = store.listen(() => {
      storeUpdates += 1;
    });

    try {
      await runtime.whenBootstrapped();
      await store.refresh();
      const previousUpdatedAt = store.get().updatedAt;

      const applyStart = performance.now();
      await adapter.applyMutations(mutations);
      const applyMs = performance.now() - applyStart;

      const projectionUpdate = waitForSettledProjectionUpdate(store, previousUpdatedAt);
      const refreshStart = performance.now();
      runtime.refresh();
      const state = await projectionUpdate;
      const refreshToProjectionMs = performance.now() - refreshStart;

      const message = state.data.state.messages.at(-1);
      assert(message?.role === "assistant");
      if (message?.role === "assistant") {
        const content = message.content[0];
        assert(content?.type === "text");
        if (content?.type === "text") {
          expect(content.text).toHaveLength(responseText.length);
        }
      }
      expect(storeUpdates).toBeGreaterThan(0);
      expect(applyMs).toBeGreaterThanOrEqual(0);
      expect(refreshToProjectionMs).toBeGreaterThanOrEqual(0);
      console.info("compact projection query/store update cost", {
        mutationCount: mutations.length,
        mutationBytes,
        storeUpdates,
        applyMs,
        refreshToProjectionMs,
        projectionRuns: metrics.projectionRuns,
        projectionMs: metrics.projectionMs,
        queryAndStoreMs: refreshToProjectionMs - metrics.projectionMs,
      });
    } finally {
      unlisten();
    }
  });

  it("measures mounted compact projection under repeated refresh churn", async () => {
    const sessionId = "compact-mounted-refresh-churn";
    const mutations = await recordOutboxMutations(sessionId);
    const baseMutations = mutations.filter(
      (mutation) => mutation.table !== "workflow_step_emission",
    );
    const emissionChunks = chunked(
      mutations.filter((mutation) => mutation.table === "workflow_step_emission"),
      250,
    );

    installFakeIndexedDb();
    const adapter = new IndexedDbAdapter({
      dbName: `pi-harness-outbox-churn-${Math.random().toString(16).slice(2)}`,
      endpointName: "pi-harness-outbox-churn",
      schemas: [{ schema: workflowsSchema }],
    });
    await adapter.applyMutations(baseMutations);
    const runtime = createLofiRuntime({
      endpointName: "pi-harness-outbox-churn",
      adapter,
      outboxUrl: "https://example.com/outbox",
      fetch: (async () => new Response(JSON.stringify([]))) as typeof fetch,
    });
    const metrics = { projectionRuns: 0, projectionMs: 0 };
    const store = createMeasuredSessionProjectionDataStore(runtime, sessionId, metrics);
    let storeUpdates = 0;
    const unlisten = store.listen(() => {
      storeUpdates += 1;
    });

    try {
      await runtime.whenBootstrapped();
      await store.refresh();

      const finalProjection = waitForProjectionState(
        store,
        (state) => projectedAssistantTextLength(state) === responseText.length,
        10_000,
      );
      let applyMs = 0;
      const startedAt = performance.now();
      for (const chunk of emissionChunks) {
        const applyStartedAt = performance.now();
        await adapter.applyMutations(chunk);
        applyMs += performance.now() - applyStartedAt;
        runtime.refresh();
        await delay(16);
      }
      const finalState = await finalProjection;
      const elapsedMs = performance.now() - startedAt;

      expect(projectedAssistantTextLength(finalState)).toBe(responseText.length);
      console.info("mounted compact projection refresh churn", {
        mutationCount: mutations.length,
        emissionCount: mutations.length - baseMutations.length,
        emissionChunks: emissionChunks.length,
        refreshCount: emissionChunks.length,
        storeUpdates,
        elapsedMs,
        applyMs,
        projectionRuns: metrics.projectionRuns,
        projectionMs: metrics.projectionMs,
        averageProjectionMs: metrics.projectionMs / metrics.projectionRuns,
      });
    } finally {
      unlisten();
    }
  });

  it("can reproduce the ~50MB outbox payload from full message_update snapshots", async () => {
    const size = await recordOutboxSize({ compactMessageUpdateEmissions: false });

    expect(size).toBeGreaterThan(50_000_000);
    expect(size).toBeLessThan(56_000_000);
  });
});
