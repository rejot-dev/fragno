import { beforeEach, describe, expect, it, assert } from "vitest";

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
  InMemoryLofiAdapter,
  createLofiRuntime,
  type LofiMutation,
} from "@fragno-dev/lofi";

import type { AgentMessage, SessionTreeEntry } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxText, type UserMessage } from "@earendil-works/pi-ai";

import { piWorkflowStepEmissionEphemeralTable } from "./pi-workflow-emission-stream";
import {
  createSessionProjectionDataStore,
  readPiWorkflowLofiSessionProjection,
} from "./workflow-lofi-session-projection";

const workflowName = "interactive-chat";
const sessionId = "session-1";
const instanceRef = buildScopedInstanceRowId(workflowName, sessionId);
const schemaName = workflowsSchema.name;

type MessageWithTextContent = AgentMessage & { content: readonly [{ text: string }] };

const assistantMessage = (text: string) => fauxAssistantMessage(fauxText(text), { timestamp: 1 });

const userMessage = (text: string): UserMessage => ({
  role: "user",
  content: [fauxText(text)],
  timestamp: 1,
});

const messageEntry = (
  id: string,
  text: string,
  options: { role?: "assistant" | "user"; parentId?: string | null } = {},
): SessionTreeEntry => ({
  type: "message",
  id,
  parentId: options.parentId ?? null,
  timestamp: "2026-07-03T00:00:00.000Z",
  message: options.role === "user" ? userMessage(text) : assistantMessage(text),
});

const harnessResult = (
  text: string,
  entries: readonly SessionTreeEntry[] = [messageEntry(`entry-${text}`, text)],
) => ({
  type: "harness-run",
  appendedEntries: entries,
});

const workflowInstanceMutation = (): LofiMutation => ({
  op: "create",
  schema: schemaName,
  table: "workflow_instance",
  externalId: instanceRef,
  versionstamp: "001",
  values: {
    workflowName,
    remoteWorkflowName: null,
    instanceId: sessionId,
    status: "active",
    params: {},
    startedAt: null,
    completedAt: null,
    output: null,
    errorName: null,
    errorMessage: null,
  },
});

const workflowEmissionMutation = (
  externalId: string,
  sequence: number,
  payload: unknown,
): LofiMutation => ({
  op: "create",
  schema: schemaName,
  table: "workflow_step_emission",
  externalId,
  versionstamp: `emission-${sequence}`,
  values: {
    instanceRef,
    stepKey: "do:agent-turn-1",
    epoch: "epoch-1",
    sequence,
    actor: "user",
    payload,
    createdAt: new Date(sequence),
  },
});

const outboxEntry = (mutations: OutboxPayload["mutations"]): OutboxEntry => ({
  id: FragnoId.fromExternal("projection-outbox-entry", 0),
  versionstamp: "outbox-001",
  uowId: "projection-uow",
  payload: { json: { version: 1, mutations } satisfies OutboxPayload },
  createdAt: new Date(),
});

const workflowStepMutation = (
  text: string,
  versionstamp: string,
  options: {
    externalId?: string;
    stepKey?: string;
    createdAt?: Date;
    entries?: readonly SessionTreeEntry[];
  } = {},
): LofiMutation => ({
  op: "create",
  schema: schemaName,
  table: "workflow_step",
  externalId: options.externalId ?? "step-1",
  versionstamp,
  values: {
    instanceRef,
    stepKey: options.stepKey ?? "do:agent-turn-1",
    parentStepKey: null,
    depth: 0,
    name: "agent-turn-1",
    type: "do",
    status: "completed",
    attempts: 1,
    maxAttempts: 1,
    timeoutMs: null,
    nextRetryAt: null,
    wakeAt: null,
    waitEventType: null,
    result: harnessResult(text, options.entries),
    errorName: null,
    errorMessage: null,
    createdAt: options.createdAt ?? new Date("2026-07-03T00:00:01.000Z"),
    updatedAt: options.createdAt ?? new Date("2026-07-03T00:00:01.000Z"),
  },
});

const messageText = (message: AgentMessage): string =>
  (message as MessageWithTextContent).content[0].text;

const createRuntime = async (mutations: readonly LofiMutation[] = []) => {
  const adapter = new InMemoryLofiAdapter({
    endpointName: "pi-harness-test",
    schemas: [workflowsSchema],
  });
  await adapter.applyMutations([...mutations]);
  const runtime = createLofiRuntime({
    endpointName: "pi-harness-test",
    adapter,
    outboxUrl: "https://example.com/outbox",
    ephemeralTables: [piWorkflowStepEmissionEphemeralTable],
    fetch: (async () => new Response(JSON.stringify([]))) as typeof fetch,
  });
  return { runtime };
};

type SessionProjectionStore = ReturnType<typeof createSessionProjectionDataStore>;
type SessionProjectionStoreState = ReturnType<SessionProjectionStore["get"]>;

