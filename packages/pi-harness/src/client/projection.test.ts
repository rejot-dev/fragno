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
import { Type } from "typebox";

import type { OutboxEntry, OutboxPayload } from "@fragno-dev/db";
import {
  IndexedDbAdapter,
  createLofiRuntime,
  uowOperationsToLofiMutations,
  type LofiMutation,
} from "@fragno-dev/lofi";

import type { AgentMessage, AgentTool, SessionTreeEntry } from "@earendil-works/pi-agent-core";
import {
  fauxAssistantMessage,
  fauxText,
  fauxThinking,
  fauxToolCall,
  type AssistantMessage,
} from "@earendil-works/pi-ai";

import type { PiHarnessOperation } from "../pi/harness/run-pi-harness-step";
import {
  fauxAssistantMessageWithCheckpoints,
  fauxCheckpoint,
  fauxEventCheckpoint,
  fauxThinkingWithCheckpoints,
  recordFauxPiHarnessPrompt,
  startFauxPiHarnessOperation,
} from "../pi/pi-test-utils";
import type { PiWorkflowSessionProjectionState } from "../pi/workflow-session-projection";
import { piWorkflowStepEmissionEphemeralTable } from "./pi-workflow-emission-stream";
import { createSessionProjectionDataStore } from "./workflow-lofi-session-projection";

const workflowName = "interactive-chat";
let runtimeSequence = 0;

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

const createRuntime = async (mutations: readonly LofiMutation[] = []) => {
  installFakeIndexedDb();
  const adapter = new IndexedDbAdapter({
    dbName: `pi-harness-projection-test-${runtimeSequence++}`,
    endpointName: "pi-harness-projection-test",
    schemas: [{ schema: workflowsSchema }],
  });
  const durableMutations = mutations.filter(
    (mutation) => mutation.table !== "workflow_step_emission",
  );
  const workflowInstanceRef = durableMutations.find(
    (mutation) => mutation.table === "workflow_instance",
  )?.externalId;
  const startedStreams = new Set<string>();
  const ephemeralMutations = mutations
    .filter((mutation) => mutation.table === "workflow_step_emission")
    .flatMap((mutation, index): LofiMutation[] => {
      if (mutation.op !== "create") {
        return [mutation];
      }

      const values: Record<string, unknown> = {
        ...(mutation.values as Record<string, unknown>),
        instanceRef: workflowInstanceRef,
      };
      const streamKey = `${String(values["instanceRef"])}:${String(values["stepKey"])}:${String(values["epoch"])}`;
      const payload = values["payload"];
      const isOperationStart =
        typeof payload === "object" &&
        payload !== null &&
        "kind" in payload &&
        payload.kind === "harness-operation-start";
      if (isOperationStart) {
        startedStreams.add(streamKey);
        return [{ ...mutation, values }];
      }
      if (startedStreams.has(streamKey)) {
        return [{ ...mutation, values }];
      }

      startedStreams.add(streamKey);
      return [
        {
          ...mutation,
          externalId: `${mutation.externalId}:operation-start`,
          versionstamp: `${mutation.versionstamp}:operation-start`,
          values: {
            ...values,
            sequence: -1,
            payload: {
              kind: "harness-operation-start",
              operationId: `projection-test:${index}`,
              operation: { kind: "prompt", args: [] },
              replay: { protocol: "pi-harness-operation", version: 1 },
            },
          },
        },
        { ...mutation, values },
      ];
    });
  await adapter.applyMutations(durableMutations);

  const entry: OutboxEntry = {
    id: FragnoId.fromExternal("projection-outbox-entry", 0),
    versionstamp: "projection-outbox-versionstamp",
    uowId: "projection-outbox-uow",
    payload: {
      json: { version: 1, mutations: ephemeralMutations } satisfies OutboxPayload,
    },
    createdAt: new Date(),
  };
  let allowOutboxRequest: () => void = () => undefined;
  const outboxRequestAllowed = new Promise<void>((resolve) => {
    allowOutboxRequest = resolve;
  });
  let deliveredEphemeralMutations = false;
  const runtime = createLofiRuntime({
    endpointName: "pi-harness-projection-test",
    adapter,
    outboxUrl: "https://example.com/outbox",
    ephemeralTables: [piWorkflowStepEmissionEphemeralTable],
    fetch: (async () => {
      await outboxRequestAllowed;
      if (deliveredEphemeralMutations || ephemeralMutations.length === 0) {
        return new Response(JSON.stringify([]));
      }
      deliveredEphemeralMutations = true;
      return new Response(JSON.stringify([entry]));
    }) as typeof fetch,
  });
  return { adapter, runtime, allowOutboxRequest };
};

const settledProjection = async (
  runtimeContext: Awaited<ReturnType<typeof createRuntime>>,
  store: ReturnType<typeof createSessionProjectionDataStore>,
): Promise<PiWorkflowSessionProjectionState> => {
  const unlisten = store.listen(() => undefined);
  runtimeContext.allowOutboxRequest();
  await runtimeContext.runtime.whenBootstrapped();
  await store.refresh();
  const projection = store.get().data;
  unlisten();
  return projection;
};

const projectWorkflowMutations = async (
  sessionId: string,
  mutations: Parameters<typeof uowOperationsToLofiMutations>[0],
  options?: Parameters<typeof createSessionProjectionDataStore>[3],
): Promise<PiWorkflowSessionProjectionState> => {
  const runtimeContext = await createRuntime(
    uowOperationsToLofiMutations(mutations, { now: new Date("2026-07-03T00:00:00.000Z") }),
  );
  return settledProjection(
    runtimeContext,
    createSessionProjectionDataStore(runtimeContext.runtime, workflowName, sessionId, options),
  );
};

const projectManualWorkflow = async (
  sessionId: string,
  options: {
    status?: string;
    steps?: readonly {
      stepKey: string;
      type: string;
      status: string;
      waitEventType?: string | null;
      result?: unknown;
    }[];
    emissions?: readonly {
      stepKey: string;
      payload: Record<string, unknown> | null;
      sequence?: number;
      createdAt?: Date;
    }[];
  } = {},
  storeOptions?: Parameters<typeof createSessionProjectionDataStore>[3],
): Promise<PiWorkflowSessionProjectionState> => {
  const instanceRef = buildScopedInstanceRowId(workflowName, sessionId);
  const now = new Date(0);
  const mutations: LofiMutation[] = [
    {
      op: "create",
      schema: "workflows",
      table: "workflow_instance",
      externalId: instanceRef,
      values: {
        id: instanceRef,
        workflowName,
        remoteWorkflowName: null,
        instanceId: sessionId,
        status: options.status ?? "active",
        createdAt: now,
        updatedAt: now,
        startedAt: null,
        completedAt: null,
        params: {},
        output: null,
        errorName: null,
        errorMessage: null,
      },
      versionstamp: `${sessionId}-instance`,
    },
    ...(options.steps ?? []).map((step, index) => ({
      op: "create" as const,
      schema: "workflows",
      table: "workflow_step",
      externalId: `${instanceRef}:step:${index}`,
      values: {
        id: `${instanceRef}:step:${index}`,
        instanceRef,
        stepKey: step.stepKey,
        parentStepKey: null,
        depth: 0,
        name: step.stepKey,
        type: step.type,
        status: step.status,
        attempts: 1,
        maxAttempts: 1,
        timeoutMs: null,
        nextRetryAt: null,
        wakeAt: null,
        waitEventType: step.waitEventType ?? null,
        result: step.result ?? null,
        errorName: null,
        errorMessage: null,
        createdAt: now,
        updatedAt: now,
      },
      versionstamp: `${sessionId}-step-${index}`,
    })),
    ...(options.emissions ?? []).map((emission, index) => ({
      op: "create" as const,
      schema: "workflows",
      table: "workflow_step_emission",
      externalId: `${instanceRef}:emission:${index}`,
      values: {
        id: `${instanceRef}:emission:${index}`,
        instanceRef,
        stepKey: emission.stepKey,
        epoch: "manual-epoch",
        sequence: emission.sequence ?? index,
        actor: "user",
        payload: emission.payload,
        createdAt: emission.createdAt ?? now,
      },
      versionstamp: `${sessionId}-emission-${index}`,
    })),
  ];
  const runtimeContext = await createRuntime(mutations);
  return settledProjection(
    runtimeContext,
    createSessionProjectionDataStore(runtimeContext.runtime, workflowName, sessionId, storeOptions),
  );
};

