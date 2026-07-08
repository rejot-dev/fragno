import { beforeEach, describe, expect, it, assert } from "vitest";

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

import {
  IndexedDbAdapter,
  InMemoryLofiAdapter,
  createLofiRuntime,
  type LofiMutation,
} from "@fragno-dev/lofi";

import type { AgentMessage, SessionTreeEntry } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxText, type UserMessage } from "@earendil-works/pi-ai";

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
  entries,
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
    fetch: (async () => new Response(JSON.stringify([]))) as typeof fetch,
  });
  return { runtime };
};

const waitFor = async (predicate: () => boolean, timeoutMs = 1000): Promise<void> => {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for predicate.");
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
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
      fetch: (async () => new Response(JSON.stringify([]))) as typeof fetch,
    });
    const store = createSessionProjectionDataStore(runtime, workflowName, sessionId);
    const unsubscribe = store.subscribe(() => undefined);

    await waitFor(() => store.get().data.status === "ready");

    expect(store.get().data.state.messages.map(messageText)).toEqual(["indexed committed"]);
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

    await waitFor(() => store.get().data.status === "ready");
    unsubscribe();
  });
});
