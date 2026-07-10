import { describe, expect, it, assert } from "vitest";

import { FragnoId } from "@fragno-dev/db/schema";
import { buildScopedInstanceRowId } from "@fragno-dev/workflows/instance-ref";
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

import type { OutboxEntry, OutboxPayload } from "@fragno-dev/db";
import {
  IndexedDbAdapter,
  createLofiQueryStore,
  createLofiRuntime,
  uowOperationsToLofiMutations,
  type LofiMutation,
  type LofiRuntime,
} from "@fragno-dev/lofi";

import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";

import { createSessionProjectionDataStore } from "../../client/workflow-lofi-session-projection";
import { recordFauxPiHarnessPrompt } from "../pi-test-utils";
import {
  emptyPiWorkflowSessionProjectionState,
  projectPiWorkflowSession,
  type PiWorkflowSessionProjectionState,
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

  return uowOperationsToLofiMutations(recording.mutations, {
    now: new Date("2026-07-03T00:00:00.000Z"),
  });
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

const nextSettledProjectionUpdate = (
  store: MeasuredProjectionStore,
  previousUpdatedAt: number | undefined,
): Promise<ReturnType<typeof store.get>> =>
  projectionStateMatching(
    store,
    (state) =>
      state.synced &&
      !state.loading &&
      state.updatedAt !== undefined &&
      state.updatedAt !== previousUpdatedAt,
  );

const projectionStateMatching = (
  store: MeasuredProjectionStore,
  predicate: (state: MeasuredProjectionState) => boolean,
): Promise<MeasuredProjectionState> => {
  const current = store.get();
  if (predicate(current)) {
    return Promise.resolve(current);
  }

  return new Promise((resolve) => {
    let unlisten: () => void = () => undefined;
    unlisten = store.listen((state) => {
      if (predicate(state)) {
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

const withExternalWorkflowReferences = (
  mutations: readonly LofiMutation[],
  sessionId: string,
): LofiMutation[] => {
  const instanceRef = buildScopedInstanceRowId(workflowName, sessionId);
  return mutations.map((mutation) => {
    if (
      mutation.op !== "create" ||
      (mutation.table !== "workflow_step" && mutation.table !== "workflow_step_emission")
    ) {
      return mutation;
    }
    return { ...mutation, values: { ...mutation.values, instanceRef } };
  });
};

const outboxEntriesFromMutations = (mutations: readonly LofiMutation[]): OutboxEntry[] =>
  mutations.map((mutation, index) => {
    const versionstamp = `outbox-${index.toString().padStart(8, "0")}`;
    return {
      id: FragnoId.fromExternal(versionstamp, index),
      versionstamp,
      uowId: `uow-${index}`,
      payload: {
        json: {
          version: 1,
          mutations: [mutation],
        } satisfies OutboxPayload,
      },
      createdAt: new Date(index),
    };
  });

const createOutboxFetcher = (getEntries: () => readonly OutboxEntry[]): typeof fetch =>
  (async (input) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const entries = getEntries();
    const afterVersionstamp = url.searchParams.get("afterVersionstamp");
    const startIndex = afterVersionstamp
      ? entries.findIndex((entry) => entry.versionstamp === afterVersionstamp) + 1
      : 0;
    const limit = Number(url.searchParams.get("limit") ?? entries.length);
    return new Response(JSON.stringify(entries.slice(startIndex, startIndex + limit)));
  }) as typeof fetch;

const assistantTextLength = (projection: PiWorkflowSessionProjectionState): number => {
  const message = projection.draftAgentMessage?.assistant ?? projection.state.messages.at(-1);
  if (message?.role !== "assistant") {
    return 0;
  }
  const content = message.content[0];
  return content?.type === "text" ? content.text.length : 0;
};

const projectedAssistantTextLength = (state: MeasuredProjectionState): number =>
  assistantTextLength(state.data);

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

      const projectionUpdate = nextSettledProjectionUpdate(store, previousUpdatedAt);
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
  }, 10_000);

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

      let applyMs = 0;
      const startedAt = performance.now();
      for (const chunk of emissionChunks) {
        const applyStartedAt = performance.now();
        await adapter.applyMutations(chunk);
        applyMs += performance.now() - applyStartedAt;
        const projectionUpdate = nextSettledProjectionUpdate(store, store.get().updatedAt);
        runtime.refresh();
        await projectionUpdate;
      }
      const finalState = store.get();
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
  }, 10_000);

  it("measures mounted projection with ephemeral workflow emissions", async () => {
    const sessionId = "ephemeral-mounted-projection";
    const mutations = withExternalWorkflowReferences(
      await recordOutboxMutations(sessionId),
      sessionId,
    );
    const initialMutation = mutations[0];
    assert(initialMutation?.table === "workflow_instance");
    installFakeIndexedDb();
    const adapter = new IndexedDbAdapter({
      dbName: `pi-harness-ephemeral-compute-${Math.random().toString(16).slice(2)}`,
      endpointName: "pi-harness-ephemeral-compute",
      schemas: [{ schema: workflowsSchema }],
    });
    await adapter.applyMutations([initialMutation]);
    let availableEntries: readonly OutboxEntry[] = [];
    const runtime = createLofiRuntime({
      endpointName: "pi-harness-ephemeral-compute",
      adapter,
      outboxUrl: "https://example.com/outbox",
      fetch: createOutboxFetcher(() => availableEntries),
      bootstrap: false,
      pollIntervalMs: 60_000,
      ephemeralTables: [{ schema: workflowsSchema.name, table: "workflow_step_emission" }],
    });
    const store = createSessionProjectionDataStore(runtime, workflowName, sessionId);
    let storeUpdates = 0;
    const unlistenStore = store.listen(() => {
      storeUpdates += 1;
    });
    const revisions: number[] = [];
    const unlistenRevision = runtime.$revision.listen((revision) => {
      revisions.push(revision);
    });

    try {
      await runtime.syncOnce();
      await projectionStateMatching(store, (state) => state.synced && !state.loading);
      availableEntries = outboxEntriesFromMutations(mutations.slice(1));

      const startedAt = performance.now();
      const result = await runtime.syncOnce();
      await projectionStateMatching(
        store,
        (state) => assistantTextLength(state.data) === responseText.length,
      );
      const elapsedMs = performance.now() - startedAt;
      const storedEmissions = await adapter
        .createQueryEngine(workflowsSchema)
        .find("workflow_step_emission", (builder) =>
          builder.whereIndex("idx_workflow_step_emission_instance_createdAt_sequence_id"),
        );

      expect(storedEmissions).toEqual([]);
      console.info("mounted projection with ephemeral workflow emissions", {
        mutationCount: mutations.length,
        ephemeralMutationCount: mutations.filter(
          (mutation) => mutation.table === "workflow_step_emission",
        ).length,
        storedEmissionCount: storedEmissions.length,
        appliedEntries: result.appliedEntries,
        storeUpdates,
        revisions,
        elapsedMs,
      });
    } finally {
      unlistenRevision();
      unlistenStore();
    }
  });

  it("can reproduce the ~50MB outbox payload from full message_update snapshots", async () => {
    const size = await recordOutboxSize({ compactMessageUpdateEmissions: false });

    expect(size).toBeGreaterThan(50_000_000);
    expect(size).toBeLessThan(56_000_000);
  });
});