const projectFauxPrompt = async (options: {
  sessionId: string;
  operation: PiHarnessOperation;
  responses: readonly AssistantMessage[];
  tools?: readonly AgentTool[];
}): Promise<PiWorkflowSessionProjectionState> => {
  const recording = await recordFauxPiHarnessPrompt({
    workflowName,
    sessionId: options.sessionId,
    operation: options.operation,
    responses: options.responses,
    tools: options.tools,
  });

  return await projectWorkflowMutations(options.sessionId, recording.mutations);
};

type CheckpointProjectionOptions = {
  mutations?: "live" | "deleted-step-emissions";
  resume?: boolean;
  waitForDone?: boolean;
};

const withFauxCheckpointProjection = async (
  run: ReturnType<typeof startFauxPiHarnessOperation>,
  sessionId: string,
  checkpointName: string,
  assertProjection: (projection: PiWorkflowSessionProjectionState) => void | Promise<void>,
  options: CheckpointProjectionOptions = {},
) => {
  const checkpoint = await run.waitForCheckpoint(checkpointName);
  const mutations =
    options.mutations === "deleted-step-emissions"
      ? checkpoint.mutationsWithDeletedStepEmissions()
      : checkpoint.mutations;

  try {
    await assertProjection(await projectWorkflowMutations(sessionId, mutations));
  } finally {
    const shouldResume = options.resume ?? true;
    if (shouldResume) {
      checkpoint.resume();
    }
    if (options.waitForDone ?? shouldResume) {
      await run.done;
    }
  }
};

const sessionMessageEntry = (
  id: string,
  text: string,
  options: { role?: "assistant" | "user"; parentId?: string | null } = {},
): SessionTreeEntry => ({
  type: "message",
  id,
  parentId: options.parentId ?? null,
  timestamp: new Date(0).toISOString(),
  message:
    options.role === "user"
      ? ({ role: "user", content: text, timestamp: 1 } satisfies AgentMessage)
      : fauxAssistantMessage(fauxText(text), { timestamp: 1 }),
});

const harnessRunResult = (entries: readonly SessionTreeEntry[]) => ({
  type: "harness-run",
  operation: "prompt",
  appendedEntries: entries,
  leafId: entries.at(-1)?.id,
});

const messageTextContent = (message: AgentMessage): string => {
  if (!("content" in message)) {
    return "";
  }
  if (typeof message.content === "string") {
    return message.content;
  }
  return message.content
    .map((block) =>
      block.type === "text" ? block.text : block.type === "toolCall" ? block.name : "",
    )
    .filter(Boolean)
    .join("\n");
};

const writeFileSchema = Type.Object({ path: Type.String(), contents: Type.String() });

const writeFileTool: AgentTool<typeof writeFileSchema, { phase: string }> = {
  name: "write_file",
  label: "Write file",
  description: "Write a file",
  parameters: writeFileSchema,
  execute: async (_toolCallId, args, _signal, onUpdate) => {
    onUpdate?.({
      content: [fauxText(`opening ${args.path}`)],
      details: { phase: "opening" },
    });

    return {
      content: [fauxText(`wrote ${args.path}`)],
      details: { phase: "done" },
    };
  },
};

const checkpointWriteFileTool: AgentTool<typeof writeFileSchema, { phase: string }> = {
  ...writeFileTool,
  execute: async (_toolCallId, args, _signal, onUpdate) => {
    await new Promise((resolve) => setTimeout(resolve, 4));
    onUpdate?.({
      content: [fauxText(`opening ${args.path}`)],
      details: { phase: "opening" },
    });
    await new Promise((resolve) => setTimeout(resolve, 4));

    return {
      content: [fauxText(`wrote ${args.path}`)],
      details: { phase: "done" },
    };
  },
};

const toolResponses = [
  fauxAssistantMessage(
    fauxToolCall("write_file", { path: "/tmp/file.txt", contents: "hello" }, { id: "call-write" }),
    { stopReason: "toolUse", timestamp: 1 },
  ),
  fauxAssistantMessage(fauxText("Done."), { timestamp: 1 }),
];