const storeStateMatching = (
  store: SessionProjectionStore,
  predicate: (state: SessionProjectionStoreState) => boolean,
): Promise<SessionProjectionStoreState> => {
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

describe("createSessionProjectionDataStore", () => {
  beforeEach(() => {
    installFakeIndexedDb();
  });

  it("reads completed workflow_step rows through IndexedDB", async () => {
    const adapter = new IndexedDbAdapter({
      dbName: "pi-harness-indexed-projection-test",
      endpointName: "pi-harness-test",
      schemas: [{ schema: workflowsSchema }],
    });
    await adapter.applyMutations([
      workflowInstanceMutation(),
      workflowStepMutation("indexed committed", "002"),
    ]);
    const runtime = createLofiRuntime({
      endpointName: "pi-harness-test",
      adapter,
      outboxUrl: "https://example.com/outbox",
      ephemeralTables: [piWorkflowStepEmissionEphemeralTable],
      fetch: (async () => new Response(JSON.stringify([]))) as typeof fetch,
    });
    const store = createSessionProjectionDataStore(runtime, workflowName, sessionId);
    const unsubscribe = store.subscribe(() => undefined);

    await storeStateMatching(store, (state) => state.data.status === "ready");

    expect(store.get().data.state.messages.map(messageText)).toEqual(["indexed committed"]);
    unsubscribe();
  });

  it("reduces ephemeral workflow emissions without storing or querying emission rows", async () => {
    const entry = outboxEntry([
      workflowInstanceMutation(),
      workflowEmissionMutation("operation-start", 0, {
        kind: "harness-operation-start",
        operationId: "interactive-chat:session-1:agent-turn-1",
        operation: { kind: "prompt", args: ["hello"] },
        replay: { protocol: "pi-harness-operation", version: 1 },
      }),
      workflowEmissionMutation("emission-start", 1, {
        kind: "harness-event",
        event: { type: "message_start", message: assistantMessage("") },
      }),
      workflowEmissionMutation("emission-delta", 2, {
        kind: "harness-message-update",
        update: {
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hel" },
        },
      }),
      workflowEmissionMutation("emission-delta-2", 3, {
        kind: "harness-message-update",
        update: {
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "lo" },
        },
      }),
    ]);
    const adapter = new IndexedDbAdapter({
      dbName: "pi-harness-ephemeral-projection-test",
      endpointName: "pi-harness-test",
      schemas: [{ schema: workflowsSchema }],
    });
    const runtime = createLofiRuntime({
      endpointName: "pi-harness-test",
      adapter,
      outboxUrl: "https://example.com/outbox",
      ephemeralTables: [piWorkflowStepEmissionEphemeralTable],
      fetch: (async (input) => {
        const url = new URL(typeof input === "string" ? input : input.toString());
        return new Response(
          JSON.stringify(url.searchParams.has("afterVersionstamp") ? [] : [entry]),
        );
      }) as typeof fetch,
    });
    const store = createSessionProjectionDataStore(runtime, workflowName, sessionId);
    const unsubscribe = store.subscribe(() => undefined);

    await storeStateMatching(store, (state) => {
      const assistant = state.data.draftAgentMessage?.assistant;
      return assistant?.content[0]?.type === "text" && assistant.content[0].text === "hello";
    });

    expect(
      await adapter
        .createQueryEngine(workflowsSchema)
        .find("workflow_step_emission", (builder) =>
          builder.whereIndex("idx_workflow_step_emission_instance_createdAt_sequence_id"),
        ),
    ).toEqual([]);
    assert(runtime.$revision.get() === 1);
    unsubscribe();
  });

  it("does not share mutable assistant drafts between stores", async () => {
    const entry = outboxEntry([
      workflowInstanceMutation(),
      workflowEmissionMutation("operation-start", 0, {
        kind: "harness-operation-start",
        operationId: "interactive-chat:session-1:agent-turn-1",
        operation: { kind: "prompt", args: ["hello"] },
        replay: { protocol: "pi-harness-operation", version: 1 },
      }),
      workflowEmissionMutation("message-start", 1, {
        kind: "harness-event",
        event: { type: "message_start", message: assistantMessage("") },
      }),
      workflowEmissionMutation("message-delta", 2, {
        kind: "harness-message-update",
        update: {
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello" },
        },
      }),
    ]);
    const adapter = new IndexedDbAdapter({
      dbName: "pi-harness-ephemeral-store-isolation-test",
      endpointName: "pi-harness-test",
      schemas: [{ schema: workflowsSchema }],
    });
    const runtime = createLofiRuntime({
      endpointName: "pi-harness-test",
      adapter,
      outboxUrl: "https://example.com/outbox",
      ephemeralTables: [piWorkflowStepEmissionEphemeralTable],
      fetch: (async (input) => {
        const url = new URL(typeof input === "string" ? input : input.toString());
        return new Response(
          JSON.stringify(url.searchParams.has("afterVersionstamp") ? [] : [entry]),
        );
      }) as typeof fetch,
    });
    const firstStore = createSessionProjectionDataStore(runtime, workflowName, sessionId);
    const secondStore = createSessionProjectionDataStore(runtime, workflowName, sessionId);
    const unsubscribeFirst = firstStore.subscribe(() => undefined);
    const unsubscribeSecond = secondStore.subscribe(() => undefined);

    await Promise.all([
      storeStateMatching(firstStore, (state) => state.synced),
      storeStateMatching(secondStore, (state) => state.synced),
    ]);

    const assistantText = (store: SessionProjectionStore) => {
      const content = store.get().data.draftAgentMessage?.assistant?.content[0];
      return content?.type === "text" ? content.text : undefined;
    };
    assert(assistantText(firstStore) === "hello");
    assert(assistantText(secondStore) === "hello");

    unsubscribeFirst();
    unsubscribeSecond();
  });

  it("rebuilds an active Pi draft after the runtime reloads before the store mounts", async () => {
    const entry = outboxEntry([
      workflowInstanceMutation(),
      workflowEmissionMutation("operation-start", 0, {
        kind: "harness-operation-start",
        operationId: "interactive-chat:session-1:agent-turn-1",
        operation: { kind: "prompt", args: ["hello"] },
        replay: { protocol: "pi-harness-operation", version: 1 },
      }),
      workflowEmissionMutation("message-start", 1, {
        kind: "harness-event",
        event: { type: "message_start", message: assistantMessage("") },
      }),
      workflowEmissionMutation("message-delta", 2, {
        kind: "harness-message-update",
        update: {
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello" },
        },
      }),
    ]);
    const adapter = new IndexedDbAdapter({
      dbName: "pi-harness-ephemeral-reload-test",
      endpointName: "pi-harness-test",
      schemas: [{ schema: workflowsSchema }],
    });
    const createRuntimeForReload = () =>
      createLofiRuntime({
        endpointName: "pi-harness-test",
        adapter,
        outboxUrl: "https://example.com/outbox",
        ephemeralTables: [piWorkflowStepEmissionEphemeralTable],
        fetch: (async (input) => {
          const url = new URL(typeof input === "string" ? input : input.toString());
          return new Response(
            JSON.stringify(url.searchParams.has("afterVersionstamp") ? [] : [entry]),
          );
        }) as typeof fetch,
      });

    await createRuntimeForReload().syncOnce();

    const reloadedRuntime = createRuntimeForReload();
    await reloadedRuntime.syncOnce();
    const store = createSessionProjectionDataStore(reloadedRuntime, workflowName, sessionId);
    const unsubscribe = store.subscribe(() => undefined);

    const state = await storeStateMatching(store, (current) => {
      const assistant = current.data.draftAgentMessage?.assistant;
      return assistant?.content[0]?.type === "text" && assistant.content[0].text === "hello";
    });

    expect(state.data.draftAgentMessage?.assistant?.content).toEqual([
      expect.objectContaining({ type: "text", text: "hello" }),
    ]);
    unsubscribe();
  });

  it("replays completed workflow steps by creation time instead of step key", async () => {
    const olderEntry = messageEntry("entry-shared", "old snapshot");
    const newerEntry = messageEntry("entry-shared", "new snapshot");
    const { runtime } = await createRuntime([
      workflowInstanceMutation(),
      workflowStepMutation("old snapshot", "002", {
        externalId: "step-z",
        stepKey: "do:z-older",
        createdAt: new Date("2026-07-03T00:00:01.000Z"),
        entries: [olderEntry],
      }),
      workflowStepMutation("new snapshot", "003", {
        externalId: "step-a",
        stepKey: "do:a-newer",
        createdAt: new Date("2026-07-03T00:00:02.000Z"),
        entries: [newerEntry],
      }),
    ]);

    const projection = await readPiWorkflowLofiSessionProjection(runtime, {
      workflowName,
      sessionId,
    });

    expect(projection.state.messages.map(messageText)).toEqual(["new snapshot"]);
  });

  it("keeps loader-provided state visible while lofi is bootstrapping", async () => {
    const store = createSessionProjectionDataStore(
      (await createRuntime([workflowInstanceMutation()])).runtime,
      workflowName,
      sessionId,
      {
        initialState: { messages: [userMessage("server prompt")] },
      },
    );
    const unsubscribe = store.subscribe(() => undefined);

    assert(store.get().data.status === "loading");
    expect(store.get().data.state.messages.map(messageText)).toEqual(["server prompt"]);

    await storeStateMatching(store, (state) => state.data.status === "ready");
    unsubscribe();
  });
});