describe("Pi harness workflow projection", () => {
  it("projects a text prompt turn", async () => {
    const projection = await projectFauxPrompt({
      sessionId: "text-turn",
      operation: { kind: "prompt", args: ["say hi"] },
      responses: [fauxAssistantMessage(fauxText("Hi there."), { timestamp: 1 })],
    });

    expect(projection.state.messages).toHaveLength(2);
    expect(projection.state.messages[0]).toMatchObject({ role: "user" });
    assert(messageTextContent(projection.state.messages[0]) === "say hi");
    expect(projection.state.messages[1]).toMatchObject({ role: "assistant" });
    assert(messageTextContent(projection.state.messages[1]) === "Hi there.");
  });

  it("projects a completed turn as ready for more input", async () => {
    const projection = await projectFauxPrompt({
      sessionId: "ready-turn",
      operation: { kind: "prompt", args: ["continue"] },
      responses: [fauxAssistantMessage(fauxText("Ready."), { timestamp: 1 })],
    });

    assert(projection.status === "ready");
    assert(projection.readyForInput);
    expect(projection.statusText).toBeNull();
    expect(projection.draftAgentMessage).toBeNull();
  });

  it("projects assistant thinking and final text content", async () => {
    const projection = await projectFauxPrompt({
      sessionId: "thinking-turn",
      operation: { kind: "prompt", args: ["check config"] },
      responses: [
        fauxAssistantMessage([fauxThinking("Need to read config."), fauxText("Config is valid.")], {
          timestamp: 1,
        }),
      ],
    });

    expect(projection.state.messages).toHaveLength(2);
    expect(projection.state.messages[1]).toMatchObject({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Need to read config." },
        { type: "text", text: "Config is valid." },
      ],
    });
  });

  it("projects a checkpoint inside a thinking block", async () => {
    const run = startFauxPiHarnessOperation({
      workflowName,
      sessionId: "thinking-checkpoint",
      operation: { kind: "prompt", args: ["plan"] },
      responses: [
        fauxAssistantMessageWithCheckpoints(
          fauxThinkingWithCheckpoints(["Plan", fauxCheckpoint("after-plan"), " more."]),
          { timestamp: 1 },
        ),
      ],
      fauxProviderOptions: {
        tokenSize: { min: 1, max: 1 },
      },
    });

    await withFauxCheckpointProjection(run, "thinking-checkpoint", "after-plan", (projection) => {
      expect(projection.state.messages.map(messageTextContent)).toEqual(["plan"]);
      expect(projection.draftAgentMessage).toMatchObject({
        activity: "thinking",
        assistant: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "Plan" }],
        },
      });
      assert(projection.statusText === "Thinking…");
      assert(!projection.readyForInput);
    });
  });

  describe("checkpoint projection coverage plan", () => {
    it("projects message_start as a starting draft", async () => {
      const run = startFauxPiHarnessOperation({
        workflowName,
        sessionId: "checkpoint-message-start",
        operation: { kind: "prompt", args: ["hello"] },
        responses: [
          fauxAssistantMessageWithCheckpoints(
            [fauxEventCheckpoint("message-start", "message_start"), fauxText("Hello.")],
            { timestamp: 1 },
          ),
        ],
      });

      await withFauxCheckpointProjection(
        run,
        "checkpoint-message-start",
        "message-start",
        (projection) => {
          expect(projection.state.messages.map(messageTextContent)).toEqual(["hello"]);
          expect(projection.draftAgentMessage).toMatchObject({ activity: "starting", tools: {} });
          expect(projection.draftAgentMessage?.assistant).toBeUndefined();
          assert(projection.statusText === "Working…");
          assert(!projection.readyForInput);
        },
      );
    });

    it("projects thinking_start as a thinking draft with empty thinking content", async () => {
      const run = startFauxPiHarnessOperation({
        workflowName,
        sessionId: "checkpoint-thinking-start",
        operation: { kind: "prompt", args: ["think"] },
        responses: [
          fauxAssistantMessageWithCheckpoints(
            [
              fauxEventCheckpoint("thinking-start", "thinking_start", { contentIndex: 0 }),
              fauxThinking("Plan"),
            ],
            { timestamp: 1 },
          ),
        ],
      });

      await withFauxCheckpointProjection(
        run,
        "checkpoint-thinking-start",
        "thinking-start",
        (projection) => {
          expect(projection.state.messages.map(messageTextContent)).toEqual(["think"]);
          expect(projection.draftAgentMessage).toMatchObject({
            activity: "thinking",
            assistant: { content: [{ type: "thinking", thinking: "" }] },
          });
          assert(projection.statusText === "Thinking…");
        },
      );
    });

    it("projects thinking_delta as a thinking draft with partial thinking content", async () => {
      const run = startFauxPiHarnessOperation({
        workflowName,
        sessionId: "checkpoint-thinking-delta",
        operation: { kind: "prompt", args: ["plan"] },
        responses: [
          fauxAssistantMessageWithCheckpoints(
            fauxThinkingWithCheckpoints(["Plan", fauxCheckpoint("thinking-delta"), " more."]),
            { timestamp: 1 },
          ),
        ],
        fauxProviderOptions: { tokenSize: { min: 1, max: 1 } },
      });

      await withFauxCheckpointProjection(
        run,
        "checkpoint-thinking-delta",
        "thinking-delta",
        (projection) => {
          expect(projection.state.messages.map(messageTextContent)).toEqual(["plan"]);
          expect(projection.draftAgentMessage).toMatchObject({
            activity: "thinking",
            assistant: { content: [{ type: "thinking", thinking: "Plan" }] },
          });
          assert(projection.statusText === "Thinking…");
        },
      );
    });

    it("projects thinking_end as a thinking draft with completed thinking content", async () => {
      const run = startFauxPiHarnessOperation({
        workflowName,
        sessionId: "checkpoint-thinking-end",
        operation: { kind: "prompt", args: ["think"] },
        responses: [
          fauxAssistantMessageWithCheckpoints(
            [fauxThinking("Plan"), fauxCheckpoint("thinking-end")],
            {
              timestamp: 1,
            },
          ),
        ],
      });

      await withFauxCheckpointProjection(
        run,
        "checkpoint-thinking-end",
        "thinking-end",
        (projection) => {
          expect(projection.state.messages.map(messageTextContent)).toEqual(["think"]);
          expect(projection.draftAgentMessage).toMatchObject({
            activity: "thinking",
            assistant: { content: [{ type: "thinking", thinking: "Plan" }] },
          });
          assert(projection.statusText === "Thinking…");
        },
      );
    });

    it("projects text_start as a writing draft with empty text content", async () => {
      const run = startFauxPiHarnessOperation({
        workflowName,
        sessionId: "checkpoint-text-start",
        operation: { kind: "prompt", args: ["hello"] },
        responses: [
          fauxAssistantMessageWithCheckpoints(
            [
              fauxEventCheckpoint("text-start", "text_start", { contentIndex: 0 }),
              fauxText("Hello."),
            ],
            { timestamp: 1 },
          ),
        ],
      });

      await withFauxCheckpointProjection(
        run,
        "checkpoint-text-start",
        "text-start",
        (projection) => {
          expect(projection.draftAgentMessage).toMatchObject({
            activity: "writing",
            assistant: { content: [{ type: "text", text: "" }] },
          });
          assert(projection.statusText === "Writing…");
        },
      );
    });

    it("projects text_delta as a writing draft with partial text content", async () => {
      const run = startFauxPiHarnessOperation({
        workflowName,
        sessionId: "checkpoint-text-delta",
        operation: { kind: "prompt", args: ["hello"] },
        responses: [
          fauxAssistantMessageWithCheckpoints(
            [
              fauxEventCheckpoint("text-delta", "text_delta", { contentIndex: 0 }),
              fauxText("Hello."),
            ],
            { timestamp: 1 },
          ),
        ],
        fauxProviderOptions: { tokenSize: { min: 1, max: 1 } },
      });

      await withFauxCheckpointProjection(
        run,
        "checkpoint-text-delta",
        "text-delta",
        (projection) => {
          expect(projection.state.messages.map(messageTextContent)).toEqual(["hello"]);
          expect(projection.draftAgentMessage).toMatchObject({
            activity: "writing",
            assistant: { content: [{ type: "text", text: "Hell" }] },
          });
          assert(projection.statusText === "Writing…");
        },
      );
    });

    it("projects text_end as a writing draft with completed text content", async () => {
      const run = startFauxPiHarnessOperation({
        workflowName,
        sessionId: "checkpoint-text-end",
        operation: { kind: "prompt", args: ["hello"] },
        responses: [
          fauxAssistantMessageWithCheckpoints([fauxText("Hello."), fauxCheckpoint("text-end")], {
            timestamp: 1,
          }),
        ],
      });

      await withFauxCheckpointProjection(run, "checkpoint-text-end", "text-end", (projection) => {
        expect(projection.state.messages.map(messageTextContent)).toEqual(["hello"]);
        expect(projection.draftAgentMessage).toMatchObject({
          activity: "writing",
          assistant: { content: [{ type: "text", text: "Hello." }] },
        });
        assert(projection.statusText === "Writing…");
      });
    });

    it("projects toolcall_start as a tool_calling draft tool", async () => {
      const run = startFauxPiHarnessOperation({
        workflowName,
        sessionId: "checkpoint-toolcall-start",
        operation: { kind: "prompt", args: ["write"] },
        responses: [
          fauxAssistantMessageWithCheckpoints(
            [
              fauxEventCheckpoint("toolcall-start", "toolcall_start", { contentIndex: 0 }),
              fauxToolCall(
                "write_file",
                { path: "/tmp/file.txt", contents: "hello" },
                { id: "call-write" },
              ),
            ],
            { stopReason: "toolUse", timestamp: 1 },
          ),
          fauxAssistantMessage(fauxText("Done."), { timestamp: 1 }),
        ],
        tools: [writeFileTool],
      });

      await withFauxCheckpointProjection(
        run,
        "checkpoint-toolcall-start",
        "toolcall-start",
        (projection) => {
          expect(projection.draftAgentMessage).toMatchObject({
            activity: "tool_calling",
            tools: {
              "call-write": { id: "call-write", name: "write_file", args: {}, status: "starting" },
            },
          });
          assert(projection.statusText === "Writing tool call…");
        },
      );
    });

    it("projects toolcall_delta as a tool_calling draft tool", async () => {
      const run = startFauxPiHarnessOperation({
        workflowName,
        sessionId: "checkpoint-toolcall-delta",
        operation: { kind: "prompt", args: ["write"] },
        responses: [
          fauxAssistantMessageWithCheckpoints(
            [
              fauxEventCheckpoint("toolcall-delta", "toolcall_delta", { contentIndex: 0 }),
              fauxToolCall(
                "write_file",
                { path: "/tmp/file.txt", contents: "hello" },
                { id: "call-write" },
              ),
            ],
            { stopReason: "toolUse", timestamp: 1 },
          ),
          fauxAssistantMessage(fauxText("Done."), { timestamp: 1 }),
        ],
        tools: [writeFileTool],
      });

      await withFauxCheckpointProjection(
        run,
        "checkpoint-toolcall-delta",
        "toolcall-delta",
        (projection) => {
          expect(projection.draftAgentMessage).toMatchObject({
            activity: "tool_calling",
            tools: {
              "call-write": { id: "call-write", name: "write_file", args: {}, status: "starting" },
            },
          });
          assert(projection.statusText === "Writing tool call…");
        },
      );
    });

    it("projects toolcall_end as a complete draft tool call before execution", async () => {
      const run = startFauxPiHarnessOperation({
        workflowName,
        sessionId: "checkpoint-toolcall-end",
        operation: { kind: "prompt", args: ["write"] },
        responses: [
          fauxAssistantMessageWithCheckpoints(
            [
              fauxToolCall(
                "write_file",
                { path: "/tmp/file.txt", contents: "hello" },
                { id: "call-write" },
              ),
              fauxCheckpoint("toolcall-end"),
            ],
            { stopReason: "toolUse", timestamp: 1 },
          ),
          fauxAssistantMessage(fauxText("Done."), { timestamp: 1 }),
        ],
        tools: [writeFileTool],
      });

      await withFauxCheckpointProjection(
        run,
        "checkpoint-toolcall-end",
        "toolcall-end",
        (projection) => {
          expect(projection.draftAgentMessage).toMatchObject({
            activity: "tool_calling",
            assistant: {
              content: [
                {
                  type: "toolCall",
                  id: "call-write",
                  name: "write_file",
                  arguments: { path: "/tmp/file.txt", contents: "hello" },
                },
              ],
            },
            tools: {
              "call-write": {
                id: "call-write",
                name: "write_file",
                args: { path: "/tmp/file.txt", contents: "hello" },
                status: "starting",
              },
            },
          });
          assert(projection.statusText === "Writing tool call…");
        },
      );
    });

    it("projects tool_execution_start as a running tool", async () => {
      const run = startFauxPiHarnessOperation({
        workflowName,
        sessionId: "checkpoint-tool-start",
        operation: { kind: "prompt", args: ["write"] },
        responses: [
          fauxAssistantMessageWithCheckpoints(
            [
              fauxEventCheckpoint("tool-start", "tool_execution_start", {
                toolCallId: "call-write",
              }),
              fauxToolCall(
                "write_file",
                { path: "/tmp/file.txt", contents: "hello" },
                { id: "call-write" },
              ),
            ],
            { stopReason: "toolUse", timestamp: 1 },
          ),
          fauxAssistantMessage(fauxText("Done."), { timestamp: 1 }),
        ],
        tools: [checkpointWriteFileTool],
      });

      await withFauxCheckpointProjection(
        run,
        "checkpoint-tool-start",
        "tool-start",
        (projection) => {
          expect(projection.draftAgentMessage).toMatchObject({
            activity: "running_tools",
            tools: {
              "call-write": {
                id: "call-write",
                name: "write_file",
                args: { path: "/tmp/file.txt", contents: "hello" },
                status: "running",
              },
            },
          });
          assert(projection.statusText === "Running tool calls…");
          assert(!projection.readyForInput);
        },
      );
    });

    it("projects tool_execution_update as a running tool with partialResult", async () => {
      const run = startFauxPiHarnessOperation({
        workflowName,
        sessionId: "checkpoint-tool-update",
        operation: { kind: "prompt", args: ["write"] },
        responses: [
          fauxAssistantMessageWithCheckpoints(
            [
              fauxEventCheckpoint("tool-update", "tool_execution_update", {
                toolCallId: "call-write",
              }),
              fauxToolCall(
                "write_file",
                { path: "/tmp/file.txt", contents: "hello" },
                { id: "call-write" },
              ),
            ],
            { stopReason: "toolUse", timestamp: 1 },
          ),
          fauxAssistantMessage(fauxText("Done."), { timestamp: 1 }),
        ],
        tools: [checkpointWriteFileTool],
      });

      await withFauxCheckpointProjection(
        run,
        "checkpoint-tool-update",
        "tool-update",
        (projection) => {
          expect(projection.draftAgentMessage).toMatchObject({
            activity: "running_tools",
            tools: {
              "call-write": {
                partialResult: {
                  content: [{ type: "text", text: "opening /tmp/file.txt" }],
                  details: { phase: "opening" },
                },
                status: "running",
              },
            },
          });
          assert(projection.statusText === "Running tool calls…");
          assert(!projection.readyForInput);
        },
      );
    });

    it("projects successful tool_execution_end as a done tool with result", async () => {
      const run = startFauxPiHarnessOperation({
        workflowName,
        sessionId: "checkpoint-tool-end",
        operation: { kind: "prompt", args: ["write"] },
        responses: [
          fauxAssistantMessageWithCheckpoints(
            [
              fauxEventCheckpoint("tool-end", "tool_execution_end", { toolCallId: "call-write" }),
              fauxToolCall(
                "write_file",
                { path: "/tmp/file.txt", contents: "hello" },
                { id: "call-write" },
              ),
            ],
            { stopReason: "toolUse", timestamp: 1 },
          ),
          fauxAssistantMessage(fauxText("Done."), { timestamp: 1 }),
        ],
        tools: [checkpointWriteFileTool],
      });

      await withFauxCheckpointProjection(run, "checkpoint-tool-end", "tool-end", (projection) => {
        expect(projection.draftAgentMessage).toMatchObject({
          tools: {
            "call-write": {
              result: {
                content: [{ type: "text", text: "wrote /tmp/file.txt" }],
                details: { phase: "done" },
              },
              isError: false,
              status: "done",
            },
          },
        });
        assert(projection.statusText === "Working…");
      });
    });

    it("projects failed tool_execution_end as an errored done tool", async () => {
      const failWriteFileTool: AgentTool<typeof writeFileSchema, { phase: string }> = {
        ...writeFileTool,
        name: "fail_write_file",
        execute: async () => {
          throw new Error("write failed");
        },
      };
      const run = startFauxPiHarnessOperation({
        workflowName,
        sessionId: "checkpoint-tool-error",
        operation: { kind: "prompt", args: ["write"] },
        responses: [
          fauxAssistantMessageWithCheckpoints(
            [
              fauxEventCheckpoint("tool-error", "tool_execution_end", { toolCallId: "call-fail" }),
              fauxToolCall(
                "fail_write_file",
                { path: "/tmp/file.txt", contents: "hello" },
                { id: "call-fail" },
              ),
            ],
            { stopReason: "toolUse", timestamp: 1 },
          ),
          fauxAssistantMessage(fauxText("Done."), { timestamp: 1 }),
        ],
        tools: [failWriteFileTool],
      });

      await withFauxCheckpointProjection(
        run,
        "checkpoint-tool-error",
        "tool-error",
        (projection) => {
          expect(projection.draftAgentMessage).toMatchObject({
            tools: {
              "call-fail": {
                id: "call-fail",
                name: "fail_write_file",
                isError: true,
                status: "done",
              },
            },
          });
          expect(projection.draftAgentMessage?.tools["call-fail"]?.result).toBeTruthy();
        },
      );
    });

    it("projects toolResult message_end as an in-flight settled result message", async () => {
      const run = startFauxPiHarnessOperation({
        workflowName,
        sessionId: "checkpoint-tool-result-end",
        operation: { kind: "prompt", args: ["write"], stopOnTools: ["write_file"] },
        responses: [
          fauxAssistantMessageWithCheckpoints(
            [
              fauxEventCheckpoint("tool-result-end", "message_end", {
                messageRole: "toolResult",
                toolCallId: "call-write",
              }),
              fauxToolCall(
                "write_file",
                { path: "/tmp/file.txt", contents: "hello" },
                { id: "call-write" },
              ),
            ],
            { stopReason: "toolUse", timestamp: 1 },
          ),
        ],
        tools: [checkpointWriteFileTool],
      });

      await withFauxCheckpointProjection(
        run,
        "checkpoint-tool-result-end",
        "tool-result-end",
        (projection) => {
          expect(projection.state.messages.map(messageTextContent)).toEqual([
            "write",
            "write_file",
            "wrote /tmp/file.txt",
          ]);
          expect(projection.draftAgentMessage).toMatchObject({
            tools: {
              "call-write": {
                resultMessage: {
                  role: "toolResult",
                  toolCallId: "call-write",
                  content: [{ type: "text", text: "wrote /tmp/file.txt" }],
                  details: { phase: "done" },
                },
                status: "done",
              },
            },
          });
        },
      );
    });

    it("projects assistant message_end as an in-flight settled assistant message", async () => {
      const run = startFauxPiHarnessOperation({
        workflowName,
        sessionId: "checkpoint-assistant-end",
        operation: { kind: "prompt", args: ["hello"] },
        responses: [
          fauxAssistantMessageWithCheckpoints(
            [
              fauxEventCheckpoint("assistant-end", "message_end", { messageRole: "assistant" }),
              fauxText("Hello."),
            ],
            { timestamp: 1 },
          ),
        ],
      });

      await withFauxCheckpointProjection(
        run,
        "checkpoint-assistant-end",
        "assistant-end",
        (projection) => {
          expect(projection.state.messages.map(messageTextContent)).toEqual(["hello", "Hello."]);
          expect(projection.draftAgentMessage).toBeNull();
          expect(projection.statusText).toBeNull();
        },
      );
    });

    it("hides draftAgentMessage after all live tools and open message drafts finish", async () => {
      const run = startFauxPiHarnessOperation({
        workflowName,
        sessionId: "checkpoint-hide-draft",
        operation: { kind: "prompt", args: ["hello"] },
        responses: [
          fauxAssistantMessageWithCheckpoints(
            [
              fauxEventCheckpoint("assistant-end", "message_end", { messageRole: "assistant" }),
              fauxText("Hello."),
            ],
            { timestamp: 1 },
          ),
        ],
      });

      await withFauxCheckpointProjection(
        run,
        "checkpoint-hide-draft",
        "assistant-end",
        (projection) => {
          expect(projection.draftAgentMessage).toBeNull();
          expect(projection.statusText).toBeNull();
        },
      );
    });

    it("keeps readyForInput false while a draft assistant message is open", async () => {
      const run = startFauxPiHarnessOperation({
        workflowName,
        sessionId: "checkpoint-draft-not-ready",
        operation: { kind: "prompt", args: ["hello"] },
        responses: [
          fauxAssistantMessageWithCheckpoints(
            [
              fauxEventCheckpoint("text-start", "text_start", { contentIndex: 0 }),
              fauxText("Hello."),
            ],
            { timestamp: 1 },
          ),
        ],
      });

      await withFauxCheckpointProjection(
        run,
        "checkpoint-draft-not-ready",
        "text-start",
        (projection) => {
          assert(!projection.readyForInput);
          expect(projection.draftAgentMessage).toMatchObject({ activity: "writing" });
        },
      );
    });

    it("keeps readyForInput false while tools are running", async () => {
      const run = startFauxPiHarnessOperation({
        workflowName,
        sessionId: "checkpoint-running-tool-not-ready",
        operation: { kind: "prompt", args: ["write"] },
        responses: [
          fauxAssistantMessageWithCheckpoints(
            [
              fauxEventCheckpoint("tool-start", "tool_execution_start", {
                toolCallId: "call-write",
              }),
              fauxToolCall(
                "write_file",
                { path: "/tmp/file.txt", contents: "hello" },
                { id: "call-write" },
              ),
            ],
            { stopReason: "toolUse", timestamp: 1 },
          ),
          fauxAssistantMessage(fauxText("Done."), { timestamp: 1 }),
        ],
        tools: [checkpointWriteFileTool],
      });

      await withFauxCheckpointProjection(
        run,
        "checkpoint-running-tool-not-ready",
        "tool-start",
        (projection) => {
          assert(!projection.readyForInput);
          expect(projection.draftAgentMessage).toMatchObject({
            activity: "running_tools",
            tools: { "call-write": { status: "running" } },
          });
        },
      );
    });

    it("marks readyForInput true after an active instance waits for a command", async () => {
      const projection = await projectManualWorkflow("manual-command-wait", {
        steps: [
          {
            stepKey: "waitForEvent:command",
            type: "waitForEvent",
            status: "waiting",
            waitEventType: "command",
          },
        ],
      });

      assert(projection.readyForInput);
      assert(projection.status === "ready");
      expect(projection.statusText).toBeNull();
    });

    it("uses Working… when active live work has no visible draft", async () => {
      const projection = await projectManualWorkflow("manual-active-step", {
        steps: [{ stepKey: "do:background", type: "do", status: "running" }],
      });

      expect(projection.draftAgentMessage).toBeNull();
      assert(!projection.readyForInput);
      assert(projection.statusText === "Working…");
    });

    it("projects workflow instance joins into a Pi session projection source", async () => {
      const committed = sessionMessageEntry("entry-committed", "committed");
      const projection = await projectManualWorkflow("manual-instance-join", {
        steps: [
          {
            stepKey: "do:agent-turn-1",
            type: "do",
            status: "completed",
            result: harnessRunResult([committed]),
          },
        ],
        emissions: [
          {
            stepKey: "do:agent-turn-2",
            payload: {
              kind: "harness-message-update",
              update: {
                type: "message_update",
                assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "streaming" },
              },
            },
          },
        ],
      });

      expect(projection.state.messages.map(messageTextContent)).toEqual(["committed"]);
    });

    it("keeps initialState visible when local lofi is bootstrapped but not caught up", async () => {
      const projection = await projectWorkflowMutations("missing-initial-state", [], {
        initialState: {
          messages: [
            { role: "user", content: "server prompt", timestamp: 1 },
            fauxAssistantMessage(fauxText("server reply"), { timestamp: 1 }),
          ],
        },
      });

      assert(!projection.sessionFound);
      expect(projection.state.messages.map(messageTextContent)).toEqual([
        "server prompt",
        "server reply",
      ]);
    });

    it("keeps initialState visible when only the workflow instance is local", async () => {
      const projection = await projectManualWorkflow(
        "local-instance-only",
        {},
        {
          initialState: {
            messages: [
              { role: "user", content: "server prompt", timestamp: 1 },
              fauxAssistantMessage(fauxText("server reply"), { timestamp: 1 }),
            ],
          },
          initialCompletedStepKeys: ["do:first-command"],
        },
      );

      expect(projection.state.messages.map(messageTextContent)).toEqual([
        "server prompt",
        "server reply",
      ]);
    });

    it("projects durable completed step messages and ignores its persisted live emissions", async () => {
      const projection = await projectFauxPrompt({
        sessionId: "completed-emissions-ignored",
        operation: { kind: "prompt", args: ["hello"] },
        responses: [fauxAssistantMessage(fauxText("Hello."), { timestamp: 1 })],
      });

      expect(projection.state.messages.map(messageTextContent)).toEqual(["hello", "Hello."]);
      expect(projection.draftAgentMessage).toBeNull();
      expect(projection.statusText).toBeNull();
      assert(projection.readyForInput);
    });

    it("projects one run across live and emission-deleted checkpoint snapshots", async () => {
      const sessionId = "multi-checkpoint-completed-step";
      const run = startFauxPiHarnessOperation({
        workflowName,
        sessionId,
        operation: { kind: "prompt", args: ["stay visible"] },
        responses: [
          fauxAssistantMessageWithCheckpoints(
            [
              fauxEventCheckpoint("assistant-text", "text_delta", { contentIndex: 0 }),
              fauxEventCheckpoint("assistant-end", "message_end", { messageRole: "assistant" }),
              fauxText("Still visible."),
            ],
            { timestamp: 1 },
          ),
        ],
      });

      await withFauxCheckpointProjection(
        run,
        sessionId,
        "assistant-text",
        (projection) => {
          expect(projection.state.messages.map(messageTextContent)).toEqual(["stay visible"]);
          expect(projection.draftAgentMessage).toMatchObject({ activity: "writing" });
          assert(!projection.readyForInput);
        },
        {
          waitForDone: false,
        },
      );

      await withFauxCheckpointProjection(
        run,
        sessionId,
        "assistant-end",
        (projection) => {
          expect(projection.state.messages.map(messageTextContent)).toEqual([
            "stay visible",
            "Still visible.",
          ]);
          expect(projection.draftAgentMessage).toBeNull();
        },
        {
          waitForDone: false,
        },
      );

      await withFauxCheckpointProjection(
        run,
        sessionId,
        "assistant-end",
        (projection) => {
          expect(projection.state.messages.map(messageTextContent)).toEqual([
            "stay visible",
            "Still visible.",
          ]);
          expect(projection.draftAgentMessage).toBeNull();
        },
        {
          mutations: "deleted-step-emissions",
          resume: false,
          waitForDone: false,
        },
      );

      const recording = await run.done;
      const completedProjection = await projectWorkflowMutations(sessionId, recording.mutations);
      expect(completedProjection.state.messages.map(messageTextContent)).toEqual([
        "stay visible",
        "Still visible.",
      ]);
      expect(completedProjection.draftAgentMessage).toBeNull();
      expect(completedProjection.statusText).toBeNull();
      assert(completedProjection.readyForInput);
    });

    it("keeps messages visible in indexeddb after completed step emissions are deleted", async () => {
      const sessionId = "indexeddb-deleted-emissions-after-completion";
      const run = startFauxPiHarnessOperation({
        workflowName,
        sessionId,
        operation: { kind: "prompt", args: ["stay visible"] },
        responses: [
          fauxAssistantMessageWithCheckpoints(
            [
              fauxEventCheckpoint("assistant-text", "text_delta", { contentIndex: 0 }),
              fauxText("Still visible."),
            ],
            { timestamp: 1 },
          ),
        ],
      });

      const liveCheckpoint = await run.waitForCheckpoint("assistant-text");
      liveCheckpoint.resume();
      const recording = await run.done;
      const completedProjection = await projectWorkflowMutations(sessionId, recording.mutations);
      expect(completedProjection.state.messages.map(messageTextContent)).toEqual([
        "stay visible",
        "Still visible.",
      ]);

      const afterEmissionDeletionProjection = await projectWorkflowMutations(
        sessionId,
        run.mutationsWithDeletedStepEmissions(recording.mutations),
      );
      expect(afterEmissionDeletionProjection.state.messages.map(messageTextContent)).toEqual([
        "stay visible",
        "Still visible.",
      ]);
    });

    it("keeps messages visible when live emissions settle into an outbox-shaped completed step", async () => {
      const sessionId = "completed-step-without-created-at";
      const run = startFauxPiHarnessOperation({
        workflowName,
        sessionId,
        operation: { kind: "prompt", args: ["stay visible"] },
        responses: [
          fauxAssistantMessageWithCheckpoints(
            [
              fauxEventCheckpoint("assistant-text", "text_delta", { contentIndex: 0 }),
              fauxText("Still visible."),
            ],
            { timestamp: 1 },
          ),
        ],
      });
      const checkpoint = await run.waitForCheckpoint("assistant-text");

      try {
        const liveProjection = await projectWorkflowMutations(sessionId, checkpoint.mutations);
        expect(liveProjection.state.messages.map(messageTextContent)).toEqual(["stay visible"]);
        expect(liveProjection.draftAgentMessage).toMatchObject({ activity: "writing" });
      } finally {
        checkpoint.resume();
      }

      const recording = await run.done;
      const completedStepCreate = recording.mutations.find(
        (mutation) =>
          mutation.type === "create" &&
          mutation.table === "workflow_step" &&
          JSON.stringify(mutation.values).includes('"type":"harness-run"'),
      );
      assert(completedStepCreate?.type === "create");
      expect(completedStepCreate.values).not.toHaveProperty("createdAt");

      const completedProjection = await projectWorkflowMutations(sessionId, recording.mutations);
      expect(completedProjection.state.messages.map(messageTextContent)).toEqual([
        "stay visible",
        "Still visible.",
      ]);
      expect(completedProjection.draftAgentMessage).toBeNull();
      expect(completedProjection.statusText).toBeNull();
      assert(completedProjection.readyForInput);
    });

    it("overlays initialState before local incomplete step emissions", async () => {
      const initialMessage = {
        role: "user",
        content: "previous turn",
        timestamp: 1,
      } satisfies AgentMessage;
      const run = startFauxPiHarnessOperation({
        workflowName,
        sessionId: "checkpoint-initial-overlay",
        operation: { kind: "prompt", args: ["current turn"] },
        responses: [
          fauxAssistantMessageWithCheckpoints(
            [
              fauxEventCheckpoint("text-start", "text_start", { contentIndex: 0 }),
              fauxText("Current."),
            ],
            { timestamp: 1 },
          ),
        ],
      });
      const checkpoint = await run.waitForCheckpoint("text-start");

      try {
        const projection = await projectWorkflowMutations(
          "checkpoint-initial-overlay",
          checkpoint.mutations,
          {
            initialState: { messages: [initialMessage] },
            initialCompletedStepKeys: ["already-completed"],
          },
        );

        expect(projection.state.messages.map(messageTextContent)).toEqual([
          "previous turn",
          "current turn",
        ]);
        expect(projection.draftAgentMessage).toMatchObject({ activity: "writing" });
      } finally {
        checkpoint.resume();
        await run.done;
      }
    });

    it("returns a not-found projection for a missing workflow instance", async () => {
      const projection = await projectWorkflowMutations("missing-session", []);

      assert(!projection.sessionFound);
      assert(projection.status === "error");
      expect(projection.error).toBeInstanceOf(Error);
      expect(projection.statusText).toBeNull();
    });

    it("projects multiple draft tool calls independently", async () => {
      const run = startFauxPiHarnessOperation({
        workflowName,
        sessionId: "checkpoint-multiple-toolcalls",
        operation: { kind: "prompt", args: ["write two files"] },
        responses: [
          fauxAssistantMessageWithCheckpoints(
            [
              fauxToolCall(
                "write_file",
                { path: "/tmp/one.txt", contents: "one" },
                { id: "call-one" },
              ),
              fauxToolCall(
                "write_file",
                { path: "/tmp/two.txt", contents: "two" },
                { id: "call-two" },
              ),
              fauxCheckpoint("second-toolcall-end"),
            ],
            { stopReason: "toolUse", timestamp: 1 },
          ),
          fauxAssistantMessage(fauxText("Done."), { timestamp: 1 }),
        ],
        tools: [writeFileTool],
      });

      await withFauxCheckpointProjection(
        run,
        "checkpoint-multiple-toolcalls",
        "second-toolcall-end",
        (projection) => {
          expect(projection.draftAgentMessage).toMatchObject({
            activity: "tool_calling",
            tools: {
              "call-one": {
                id: "call-one",
                name: "write_file",
                args: { path: "/tmp/one.txt", contents: "one" },
                status: "starting",
              },
              "call-two": {
                id: "call-two",
                name: "write_file",
                args: { path: "/tmp/two.txt", contents: "two" },
                status: "starting",
              },
            },
          });
        },
      );
    });

    it("projects mixed tool execution states for parallel tool calls", async () => {
      const fastWriteFileTool: AgentTool<typeof writeFileSchema, { phase: string }> = {
        ...writeFileTool,
        name: "fast_write_file",
      };
      const run = startFauxPiHarnessOperation({
        workflowName,
        sessionId: "checkpoint-mixed-tools",
        operation: { kind: "prompt", args: ["write two files"] },
        responses: [
          fauxAssistantMessageWithCheckpoints(
            [
              fauxEventCheckpoint("fast-tool-end", "tool_execution_end", {
                toolCallId: "call-fast",
              }),
              fauxToolCall(
                "write_file",
                { path: "/tmp/slow.txt", contents: "slow" },
                { id: "call-slow" },
              ),
              fauxToolCall(
                "fast_write_file",
                { path: "/tmp/fast.txt", contents: "fast" },
                { id: "call-fast" },
              ),
            ],
            { stopReason: "toolUse", timestamp: 1 },
          ),
          fauxAssistantMessage(fauxText("Done."), { timestamp: 1 }),
        ],
        tools: [checkpointWriteFileTool, fastWriteFileTool],
      });

      await withFauxCheckpointProjection(
        run,
        "checkpoint-mixed-tools",
        "fast-tool-end",
        (projection) => {
          expect(projection.draftAgentMessage).toMatchObject({
            activity: "running_tools",
            tools: {
              "call-slow": { status: "running" },
              "call-fast": { status: "done", isError: false },
            },
          });
          assert(projection.statusText === "Running tool calls…");
          assert(!projection.readyForInput);
        },
      );
    });

    it("keeps latest tool_execution_update partialResult for a tool", async () => {
      const multiUpdateWriteFileTool: AgentTool<typeof writeFileSchema, { phase: string }> = {
        ...writeFileTool,
        execute: async (_toolCallId, args, _signal, onUpdate) => {
          onUpdate?.({ content: [fauxText("first update")], details: { phase: "first" } });
          onUpdate?.({ content: [fauxText("second update")], details: { phase: "second" } });
          return { content: [fauxText(`wrote ${args.path}`)], details: { phase: "done" } };
        },
      };
      const run = startFauxPiHarnessOperation({
        workflowName,
        sessionId: "checkpoint-latest-update",
        operation: { kind: "prompt", args: ["write"] },
        responses: [
          fauxAssistantMessageWithCheckpoints(
            [
              fauxEventCheckpoint("second-update", "tool_execution_update", {
                toolCallId: "call-write",
                occurrence: 2,
              }),
              fauxToolCall(
                "write_file",
                { path: "/tmp/file.txt", contents: "hello" },
                { id: "call-write" },
              ),
            ],
            { stopReason: "toolUse", timestamp: 1 },
          ),
          fauxAssistantMessage(fauxText("Done."), { timestamp: 1 }),
        ],
        tools: [multiUpdateWriteFileTool],
      });

      await withFauxCheckpointProjection(
        run,
        "checkpoint-latest-update",
        "second-update",
        (projection) => {
          expect(projection.draftAgentMessage).toMatchObject({
            tools: {
              "call-write": {
                partialResult: {
                  content: [{ type: "text", text: "second update" }],
                  details: { phase: "second" },
                },
                status: "running",
              },
            },
          });
        },
      );
    });

    it("preserves tool args from toolcall_end when execution_end omits args", async () => {
      const run = startFauxPiHarnessOperation({
        workflowName,
        sessionId: "checkpoint-preserve-tool-args",
        operation: { kind: "prompt", args: ["write"] },
        responses: [
          fauxAssistantMessageWithCheckpoints(
            [
              fauxEventCheckpoint("tool-end", "tool_execution_end", { toolCallId: "call-write" }),
              fauxToolCall(
                "write_file",
                { path: "/tmp/file.txt", contents: "hello" },
                { id: "call-write" },
              ),
            ],
            { stopReason: "toolUse", timestamp: 1 },
          ),
          fauxAssistantMessage(fauxText("Done."), { timestamp: 1 }),
        ],
        tools: [writeFileTool],
      });

      await withFauxCheckpointProjection(
        run,
        "checkpoint-preserve-tool-args",
        "tool-end",
        (projection) => {
          expect(projection.draftAgentMessage).toMatchObject({
            tools: {
              "call-write": {
                args: { path: "/tmp/file.txt", contents: "hello" },
                status: "done",
              },
            },
          });
        },
      );
    });

    it("orders in-flight settled messages by workflow step and emission order", async () => {
      const projection = await projectManualWorkflow("manual-inflight-order", {
        emissions: [
          {
            stepKey: "step-b",
            sequence: 0,
            payload: {
              kind: "harness-event",
              event: {
                type: "message_end",
                message: fauxAssistantMessage(fauxText("B1"), { timestamp: 1 }),
              },
            },
          },
          {
            stepKey: "step-a",
            sequence: 1,
            payload: {
              kind: "harness-event",
              event: {
                type: "message_end",
                message: fauxAssistantMessage(fauxText("A1"), { timestamp: 1 }),
              },
            },
          },
          {
            stepKey: "step-b",
            sequence: 2,
            payload: {
              kind: "harness-event",
              event: {
                type: "message_end",
                message: fauxAssistantMessage(fauxText("B2"), { timestamp: 1 }),
              },
            },
          },
        ],
      });

      expect(projection.state.messages.map(messageTextContent)).toEqual(["B1", "B2", "A1"]);
      expect(projection.draftAgentMessage).toBeNull();
    });

    it("ignores control and non-harness live emissions", async () => {
      const projection = await projectManualWorkflow("manual-non-harness-emissions", {
        emissions: [
          { stepKey: "control", payload: { kind: undefined, control: "flush" } },
          {
            stepKey: "operation",
            payload: {
              kind: "harness-operation-start",
              operationId: "operation-1",
              operation: { kind: "prompt", args: ["hello"] },
              replay: { protocol: "pi-harness-operation", version: 1 },
            },
          },
        ],
      });

      expect(projection.state.messages).toEqual([]);
      expect(projection.draftAgentMessage).toBeNull();
      assert(!projection.readyForInput);
      assert(projection.statusText === "Working…");
    });

    it("ignores emissions for initialCompletedStepKeys", async () => {
      const initialMessage = {
        role: "user",
        content: "already committed",
        timestamp: 1,
      } satisfies AgentMessage;
      const run = startFauxPiHarnessOperation({
        workflowName,
        sessionId: "checkpoint-ignore-initial-step",
        operation: { kind: "prompt", args: ["live turn"] },
        responses: [
          fauxAssistantMessageWithCheckpoints(
            [
              fauxEventCheckpoint("text-start", "text_start", { contentIndex: 0 }),
              fauxText("Live."),
            ],
            { timestamp: 1 },
          ),
        ],
      });
      const checkpoint = await run.waitForCheckpoint("text-start");
      const stepEmissionCreate = checkpoint.mutations.find(
        (mutation) => mutation.type === "create" && mutation.table === "workflow_step_emission",
      );
      assert(stepEmissionCreate?.type === "create");
      const stepKey = String((stepEmissionCreate.values as { stepKey: unknown }).stepKey);

      try {
        const projection = await projectWorkflowMutations(
          "checkpoint-ignore-initial-step",
          checkpoint.mutations,
          {
            initialState: { messages: [initialMessage] },
            initialCompletedStepKeys: [stepKey],
          },
        );

        expect(projection.state.messages.map(messageTextContent)).toEqual(["already committed"]);
        expect(projection.draftAgentMessage).toBeNull();
        expect(projection.statusText).toBeNull();
      } finally {
        checkpoint.resume();
        await run.done;
      }
    });

    it("deduplicates updated completed session entries by entry id", async () => {
      const entries: SessionTreeEntry[] = [
        {
          type: "message",
          id: "entry-a",
          parentId: null,
          timestamp: new Date(0).toISOString(),
          message: { role: "user", content: "Old first", timestamp: 1 },
        },
        {
          type: "message",
          id: "entry-b",
          parentId: "entry-a",
          timestamp: new Date(1).toISOString(),
          message: fauxAssistantMessage(fauxText("Second"), { timestamp: 2 }),
        },
        {
          type: "message",
          id: "entry-a",
          parentId: null,
          timestamp: new Date(2).toISOString(),
          message: { role: "user", content: "Updated first", timestamp: 3 },
        },
      ];
      const projection = await projectManualWorkflow("manual-dedup-entries", {
        steps: [
          {
            stepKey: "do:faux-turn",
            type: "do",
            status: "completed",
            result: {
              type: "harness-run",
              operation: "prompt",
              appendedEntries: entries,
              leafId: "entry-b",
            },
          },
        ],
      });

      expect(projection.state.messages.map(messageTextContent)).toEqual([
        "Updated first",
        "Second",
      ]);
    });

    it("projects only the active leaf path from branched completed session entries", async () => {
      const entries: SessionTreeEntry[] = [
        {
          type: "message",
          id: "root",
          parentId: null,
          timestamp: new Date(0).toISOString(),
          message: { role: "user", content: "Root", timestamp: 1 },
        },
        {
          type: "message",
          id: "branch-a",
          parentId: "root",
          timestamp: new Date(1).toISOString(),
          message: fauxAssistantMessage(fauxText("Branch A"), { timestamp: 2 }),
        },
        {
          type: "message",
          id: "branch-b",
          parentId: "root",
          timestamp: new Date(2).toISOString(),
          message: fauxAssistantMessage(fauxText("Branch B"), { timestamp: 3 }),
        },
        {
          type: "leaf",
          id: "leaf-b",
          parentId: "branch-b",
          timestamp: new Date(3).toISOString(),
          targetId: "branch-b",
        },
      ];
      const projection = await projectManualWorkflow("manual-leaf-path", {
        steps: [
          {
            stepKey: "do:faux-turn",
            type: "do",
            status: "completed",
            result: {
              type: "harness-run",
              operation: "prompt",
              appendedEntries: entries,
              leafId: "branch-b",
            },
          },
        ],
      });

      expect(projection.state.messages.map(messageTextContent)).toEqual(["Root", "Branch B"]);
    });

    it("does not mark errored or failed instances ready for input", async () => {
      for (const status of ["errored", "failed"] as const) {
        const projection = await projectManualWorkflow(`manual-${status}`, { status });

        assert(projection.sessionFound);
        assert(projection.status === "ready");
        assert(!projection.readyForInput);
        expect(projection.statusText).toBeNull();
      }
    });

    it("does not treat non-command wait steps as ready for input", async () => {
      const projection = await projectManualWorkflow("manual-non-command-wait", {
        steps: [
          {
            stepKey: "waitForEvent:webhook",
            type: "waitForEvent",
            status: "waiting",
            waitEventType: "webhook",
          },
        ],
      });

      assert(!projection.readyForInput);
      assert(projection.statusText === "Working…");
    });
  });

  it("projects a tool turn through the faux provider and harness", async () => {
    const projection = await projectFauxPrompt({
      sessionId: "tool-turn",
      operation: { kind: "prompt", args: ["write a file"] },
      responses: toolResponses,
      tools: [writeFileTool],
    });

    expect(projection.state.messages).toHaveLength(4);
    expect(projection.state.messages[0]).toMatchObject({ role: "user" });
    assert(messageTextContent(projection.state.messages[0]) === "write a file");
    expect(projection.state.messages[1]).toMatchObject({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call-write",
          name: "write_file",
          arguments: { path: "/tmp/file.txt", contents: "hello" },
        },
      ],
    });
    expect(projection.state.messages[2]).toMatchObject({
      role: "toolResult",
      toolCallId: "call-write",
      toolName: "write_file",
      content: [{ type: "text", text: "wrote /tmp/file.txt" }],
      details: { phase: "done" },
    });
    expect(projection.state.messages[3]).toMatchObject({ role: "assistant" });
    assert(messageTextContent(projection.state.messages[3]) === "Done.");
    expect(projection.draftAgentMessage).toBeNull();
  });
});
