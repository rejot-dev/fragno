import { assert, describe, expect, test, vi } from "vitest";

import { defineScenario, runScenario } from "@fragno-dev/workflows/scenario";
import { defineWorkflow, type WorkflowStepEmission } from "@fragno-dev/workflows/workflow";
import { Type } from "typebox";
import { z } from "zod";

import { instantiate } from "@fragno-dev/core";

import {
  AgentHarness,
  type AgentMessage,
  type AgentTool,
  type SessionTreeEntry,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Model,
  type ToolCall,
} from "@earendil-works/pi-ai";

import { createPiFragmentClients } from "../../client/clients";
import { piRoutesFactory } from "../../routes";
import { piHarnessDefinition } from "../definition";
import { createPiWorkflows } from "../factory";
import { createPiHarnessScenarioEventDecoder } from "../pi-test-utils";
import { piSessionCommandPayloadSchema } from "../route-schemas";
import { definePiTool } from "../tools";
import type { PiFragmentConfig, PiOperationCompletedHookPayload } from "../types";
import {
  applyWorkflowAgentHarnessStepResult,
  createPiHarnessSessionState,
  restoreWorkflowBackedSession,
  withWorkflowAgentHarness,
  type PiHarnessSessionStepState,
  type WorkflowAgentHarnessOptions,
  type WorkflowAgentHarnessStepResult,
} from "../workflows/workflow-agent-harness";
import { schedulePiOperationCompletedHook } from "./pi-operation-completed";
import { sessionEntriesLeafId } from "./session-storage";
import { createModelsForStreamFn, mockAgentHarnessCompaction } from "./test-models";

const decodeScenarioHarnessEvent = createPiHarnessScenarioEventDecoder();

const mockModel: Model<Api> = {
  id: "test-model",
  name: "Test model",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://example.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 2048,
};

const alternateModel: Model<Api> = {
  ...mockModel,
  id: "alternate-test-model",
  name: "Alternate test model",
};

const createAssistantMessage = (text: string): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: mockModel.api,
  provider: mockModel.provider,
  model: mockModel.id,
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: Date.now(),
});

const createTextStreamFn =
  (text: string): StreamFn =>
  () => {
    const stream = createAssistantMessageEventStream();
    const message = createAssistantMessage(text);

    stream.push({ type: "start", partial: message });
    stream.push({ type: "text_start", contentIndex: 0, partial: message });
    stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
    stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
    stream.push({ type: "done", reason: "stop", message });
    stream.end();

    return stream;
  };

const createCompletionGate = (): { promise: Promise<void>; release: () => void } => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};

const createErrorStreamFn =
  (errorMessage: string): StreamFn =>
  () => {
    const stream = createAssistantMessageEventStream();
    const message = createAssistantMessage("");
    message.stopReason = "error";
    message.errorMessage = errorMessage;
    stream.push({ type: "error", reason: "error", error: message });
    return stream;
  };

const cloneAssistantMessage = (message: AssistantMessage): AssistantMessage => ({
  ...message,
  content: message.content.map(
    (content) => ({ ...content }) as AssistantMessage["content"][number],
  ),
  usage: { ...message.usage, cost: { ...message.usage.cost } },
});

const parseStreamingJson = (json: string): Record<string, unknown> => {
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
};

const createToolCallStreamFn =
  (toolCall: ToolCall): StreamFn =>
  () => {
    const stream = createAssistantMessageEventStream();
    const finalMessage = createAssistantMessage("");
    finalMessage.content = [toolCall];
    finalMessage.stopReason = "toolUse";
    const startMessage = createAssistantMessage("");
    startMessage.content = [];
    startMessage.stopReason = "toolUse";
    const partialToolCall = {
      type: "toolCall" as const,
      id: toolCall.id,
      name: toolCall.name,
      arguments: {},
      partialJson: "",
    };
    const partialMessage = createAssistantMessage("");
    partialMessage.content = [partialToolCall];
    partialMessage.stopReason = "toolUse";

    stream.push({ type: "start", partial: cloneAssistantMessage(startMessage) });
    stream.push({
      type: "toolcall_start",
      contentIndex: 0,
      partial: cloneAssistantMessage(partialMessage),
    });
    partialToolCall.partialJson = JSON.stringify(toolCall.arguments);
    partialToolCall.arguments = parseStreamingJson(partialToolCall.partialJson);
    stream.push({
      type: "toolcall_delta",
      contentIndex: 0,
      delta: partialToolCall.partialJson,
      partial: cloneAssistantMessage(partialMessage),
    });
    stream.push({
      type: "toolcall_end",
      contentIndex: 0,
      toolCall,
      partial: cloneAssistantMessage(finalMessage),
    });
    stream.push({ type: "done", reason: "toolUse", message: finalMessage });
    stream.end();

    return stream;
  };

const messageText = (message: AssistantMessage): string =>
  message.content.flatMap((content) => (content.type === "text" ? [content.text] : [])).join("");

const agentMessageText = (message: AgentMessage): string => {
  if (!("content" in message)) {
    return "";
  }
  if (typeof message.content === "string") {
    return message.content;
  }
  return message.content
    .flatMap((content) => (content.type === "text" ? [content.text] : []))
    .join("");
};

const toPreviousEmissions = (payloads: readonly unknown[]): WorkflowStepEmission[] =>
  payloads.map((payload, sequence) => ({
    id: `emission-${sequence}`,
    actor: "user",
    stepKey: "do:prompt",
    executionId: "previous-execution",
    epoch: "previous-attempt",
    sequence,
    payload,
    createdAt: new Date("2026-07-01T12:00:00.000Z"),
  }));

const createEmissionRecorder = () => {
  const emitted: unknown[] = [];
  return {
    emitted,
    tx: {
      emit: (payload: unknown) => emitted.push(payload),
      onEvent: () => () => {},
    },
  };
};

const messagesFromState = (state: PiHarnessSessionStepState): AgentMessage[] =>
  state.entries.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));

const emissionsThroughFirstUserEntry = (emissions: readonly unknown[]): unknown[] => {
  const partial: unknown[] = [];
  for (const emission of emissions) {
    partial.push(emission);
    if (
      typeof emission === "object" &&
      emission !== null &&
      "kind" in emission &&
      emission.kind === "harness-session-entry" &&
      "entry" in emission &&
      typeof emission.entry === "object" &&
      emission.entry !== null &&
      "type" in emission.entry &&
      emission.entry.type === "message" &&
      "message" in emission.entry &&
      typeof emission.entry.message === "object" &&
      emission.entry.message !== null &&
      "role" in emission.entry.message &&
      emission.entry.message.role === "user"
    ) {
      return partial;
    }
  }

  throw new Error("TEST_USER_ENTRY_NOT_EMITTED");
};

const commandEchoWorkflow = defineWorkflow(
  { name: "workflow-agent-harness-command-echo", schema: z.object({ profileName: z.string() }) },
  async (_event, step) => {
    const commandEvent = await step.waitForEvent("command", { type: "command" });
    const command = piSessionCommandPayloadSchema.parse(commandEvent.payload);

    return {
      kind: command.kind,
      text: command.kind === "prompt" ? command.input.text : null,
    };
  },
);

describe("workflow-backed AgentHarness state", () => {
  test("restores stable session metadata supplied at workflow initialization", async () => {
    const metadata = {
      id: "stable-session",
      createdAt: "2026-07-01T12:00:00.000Z",
    };
    const restored = restoreWorkflowBackedSession({
      operationId: "stable-session:prompt",
      state: createPiHarnessSessionState({ metadata }),
      previousEmissions: [],
      models: createModelsForStreamFn([mockModel, alternateModel], createTextStreamFn("unused")),
    });

    await expect(restored.session.getMetadata()).resolves.toEqual(metadata);
  });

  test("replays a completed invocation without calling the provider again", async () => {
    const operationId = "completed-replay:prompt";
    const state = createPiHarnessSessionState({
      metadata: {
        id: "completed-replay",
        createdAt: "2026-07-01T12:00:00.000Z",
      },
    });
    const firstEmissions = createEmissionRecorder();
    const firstSession = restoreWorkflowBackedSession({
      operationId,
      state,
      previousEmissions: [],
      models: createModelsForStreamFn([mockModel, alternateModel], createTextStreamFn("unused")),
    });
    const firstStream = vi.fn(createTextStreamFn("completed once"));
    const firstHarness = new AgentHarness({
      models: createModelsForStreamFn(mockModel, firstStream),
      model: mockModel,
      ...firstSession.options,
    });
    const firstTerminalOutcome = vi.fn();
    const firstResult = await withWorkflowAgentHarness({
      session: firstSession.session,
      storage: firstSession.storage,
      harness: firstHarness,
      tx: firstEmissions.tx,
      runDurableStep: async () => messageText(await firstHarness.prompt("hello")),
      onTerminalOutcome: firstTerminalOutcome,
    });

    const replaySession = restoreWorkflowBackedSession({
      operationId,
      state,
      previousEmissions: toPreviousEmissions(firstEmissions.emitted),
      models: createModelsForStreamFn([mockModel, alternateModel], createTextStreamFn("unused")),
    });
    const replayStream = vi.fn(createTextStreamFn("must not run"));
    const replayHarness = new AgentHarness({
      models: createModelsForStreamFn(mockModel, replayStream),
      model: mockModel,
      ...replaySession.options,
    });
    const runDurableStep = vi.fn(async () => messageText(await replayHarness.prompt("hello")));
    const replayTerminalOutcome = vi.fn();
    const replayResult = await withWorkflowAgentHarness({
      session: replaySession.session,
      storage: replaySession.storage,
      harness: replayHarness,
      tx: createEmissionRecorder().tx,
      runDurableStep,
      onTerminalOutcome: replayTerminalOutcome,
    });

    expect(replayResult).toEqual(firstResult);
    expect(firstTerminalOutcome).toHaveBeenCalledWith(expect.objectContaining({ operationId }));
    expect(replayTerminalOutcome).toHaveBeenCalledWith(expect.objectContaining({ operationId }));
    expect(runDurableStep).not.toHaveBeenCalled();
    expect(replayStream).not.toHaveBeenCalled();
  });

  test("rejects a terminal assistant error by default when the callback transforms its result", async () => {
    const operationId = "failed-assistant-default:prompt";
    const state = createPiHarnessSessionState({
      metadata: {
        id: "failed-assistant-default",
        createdAt: "2026-07-01T12:00:00.000Z",
      },
    });
    const {
      session,
      storage,
      options: restoredOptions,
    } = restoreWorkflowBackedSession({
      operationId,
      state,
      previousEmissions: [],
      models: createModelsForStreamFn([mockModel, alternateModel], createTextStreamFn("unused")),
    });
    const harness = new AgentHarness({
      models: createModelsForStreamFn(mockModel, createErrorStreamFn("provider down")),
      model: mockModel,
      ...restoredOptions,
    });
    const emissions = createEmissionRecorder();
    const terminalOutcome = vi.fn();

    await expect(
      withWorkflowAgentHarness({
        session,
        storage,
        harness,
        tx: emissions.tx,
        runDurableStep: async () => messageText(await harness.prompt("hello")),
        onTerminalOutcome: terminalOutcome,
      }),
    ).rejects.toThrow("Pi harness agent stream failed: provider down");

    expect(terminalOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId,
        operationEntries: expect.arrayContaining([
          expect.objectContaining({
            type: "message",
            message: expect.objectContaining({ role: "assistant", stopReason: "error" }),
          }),
        ]),
      }),
    );
    expect(emissions.emitted).not.toContainEqual(
      expect.objectContaining({ kind: "harness-operation-complete", operationId }),
    );
  });

  test("checkpoints a failed terminal assistant when explicitly configured", async () => {
    const operationId = "failed-assistant:prompt";
    const state = createPiHarnessSessionState({
      metadata: {
        id: "failed-assistant",
        createdAt: "2026-07-01T12:00:00.000Z",
      },
    });
    const {
      session,
      storage,
      options: restoredOptions,
    } = restoreWorkflowBackedSession({
      operationId,
      state,
      previousEmissions: [],
      models: createModelsForStreamFn([mockModel, alternateModel], createTextStreamFn("unused")),
    });
    const harness = new AgentHarness({
      models: createModelsForStreamFn(mockModel, createErrorStreamFn("provider down")),
      model: mockModel,
      ...restoredOptions,
    });
    const emissions = createEmissionRecorder();
    const terminalOutcome = vi.fn();

    const result = await withWorkflowAgentHarness({
      session,
      storage,
      harness,
      tx: emissions.tx,
      runDurableStep: () => harness.prompt("hello"),
      checkpointTerminalAssistantError: true,
      onTerminalOutcome: terminalOutcome,
    });

    expect(result.value).toMatchObject({
      role: "assistant",
      stopReason: "error",
      errorMessage: "provider down",
    });
    expect(terminalOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId,
        operationEntries: expect.arrayContaining([
          expect.objectContaining({
            type: "message",
            message: expect.objectContaining({ role: "assistant", stopReason: "error" }),
          }),
        ]),
      }),
    );
    expect(emissions.emitted).toContainEqual(
      expect.objectContaining({ kind: "harness-operation-complete", operationId }),
    );
  });

  test("retries a terminal assistant when its callback result was not checkpointed", async () => {
    const operationId = "terminal-recovery:prompt";
    const state = createPiHarnessSessionState({
      metadata: {
        id: "terminal-recovery",
        createdAt: "2026-07-01T12:00:00.000Z",
      },
    });
    const firstEmissions = createEmissionRecorder();
    const firstSession = restoreWorkflowBackedSession({
      operationId,
      state,
      previousEmissions: [],
      models: createModelsForStreamFn([mockModel, alternateModel], createTextStreamFn("unused")),
    });
    const firstHarness = new AgentHarness({
      models: createModelsForStreamFn(mockModel, createTextStreamFn("already completed")),
      model: mockModel,
      ...firstSession.options,
    });
    await withWorkflowAgentHarness({
      session: firstSession.session,
      storage: firstSession.storage,
      harness: firstHarness,
      tx: firstEmissions.tx,
      runDurableStep: () => firstHarness.prompt("hello"),
    });
    const emissionsWithoutCompletion = firstEmissions.emitted.filter(
      (emission) =>
        typeof emission !== "object" ||
        emission === null ||
        !("kind" in emission) ||
        emission.kind !== "harness-operation-complete",
    );

    const recoverySession = restoreWorkflowBackedSession({
      operationId,
      state,
      previousEmissions: toPreviousEmissions(emissionsWithoutCompletion),
      models: createModelsForStreamFn([mockModel, alternateModel], createTextStreamFn("unused")),
    });
    const recoveryStream = vi.fn(createTextStreamFn("retried completion"));
    const recoveryHarness = new AgentHarness({
      models: createModelsForStreamFn(mockModel, recoveryStream),
      model: mockModel,
      ...recoverySession.options,
    });
    const recoveryEmissions = createEmissionRecorder();
    const runDurableStep = vi.fn(() => recoveryHarness.prompt("hello"));
    const result = await withWorkflowAgentHarness({
      session: recoverySession.session,
      storage: recoverySession.storage,
      harness: recoveryHarness,
      tx: recoveryEmissions.tx,
      runDurableStep,
    });

    assert(messageText(result.value) === "retried completion");
    expect(runDurableStep).toHaveBeenCalledTimes(1);
    expect(recoveryStream).toHaveBeenCalledTimes(1);
    expect(recoveryEmissions.emitted).toContainEqual(
      expect.objectContaining({ kind: "harness-operation-complete", operationId }),
    );
  });

  test("continues deterministic entry allocation when retrying an interrupted prompt", async () => {
    const operationId = "interrupted-retry:prompt";
    const state = createPiHarnessSessionState({
      metadata: {
        id: "interrupted-retry",
        createdAt: "2026-07-01T12:00:00.000Z",
      },
    });
    const firstEmissions = createEmissionRecorder();
    const firstSession = restoreWorkflowBackedSession({
      operationId,
      state,
      previousEmissions: [],
      models: createModelsForStreamFn([mockModel, alternateModel], createTextStreamFn("unused")),
    });
    const firstHarness = new AgentHarness({
      models: createModelsForStreamFn(mockModel, createTextStreamFn("discarded response")),
      model: mockModel,
      ...firstSession.options,
    });
    await withWorkflowAgentHarness({
      session: firstSession.session,
      storage: firstSession.storage,
      harness: firstHarness,
      tx: firstEmissions.tx,
      runDurableStep: () => firstHarness.prompt("hello"),
    });

    const retrySession = restoreWorkflowBackedSession({
      operationId,
      state,
      previousEmissions: toPreviousEmissions(
        emissionsThroughFirstUserEntry(firstEmissions.emitted),
      ),
      models: createModelsForStreamFn([mockModel, alternateModel], createTextStreamFn("unused")),
    });
    const retryHarness = new AgentHarness({
      models: createModelsForStreamFn(mockModel, createTextStreamFn("retried response")),
      model: mockModel,
      ...retrySession.options,
    });
    const retryEmissions = createEmissionRecorder();
    const result = await withWorkflowAgentHarness({
      session: retrySession.session,
      storage: retrySession.storage,
      harness: retryHarness,
      tx: retryEmissions.tx,
      runDurableStep: () => retryHarness.prompt("hello"),
    });
    const entryIds = result.appendedEntries.map((entry) => entry.id);

    expect(entryIds).toEqual([
      `${operationId}:entry-0`,
      `${operationId}:entry-1`,
      `${operationId}:entry-2`,
      `${operationId}:entry-3`,
    ]);
    expect(new Set(entryIds).size).toBe(entryIds.length);
    assert(messageText(result.value) === "retried response");
  });

  test("returns synchronous AgentHarness option overrides from session entries", () => {
    const timestamp = "2026-07-01T12:00:00.000Z";
    const entries: SessionTreeEntry[] = [
      {
        type: "model_change",
        id: "selection-0",
        parentId: null,
        timestamp,
        provider: alternateModel.provider,
        modelId: alternateModel.id,
      },
      {
        type: "thinking_level_change",
        id: "selection-1",
        parentId: "selection-0",
        timestamp,
        thinkingLevel: "high",
      },
      {
        type: "active_tools_change",
        id: "selection-2",
        parentId: "selection-1",
        timestamp,
        activeToolNames: ["search"],
      },
    ];
    const state = {
      ...createPiHarnessSessionState({
        metadata: { id: "restored-selections", createdAt: timestamp },
      }),
      entries,
      persistedEntryIds: entries.map((entry) => entry.id),
    };
    const models = createModelsForStreamFn(
      [mockModel, alternateModel],
      createTextStreamFn("unused"),
    );
    const {
      session,
      storage,
      options: restoredOptions,
    } = restoreWorkflowBackedSession({
      operationId: "restored-selections:prompt",
      state,
      previousEmissions: [],
      models,
    });

    expect(session.getStorage()).toBe(storage);
    expect(storage.workflowMetadata).toEqual({
      operationId: "restored-selections:prompt",
      persistedEntryIds: new Set(entries.map((entry) => entry.id)),
      recovery: { kind: "execute" },
    });

    const tools: AgentTool[] = ["search", "write"].map((name) => ({
      name,
      label: name,
      description: `${name} test tool`,
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text", text: name }], details: {} }),
    }));
    const harness = new AgentHarness({
      models,
      model: mockModel,
      thinkingLevel: "low",
      tools,
      ...restoredOptions,
    });

    expect(harness.getModel()).toBe(alternateModel);
    assert(harness.getThinkingLevel() === "high");
    expect(harness.getActiveTools().map((tool) => tool.name)).toEqual(["search"]);
  });

  test("rejects persisted entry ids that are absent from session state", () => {
    const state = createPiHarnessSessionState({
      metadata: {
        id: "invalid-persisted-entry-session",
        createdAt: "2026-07-01T12:00:00.000Z",
      },
    });

    expect(() =>
      restoreWorkflowBackedSession({
        operationId: "invalid-persisted-entry-session:prompt",
        state: { ...state, persistedEntryIds: ["missing-entry"] },
        previousEmissions: [],
        models: createModelsForStreamFn([mockModel, alternateModel], createTextStreamFn("unused")),
      }),
    ).toThrow("WORKFLOW_AGENT_HARNESS_UNKNOWN_PERSISTED_ENTRY:missing-entry");
  });

  test("rejects a step result whose leaf disagrees with its entry delta", () => {
    const state = createPiHarnessSessionState({
      metadata: {
        id: "invalid-leaf-session",
        createdAt: "2026-07-01T12:00:00.000Z",
      },
    });

    expect(() =>
      applyWorkflowAgentHarnessStepResult(state, {
        appendedEntries: [],
        leafId: "missing-entry",
      }),
    ).toThrow("WORKFLOW_AGENT_HARNESS_LEAF_MISMATCH");
  });
});

describe("workflow-backed AgentHarness scenario", () => {
  test("runs a route-created plain workflow and delivers commands through the scenario harness", async () => {
    const config: PiFragmentConfig = {
      workflows: [commandEchoWorkflow],
    };

    await runScenario(
      defineScenario({
        name: "pi-harness-command-echo",
        workflows: createPiWorkflows({
          workflows: config.workflows,
        }),
        vars: () => ({
          sessionId: undefined as string | undefined,
        }),
        harness: {
          configureFragments: (harness) => ({
            pi: instantiate(piHarnessDefinition)
              .withConfig(config)
              .withRoutes([piRoutesFactory])
              .withServices({ workflows: harness.fragment.services }),
          }),
        },
        clients: ({ clientConfig }) => ({
          user: createPiFragmentClients(clientConfig("pi", { runner: "user" })),
        }),
        runners: ["agent", "user"],
        steps: ({ workflow, runners, clients }) => [
          workflow.read({
            read: async () => {
              const session = await clients.user.useCreateSession.mutateQuery({
                path: { workflowName: commandEchoWorkflow.name },
                body: {
                  name: "Scenario Session",
                  input: { profileName: "default" },
                },
              });
              assert(session && !Array.isArray(session), "expected session response");
              return session.id;
            },
            storeAs: "sessionId",
          }),
          runners.agent.runUntilIdle({
            workflow: commandEchoWorkflow.name,
            instanceId: (ctx) => ctx.vars.sessionId!,
            reason: "create",
          }),
          workflow.read({
            read: async (ctx) =>
              ctx.state.getStatus(commandEchoWorkflow.name, ctx.vars.sessionId ?? ""),
            assert: (status) => {
              assert(status.status === "waiting");
            },
          }),
          workflow.read({
            read: async (ctx) => {
              assert(ctx.vars.sessionId, "session id should be set");
              return await clients.user.useCommandSession.mutateQuery({
                path: { workflowName: commandEchoWorkflow.name, sessionId: ctx.vars.sessionId },
                body: { kind: "prompt", input: { text: "hello scenario" } },
              });
            },
            assert: (ack) => {
              assert(ack && !Array.isArray(ack), "expected command acknowledgement");
              assert(ack.accepted);
            },
          }),
          runners.agent.runUntilIdle({
            workflow: commandEchoWorkflow.name,
            instanceId: (ctx) => ctx.vars.sessionId!,
            reason: "event",
          }),
          workflow.read({
            read: async (ctx) => ({
              status: await ctx.state.getStatus(commandEchoWorkflow.name, ctx.vars.sessionId ?? ""),
              detail: await clients.user.useSessionDetail.query({
                path: { workflowName: commandEchoWorkflow.name, sessionId: ctx.vars.sessionId! },
              }),
            }),
            assert: ({ status, detail }) => {
              expect(status).toMatchObject({
                status: "complete",
                output: { kind: "prompt", text: "hello scenario" },
              });
              assert(detail && !Array.isArray(detail), "expected session detail response");
              expect(detail.workflow).toMatchObject({
                status: "complete",
                output: { kind: "prompt", text: "hello scenario" },
              });
            },
          }),
        ],
      }),
    );
  });

  test("restores an in-flight harness prompt step after runner restart without duplicating the prompt", async () => {
    let releaseInFlightAttempt!: () => void;
    const inFlightAttemptReleased = new Promise<void>((resolve) => {
      releaseInFlightAttempt = resolve;
    });
    const streamFn = vi.fn(() => {
      const stream = createAssistantMessageEventStream();
      const message = createAssistantMessage("stop");

      void (async () => {
        await inFlightAttemptReleased;
        stream.push({ type: "start", partial: message });
        stream.push({ type: "text_start", contentIndex: 0, partial: message });
        stream.push({ type: "text_delta", contentIndex: 0, delta: "stop", partial: message });
        stream.push({ type: "text_end", contentIndex: 0, content: "stop", partial: message });
        stream.push({ type: "done", reason: "stop", message });
      })();

      return stream;
    });
    const harnessOptions: WorkflowAgentHarnessOptions = {
      systemPrompt: "You are helpful.",
      model: mockModel,
      models: createModelsForStreamFn(mockModel, streamFn),
    };
    const restoreWorkflow = defineWorkflow(
      { name: "workflow-agent-harness-restore-prompt-in-flight", schema: z.object({}) },
      async (event, step) => {
        let state = createPiHarnessSessionState({
          metadata: {
            id: event.instanceId,
            createdAt: event.timestamp.toISOString(),
          },
        });
        const result = await step.do("ask", async (tx) => {
          const {
            session,
            storage,
            options: restoredOptions,
          } = restoreWorkflowBackedSession({
            operationId: `${restoreWorkflow.name}:${event.instanceId}:ask`,
            state,
            previousEmissions: await tx.previousEmissions(),
            models: harnessOptions.models,
          });
          const harness = new AgentHarness({ ...harnessOptions, ...restoredOptions });

          return await withWorkflowAgentHarness({
            session,
            storage,
            harness,
            tx,
            runDurableStep: () => harness.prompt("hello"),
          });
        });
        state = applyWorkflowAgentHarnessStepResult(state, result);
        const messages = messagesFromState(state);

        return {
          roles: messages.map((message) => message.role),
          text: messages
            .flatMap((message) =>
              "content" in message && Array.isArray(message.content)
                ? message.content.flatMap((content) =>
                    content.type === "text" ? [content.text] : [],
                  )
                : [],
            )
            .join(" "),
        };
      },
    );
    const config: PiFragmentConfig = { workflows: [restoreWorkflow] };

    await runScenario(
      defineScenario({
        name: "pi-harness-restore-prompt-in-flight",
        workflows: createPiWorkflows({ workflows: config.workflows }),
        harness: {
          configureFragments: (harness) => ({
            pi: instantiate(piHarnessDefinition)
              .withConfig(config)
              .withRoutes([piRoutesFactory])
              .withServices({ workflows: harness.fragment.services }),
          }),
        },
        runners: ["worker", "killer"],
        steps: ({ workflow, runners, concurrent }) => [
          workflow.create({ workflow: restoreWorkflow.name, id: "restore-prompt-session" }),
          concurrent({
            worker: [
              runners.worker.tick({
                workflow: restoreWorkflow.name,
                instanceId: "restore-prompt-session",
                reason: "create",
              }),
            ],
            killer: [
              runners.killer.waitForEmission({
                workflow: restoreWorkflow.name,
                instanceId: "restore-prompt-session",
                match: (emission) => {
                  const event = decodeScenarioHarnessEvent(emission);
                  return event?.type === "message_end" && event.message.role === "user";
                },
              }),
              runners.killer.restart(),
              workflow.read({
                read: () => {
                  const timeout = setTimeout(releaseInFlightAttempt, 20);
                  timeout.unref?.();
                },
              }),
              runners.killer.tick({
                workflow: restoreWorkflow.name,
                instanceId: "restore-prompt-session",
                reason: "create",
              }),
            ],
          }),
          workflow.read({
            read: async (ctx) => ({
              status: await ctx.state.getStatus(restoreWorkflow.name, "restore-prompt-session"),
              steps: await ctx.state.getSteps(restoreWorkflow.name, "restore-prompt-session"),
            }),
            assert: ({ status, steps }) => {
              expect(status).toMatchObject({
                status: "complete",
                output: { roles: ["user", "assistant"], text: "hello stop" },
              });
              expect(steps).toContainEqual(
                expect.objectContaining({
                  stepKey: "do:ask",
                  status: "completed",
                }),
              );
            },
          }),
        ],
      }),
    );
  });

  test("supports a workflow-owned control event protocol", async () => {
    const releaseInitialResponse = createCompletionGate();
    const observedModelContexts: Array<Array<{ role: string; text: string }>> = [];
    let providerCallIndex = 0;
    const streamFn: StreamFn = (model, context, options) => {
      observedModelContexts.push(
        context.messages.map((message) => ({
          role: message.role,
          text:
            typeof message.content === "string"
              ? message.content
              : message.content
                  .flatMap((content) => (content.type === "text" ? [content.text] : []))
                  .join(""),
        })),
      );
      const requestIndex = providerCallIndex;
      providerCallIndex += 1;
      if (requestIndex > 0) {
        return createTextStreamFn("response after priority update")(model, context, options);
      }

      const stream = createAssistantMessageEventStream();
      const message = createAssistantMessage("initial response");
      stream.push({ type: "start", partial: message });
      void (async () => {
        await releaseInitialResponse.promise;
        stream.push({ type: "text_start", contentIndex: 0, partial: message });
        stream.push({
          type: "text_delta",
          contentIndex: 0,
          delta: "initial response",
          partial: message,
        });
        stream.push({
          type: "text_end",
          contentIndex: 0,
          content: "initial response",
          partial: message,
        });
        stream.push({ type: "done", reason: "stop", message });
      })();
      return stream;
    };
    const customControlSchema = z.object({ instruction: z.string() });
    const customControlWorkflowName = "workflow-agent-harness-custom-control";
    const customControlWorkflow = defineWorkflow(
      { name: customControlWorkflowName, schema: z.object({}) },
      async (event, step) => {
        let state = createPiHarnessSessionState({
          metadata: {
            id: event.instanceId,
            createdAt: event.timestamp.toISOString(),
          },
        });
        const result = await step.do("prompt", async (tx) => {
          const models = createModelsForStreamFn(mockModel, streamFn);
          const {
            session,
            storage,
            options: restoredOptions,
          } = restoreWorkflowBackedSession({
            operationId: `${customControlWorkflowName}:${event.instanceId}:prompt`,
            state,
            previousEmissions: await tx.previousEmissions(),
            models,
          });
          const harness = new AgentHarness({
            systemPrompt: "You are helpful.",
            model: mockModel,
            models,
            ...restoredOptions,
          });

          return await withWorkflowAgentHarness({
            session,
            storage,
            harness,
            tx,
            observeLiveEvents: (onLiveEvent) => {
              onLiveEvent("priority-update", async (controlEvent) => {
                const control = customControlSchema.parse(controlEvent.payload);
                await harness.steer(control.instruction);
                controlEvent.consume();
              });
            },
            runDurableStep: () => harness.prompt("draft the implementation"),
          });
        });
        state = applyWorkflowAgentHarnessStepResult(state, result);

        return {
          roles: messagesFromState(state).map((message) => message.role),
        };
      },
    );

    await runScenario(
      defineScenario({
        name: "workflow-agent-harness-custom-control",
        workflows: { CUSTOM_CONTROL: customControlWorkflow },
        runners: ["agent", "controller"],
        steps: ({ workflow, runners, concurrent }) => [
          workflow.create({ workflow: "CUSTOM_CONTROL", id: "custom-control-session" }),
          concurrent({
            agent: [
              runners.agent.tick({
                workflow: "CUSTOM_CONTROL",
                instanceId: "custom-control-session",
                reason: "create",
              }),
            ],
            controller: [
              runners.controller.waitForEmission({
                workflow: "CUSTOM_CONTROL",
                instanceId: "custom-control-session",
                match: (emission) => {
                  const event = decodeScenarioHarnessEvent(emission);
                  return event?.type === "message_start" && event.message.role === "assistant";
                },
              }),
              workflow.event({
                workflow: "CUSTOM_CONTROL",
                instanceId: "custom-control-session",
                event: {
                  type: "priority-update",
                  payload: { instruction: "prioritize the tests" },
                },
              }),
              runners.controller.waitForEmission({
                workflow: "CUSTOM_CONTROL",
                instanceId: "custom-control-session",
                match: (emission) => {
                  const event = decodeScenarioHarnessEvent(emission);
                  return (
                    event?.type === "queue_update" &&
                    event.steer.some(
                      (message) =>
                        message.role === "user" &&
                        (typeof message.content === "string"
                          ? message.content === "prioritize the tests"
                          : message.content.some(
                              (content) =>
                                content.type === "text" && content.text === "prioritize the tests",
                            )),
                    )
                  );
                },
              }),
              workflow.read({
                read: async () => {
                  releaseInitialResponse.release();
                },
              }),
            ],
          }),
          workflow.read({
            read: async (ctx) => ctx.state.getStatus("CUSTOM_CONTROL", "custom-control-session"),
            assert: (status) => {
              expect(status).toMatchObject({
                status: "complete",
                output: { roles: ["user", "assistant", "user", "assistant"] },
              });
              expect(observedModelContexts).toEqual([
                [{ role: "user", text: "draft the implementation" }],
                [
                  { role: "user", text: "draft the implementation" },
                  { role: "assistant", text: "initial response" },
                  { role: "user", text: "prioritize the tests" },
                ],
              ]);
            },
          }),
        ],
      }),
    );
  });

  // This is a deliberate workflow-author error scenario. `step.do` still stores the first
  // operation result in durable workflow history, but `restoreWorkflowBackedSession` does not scan
  // unrelated prior step results. It reconstructs from the supplied session state plus emissions
  // from the current step, which are only for recovery of that step. Without folding each completed
  // result into session state, the next model-provider request receives a stale transcript and
  // omits the prior turn. This test documents that required state-folding contract and guards
  // against assuming the adapter applies completed results implicitly.
  test("shows that omitting a completed step reduction loses prior conversation state", async () => {
    const observedModelContexts: Array<Array<{ role: string; text: string }>> = [];
    let responseIndex = 0;
    const harnessOptions: WorkflowAgentHarnessOptions = {
      systemPrompt: "You are helpful.",
      model: mockModel,
      models: createModelsForStreamFn(mockModel, (model, context, options) => {
        observedModelContexts.push(
          context.messages.map((message) => ({
            role: message.role,
            text:
              typeof message.content === "string"
                ? message.content
                : message.content
                    .flatMap((content) => (content.type === "text" ? [content.text] : []))
                    .join(""),
          })),
        );
        responseIndex += 1;
        return createTextStreamFn(`response ${responseIndex}`)(model, context, options);
      }),
    };
    const omittedReductionWorkflowName = "workflow-agent-harness-omitted-reduction";
    const omittedReductionWorkflow = defineWorkflow(
      { name: omittedReductionWorkflowName, schema: z.object({}) },
      async (event, step) => {
        let state = createPiHarnessSessionState({
          metadata: {
            id: event.instanceId,
            createdAt: event.timestamp.toISOString(),
          },
        });

        const firstOperation = await step.do("first-prompt", async (tx) => {
          const {
            session,
            storage,
            options: restoredOptions,
          } = restoreWorkflowBackedSession({
            operationId: `${omittedReductionWorkflowName}:${event.instanceId}:first-prompt`,
            state,
            previousEmissions: await tx.previousEmissions(),
            models: harnessOptions.models,
          });
          const harness = new AgentHarness({ ...harnessOptions, ...restoredOptions });

          return await withWorkflowAgentHarness({
            session,
            storage,
            harness,
            tx,
            runDurableStep: () => harness.prompt("first prompt"),
          });
        });
        // Deliberately omit `state = applyWorkflowAgentHarnessStepResult(state, firstOperation)`.

        const secondOperation = await step.do("second-prompt", async (tx) => {
          const {
            session,
            storage,
            options: restoredOptions,
          } = restoreWorkflowBackedSession({
            operationId: `${omittedReductionWorkflowName}:${event.instanceId}:second-prompt`,
            state,
            previousEmissions: await tx.previousEmissions(),
            models: harnessOptions.models,
          });
          const harness = new AgentHarness({ ...harnessOptions, ...restoredOptions });

          return await withWorkflowAgentHarness({
            session,
            storage,
            harness,
            tx,
            runDurableStep: () => harness.prompt("second prompt"),
          });
        });
        state = applyWorkflowAgentHarnessStepResult(state, secondOperation);

        return {
          firstOperationEntryCount: firstOperation.appendedEntries.length,
          finalEntryCount: state.entries.length,
          finalRoles: messagesFromState(state).map((message) => message.role),
        };
      },
    );

    await runScenario(
      defineScenario({
        name: "workflow-agent-harness-omitted-reduction",
        workflows: { OMITTED_REDUCTION: omittedReductionWorkflow },
        steps: ({ workflow, runner }) => [
          runner.initializeAndRunUntilIdle({
            workflow: "OMITTED_REDUCTION",
            id: "omitted-reduction-session",
          }),
          workflow.read({
            read: async (ctx) => ({
              status: await ctx.state.getStatus("OMITTED_REDUCTION", "omitted-reduction-session"),
              steps: await ctx.state.getSteps("OMITTED_REDUCTION", "omitted-reduction-session"),
            }),
            assert: ({ status, steps }) => {
              expect(status).toMatchObject({
                status: "complete",
                output: {
                  firstOperationEntryCount: 2,
                  finalEntryCount: 2,
                  finalRoles: ["user", "assistant"],
                },
              });
              expect(observedModelContexts).toEqual([
                [{ role: "user", text: "first prompt" }],
                [{ role: "user", text: "second prompt" }],
              ]);
              expect(steps).toEqual(
                expect.arrayContaining([
                  expect.objectContaining({
                    stepKey: "do:first-prompt",
                    status: "completed",
                  }),
                  expect.objectContaining({
                    stepKey: "do:second-prompt",
                    status: "completed",
                  }),
                ]),
              );
            },
          }),
        ],
      }),
    );
  });

  test("rebuilds persisted session entry state when replaying completed steps after restart", async () => {
    const streamFn = vi.fn(createTextStreamFn("replayed after restart"));
    const harnesses: Record<string, WorkflowAgentHarnessOptions> = {
      default: {
        systemPrompt: "You are helpful.",
        model: mockModel,
        models: createModelsForStreamFn(mockModel, streamFn),
      },
    };
    const replayWorkflowSchema = z.object({ profileName: z.string() });
    const replayWorkflow = defineWorkflow(
      { name: "workflow-agent-harness-replay-completed-step", schema: replayWorkflowSchema },
      async (event, step) => {
        const params = replayWorkflowSchema.parse(event.payload ?? {});
        const harnessOptions = harnesses[params.profileName];
        if (!harnessOptions) {
          throw new Error(`Harness ${params.profileName} not found.`);
        }
        let state = createPiHarnessSessionState({
          metadata: {
            id: event.instanceId,
            createdAt: event.timestamp.toISOString(),
          },
          initialMessages: [
            {
              role: "user",
              content: "initial context",
              timestamp: event.timestamp.getTime(),
            },
          ],
        });

        const beforeRestart = await step.do("ask", async (tx) => {
          const {
            session,
            storage,
            options: restoredOptions,
          } = restoreWorkflowBackedSession({
            operationId: `${replayWorkflow.name}:${event.instanceId}:ask`,
            state,
            previousEmissions: await tx.previousEmissions(),
            models: harnessOptions.models,
          });
          const harness = new AgentHarness({ ...harnessOptions, ...restoredOptions });

          return await withWorkflowAgentHarness({
            session,
            storage,
            harness,
            tx,
            runDurableStep: () => harness.prompt("hello before restart"),
          });
        });
        state = applyWorkflowAgentHarnessStepResult(state, beforeRestart);
        await step.waitForEvent("resume", { type: "resume" });
        const afterRestart = await step.do("after-resume", async (tx) => {
          const {
            session,
            storage,
            options: restoredOptions,
          } = restoreWorkflowBackedSession({
            operationId: `${replayWorkflow.name}:${event.instanceId}:after-resume`,
            state,
            previousEmissions: await tx.previousEmissions(),
            models: harnessOptions.models,
          });
          const harness = new AgentHarness({ ...harnessOptions, ...restoredOptions });

          return await withWorkflowAgentHarness({
            session,
            storage,
            harness,
            tx,
            runDurableStep: () => harness.prompt("hello after restart"),
          });
        });
        state = applyWorkflowAgentHarnessStepResult(state, afterRestart);

        return {
          entryCount: state.entries.length,
          leafId: sessionEntriesLeafId(state.entries),
          persistedEntryCount: state.persistedEntryIds.length,
        };
      },
    );
    const config: PiFragmentConfig = { workflows: [replayWorkflow] };

    await runScenario(
      defineScenario({
        name: "pi-harness-replay-completed-step",
        workflows: createPiWorkflows({ workflows: config.workflows }),
        vars: () => ({ sessionId: "replay-completed-session" }),
        harness: {
          configureFragments: (harness) => ({
            pi: instantiate(piHarnessDefinition)
              .withConfig(config)
              .withRoutes([piRoutesFactory])
              .withServices({ workflows: harness.fragment.services }),
          }),
        },
        runners: ["worker"],
        steps: ({ workflow, runners }) => [
          workflow.create({
            workflow: replayWorkflow.name,
            id: (ctx) => ctx.vars.sessionId!,
            params: { profileName: "default" },
          }),
          runners.worker.runUntilIdle({
            workflow: replayWorkflow.name,
            instanceId: (ctx) => ctx.vars.sessionId!,
            reason: "create",
          }),
          workflow.read({
            read: async (ctx) => ({
              status: await ctx.state.getStatus(replayWorkflow.name, ctx.vars.sessionId!),
              steps: await ctx.state.getSteps(replayWorkflow.name, ctx.vars.sessionId!),
            }),
            assert: ({ status, steps }) => {
              assert(status.status === "waiting");
              expect(streamFn).toHaveBeenCalledTimes(1);
              const askStep = steps.find((step) => step.stepKey === "do:ask");
              assert(askStep?.result);
              const askResult = askStep.result as WorkflowAgentHarnessStepResult;
              expect(askResult.appendedEntries).toHaveLength(3);
              expect(askResult.appendedEntries[0]).toMatchObject({ id: "initial-0" });
              expect(steps).toContainEqual(
                expect.objectContaining({
                  stepKey: "waitForEvent:resume",
                  status: "waiting",
                }),
              );
            },
          }),
          runners.worker.restart(),
          workflow.event({
            workflow: replayWorkflow.name,
            instanceId: (ctx) => ctx.vars.sessionId!,
            event: { type: "resume", payload: {} },
          }),
          runners.worker.runUntilIdle({
            workflow: replayWorkflow.name,
            instanceId: (ctx) => ctx.vars.sessionId!,
            reason: "event",
          }),
          workflow.read({
            read: async (ctx) => ({
              status: await ctx.state.getStatus(replayWorkflow.name, ctx.vars.sessionId!),
              steps: await ctx.state.getSteps(replayWorkflow.name, ctx.vars.sessionId!),
            }),
            assert: ({ status, steps }) => {
              assert(status.status === "complete");
              expect(streamFn).toHaveBeenCalledTimes(2);
              expect(status.output).toMatchObject({ entryCount: 5, persistedEntryCount: 5 });

              const askStep = steps.find((step) => step.stepKey === "do:ask");
              const afterResumeStep = steps.find((step) => step.stepKey === "do:after-resume");
              expect(askStep).toMatchObject({ status: "completed", attempts: 1 });
              expect(afterResumeStep).toMatchObject({ status: "completed", attempts: 1 });
              assert(askStep?.result);
              assert(afterResumeStep?.result);
              expect(
                (askStep.result as WorkflowAgentHarnessStepResult).appendedEntries,
              ).toHaveLength(3);
              expect(
                (afterResumeStep.result as WorkflowAgentHarnessStepResult).appendedEntries,
              ).toHaveLength(2);
            },
          }),
        ],
      }),
    );
  });

  test("applies per-command active tool policy to registered tools", async () => {
    const observedToolNames: string[][] = [];
    const searchTool = definePiTool({
      name: "search",
      label: "Search",
      description: "Search docs.",
      parameters: Type.Object({ query: Type.String() }),
      async execute(_toolCallId, params) {
        return { content: [{ type: "text", text: `searched:${params.query}` }], details: {} };
      },
    });
    const writeTool = definePiTool({
      name: "write",
      label: "Write",
      description: "Write docs.",
      parameters: Type.Object({ path: Type.String() }),
      async execute(_toolCallId, params) {
        return { content: [{ type: "text", text: `wrote:${params.path}` }], details: {} };
      },
    });
    const tools = [searchTool, writeTool] as const;
    const streamFn: StreamFn = (model, context, options) => {
      observedToolNames.push((context.tools ?? []).map((tool) => tool.name));
      return createTextStreamFn("used only the active tool")(model, context, options);
    };
    const activeToolsWorkflow = defineWorkflow(
      { name: "workflow-agent-harness-active-tools-policy", schema: z.object({}) },
      async (event, step) => {
        let state = createPiHarnessSessionState({
          metadata: {
            id: event.instanceId,
            createdAt: event.timestamp.toISOString(),
          },
        });
        const commandEvent = await step.waitForEvent("command", { type: "command" });
        const command = piSessionCommandPayloadSchema.parse(commandEvent.payload);
        if (command.kind !== "prompt") {
          throw new Error("EXPECTED_PROMPT_COMMAND");
        }
        const result = await step.do(`command:${command.commandId}`, async (tx) => {
          const models = createModelsForStreamFn(mockModel, streamFn);
          const {
            session,
            storage,
            options: restoredOptions,
          } = restoreWorkflowBackedSession({
            operationId: `${activeToolsWorkflow.name}:${event.instanceId}:command:${command.commandId}`,
            state,
            previousEmissions: await tx.previousEmissions(),
            models,
          });
          const harness = new AgentHarness({
            systemPrompt: "Use only exposed tools.",
            model: mockModel,
            models,
            tools: [...tools],
            activeToolNames: ["search"],
            ...restoredOptions,
          });

          return await withWorkflowAgentHarness({
            session,
            storage,
            harness,
            tx,
            runDurableStep: () => harness.prompt(command.input.text),
          });
        });
        state = applyWorkflowAgentHarnessStepResult(state, result);

        return {
          entryCount: state.entries.length,
          leafId: sessionEntriesLeafId(state.entries),
        };
      },
    );
    const config: PiFragmentConfig = { workflows: [activeToolsWorkflow] };

    await runScenario(
      defineScenario({
        name: "pi-harness-active-tools-policy",
        workflows: createPiWorkflows({ workflows: config.workflows }),
        vars: () => ({ sessionId: undefined as string | undefined }),
        harness: {
          configureFragments: (harness) => ({
            pi: instantiate(piHarnessDefinition)
              .withConfig(config)
              .withRoutes([piRoutesFactory])
              .withServices({ workflows: harness.fragment.services }),
          }),
        },
        clients: ({ clientConfig }) => ({
          user: createPiFragmentClients(clientConfig("pi", { runner: "user" })),
        }),
        runners: ["agent", "user"],
        steps: ({ workflow, runners, clients }) => [
          workflow.read({
            read: async () => {
              const session = await clients.user.useCreateSession.mutateQuery({
                path: { workflowName: activeToolsWorkflow.name },
                body: { name: "Active Tools Session", input: {} },
              });
              assert(session && !Array.isArray(session), "expected session response");
              return session.id;
            },
            storeAs: "sessionId",
          }),
          runners.agent.runUntilIdle({
            workflow: activeToolsWorkflow.name,
            instanceId: (ctx) => ctx.vars.sessionId!,
            reason: "create",
          }),
          workflow.read({
            read: async (ctx) =>
              clients.user.useCommandSession.mutateQuery({
                path: { workflowName: activeToolsWorkflow.name, sessionId: ctx.vars.sessionId! },
                body: { kind: "prompt", input: { text: "search only" } },
              }),
          }),
          runners.agent.runUntilIdle({
            workflow: activeToolsWorkflow.name,
            instanceId: (ctx) => ctx.vars.sessionId!,
            reason: "event",
          }),
          workflow.read({
            read: async (ctx) =>
              clients.user.useSessionDetail.query({
                path: { workflowName: activeToolsWorkflow.name, sessionId: ctx.vars.sessionId! },
              }),
            assert: (detail) => {
              assert(detail && !Array.isArray(detail), "expected session detail response");
              expect(observedToolNames).toEqual([["search"]]);
              assert(detail.workflow.status === "complete");
              expect(detail.agent.state.messages).toContainEqual(
                expect.objectContaining({ role: "assistant", stopReason: "stop" }),
              );
            },
          }),
        ],
      }),
    );
  });

  test("uses already-loaded skills and prompt templates from harness resources", async () => {
    const observedPrompts: string[] = [];
    const streamFn: StreamFn = (model, context, options) => {
      const prompt = context.messages.at(-1)?.content;
      observedPrompts.push(
        typeof prompt === "string"
          ? prompt
          : (prompt ?? []).map((content) => (content.type === "text" ? content.text : "")).join(""),
      );
      return createTextStreamFn(`resource prompt ${observedPrompts.length}`)(
        model,
        context,
        options,
      );
    };
    const resourcesWorkflow = defineWorkflow(
      { name: "workflow-agent-harness-resources", schema: z.object({}) },
      async (event, step) => {
        let state = createPiHarnessSessionState({
          metadata: {
            id: event.instanceId,
            createdAt: event.timestamp.toISOString(),
          },
        });
        const harnessOptions: WorkflowAgentHarnessOptions = {
          systemPrompt: "Use loaded resources.",
          model: mockModel,
          models: createModelsForStreamFn(mockModel, streamFn),
          resources: {
            skills: [
              {
                name: "fragno",
                description: "Use for Fragno work.",
                content: "Always preserve durable workflow state.",
                filePath: "/repo/.agents/skills/fragno/SKILL.md",
              },
            ],
            promptTemplates: [
              {
                name: "review",
                description: "Review a change.",
                content: "Review $1 for durable Pi harness behavior.",
              },
            ],
          },
        };

        const skillResult = await step.do("invoke-skill", async (tx) => {
          const {
            session,
            storage,
            options: restoredOptions,
          } = restoreWorkflowBackedSession({
            operationId: `${resourcesWorkflow.name}:${event.instanceId}:invoke-skill`,
            state,
            previousEmissions: await tx.previousEmissions(),
            models: harnessOptions.models,
          });
          const harness = new AgentHarness({ ...harnessOptions, ...restoredOptions });

          return await withWorkflowAgentHarness({
            session,
            storage,
            harness,
            tx,
            runDurableStep: () => harness.skill("fragno", "Apply this to pi-harness."),
          });
        });
        state = applyWorkflowAgentHarnessStepResult(state, skillResult);
        const templateResult = await step.do("invoke-template", async (tx) => {
          const {
            session,
            storage,
            options: restoredOptions,
          } = restoreWorkflowBackedSession({
            operationId: `${resourcesWorkflow.name}:${event.instanceId}:invoke-template`,
            state,
            previousEmissions: await tx.previousEmissions(),
            models: harnessOptions.models,
          });
          const harness = new AgentHarness({ ...harnessOptions, ...restoredOptions });

          return await withWorkflowAgentHarness({
            session,
            storage,
            harness,
            tx,
            runDurableStep: () => harness.promptFromTemplate("review", ["teal-recorder"]),
          });
        });
        state = applyWorkflowAgentHarnessStepResult(state, templateResult);

        return {
          entryCount: state.entries.length,
          leafId: sessionEntriesLeafId(state.entries),
        };
      },
    );
    const config: PiFragmentConfig = { workflows: [resourcesWorkflow] };

    await runScenario(
      defineScenario({
        name: "pi-harness-resources",
        workflows: createPiWorkflows({ workflows: config.workflows }),
        vars: () => ({ sessionId: undefined as string | undefined }),
        harness: {
          configureFragments: (harness) => ({
            pi: instantiate(piHarnessDefinition)
              .withConfig(config)
              .withRoutes([piRoutesFactory])
              .withServices({ workflows: harness.fragment.services }),
          }),
        },
        clients: ({ clientConfig }) => ({
          user: createPiFragmentClients(clientConfig("pi", { runner: "user" })),
        }),
        runners: ["agent", "user"],
        steps: ({ workflow, runners, clients }) => [
          workflow.read({
            read: async () => {
              const session = await clients.user.useCreateSession.mutateQuery({
                path: { workflowName: resourcesWorkflow.name },
                body: { name: "Resources Session", input: {} },
              });
              assert(session && !Array.isArray(session), "expected session response");
              return session.id;
            },
            storeAs: "sessionId",
          }),
          runners.agent.runUntilIdle({
            workflow: resourcesWorkflow.name,
            instanceId: (ctx) => ctx.vars.sessionId!,
            reason: "create",
          }),
          workflow.read({
            read: async (ctx) =>
              clients.user.useSessionDetail.query({
                path: { workflowName: resourcesWorkflow.name, sessionId: ctx.vars.sessionId! },
              }),
            assert: (detail) => {
              assert(detail && !Array.isArray(detail), "expected session detail response");
              expect(observedPrompts[0]).toContain('<skill name="fragno"');
              expect(observedPrompts[0]).toContain("Always preserve durable workflow state.");
              expect(observedPrompts[0]).toContain("Apply this to pi-harness.");
              assert(
                observedPrompts[1] === "Review teal-recorder for durable Pi harness behavior.",
              );
              expect(detail.agent.state.messages).toMatchObject([
                { role: "user" },
                { role: "assistant", stopReason: "stop" },
                { role: "user" },
                { role: "assistant", stopReason: "stop" },
              ]);
            },
          }),
        ],
      }),
    );
  });

  test("runs an autonomous agentic workflow that hands off at a classification tool", async () => {
    let providerCalls = 0;
    const fakeSafetyApi = vi.fn(async (input: { text: string; offensive: boolean }) => ({
      action: input.offensive ? "escalated" : "allowed",
      ticketId: input.offensive ? "safety-123" : null,
    }));
    const classifySafetyTool = definePiTool({
      name: "classifySafety",
      label: "Classify safety",
      description: "Classify whether text is offensive.",
      parameters: Type.Object({ text: Type.String() }),
      resultSchema: Type.Object({ offensive: Type.Boolean() }),
      async execute(_toolCallId, params) {
        return {
          content: [
            {
              type: "text",
              text: params.text.includes("idiot") ? "offensive" : "not offensive",
            },
          ],
          details: { offensive: params.text.includes("idiot") },
        };
      },
    });
    const skippedClassificationStream = createTextStreamFn("This looks offensive to me.");
    const classifyStream = createToolCallStreamFn({
      type: "toolCall",
      id: "classify-call-1",
      name: "classifySafety",
      arguments: { text: "you are an idiot" },
    });
    const finalStream = createTextStreamFn(
      "Created safety ticket safety-123 and drafted a moderator summary.",
    );
    const streamFn: StreamFn = (model, context, options) => {
      providerCalls += 1;
      if (providerCalls === 1) {
        return skippedClassificationStream(model, context, options);
      }
      return providerCalls === 2
        ? classifyStream(model, context, options)
        : finalStream(model, context, options);
    };
    const harnesses: Record<string, WorkflowAgentHarnessOptions> = {
      default: {
        systemPrompt: "You are a safety operations agent.",
        model: mockModel,
        models: createModelsForStreamFn(mockModel, streamFn),
      },
    };
    const tools = [classifySafetyTool] as const;
    const actor = { type: "account", id: "safety-operator" };
    const onOperationCompleted = vi.fn();
    const workflowSchema = z.object({
      profileName: z.string(),
      text: z.string(),
      actor: z.unknown(),
    });
    const autonomousSafetyWorkflow = defineWorkflow(
      { name: "workflow-agent-harness-autonomous-safety-agent", schema: workflowSchema },
      async (event, step) => {
        const params = workflowSchema.parse(event.payload ?? {});
        const registeredHarness = harnesses[params.profileName];
        if (!registeredHarness) {
          throw new Error(`Harness ${params.profileName} not found.`);
        }
        const harnessOptions: WorkflowAgentHarnessOptions = {
          ...registeredHarness,
          tools: [...tools],
        };
        let state = createPiHarnessSessionState({
          metadata: {
            id: event.instanceId,
            createdAt: event.timestamp.toISOString(),
          },
        });
        let offensive: boolean | undefined;
        for (let attempt = 0; offensive === undefined && attempt < 3; attempt += 1) {
          const stepName = `classify-safety-${attempt}`;
          const operationId = `${autonomousSafetyWorkflow.name}:${event.instanceId}:${stepName}`;
          const prompt =
            attempt === 0
              ? `Classify this text: ${params.text}`
              : `You must call classifySafety for this text before deciding: ${params.text}`;
          const result = await step.do(stepName, async (tx) => {
            const {
              session,
              storage,
              options: restoredOptions,
            } = restoreWorkflowBackedSession({
              operationId,
              state,
              previousEmissions: await tx.previousEmissions(),
              models: harnessOptions.models,
            });
            const harness = new AgentHarness({ ...harnessOptions, ...restoredOptions });
            harness.on("tool_result", (toolResult) =>
              toolResult.toolName === "classifySafety" ? { terminate: true } : undefined,
            );

            return await withWorkflowAgentHarness({
              session,
              storage,
              harness,
              tx,
              runDurableStep: () => harness.prompt(prompt),
              onTerminalOutcome: ({ operationEntries }) => {
                schedulePiOperationCompletedHook({
                  tx,
                  actor: params.actor,
                  workflowName: autonomousSafetyWorkflow.name,
                  sessionId: event.instanceId,
                  metadata: { profileName: params.profileName },
                  stepName,
                  operationId,
                  operation: "prompt",
                  operationEntries,
                });
              },
            });
          });
          state = applyWorkflowAgentHarnessStepResult(state, result);

          const message = messagesFromState(state).at(-1);
          if (message?.role === "toolResult" && message.toolName === "classifySafety") {
            const details = message.details;
            if (
              typeof details === "object" &&
              details !== null &&
              "offensive" in details &&
              typeof details.offensive === "boolean"
            ) {
              offensive = details.offensive;
            }
          }
        }
        if (offensive === undefined) {
          throw new Error("MISSING_CLASSIFICATION_RESULT_AFTER_REPROMPT");
        }
        const apiResult = await step.do("external-safety-api", async () =>
          fakeSafetyApi({ text: params.text, offensive }),
        );
        const summaryStepName = "summarize-safety-action";
        const summaryOperationId = `${autonomousSafetyWorkflow.name}:${event.instanceId}:${summaryStepName}`;
        const summaryResult = await step.do(summaryStepName, async (tx) => {
          const {
            session,
            storage,
            options: restoredOptions,
          } = restoreWorkflowBackedSession({
            operationId: summaryOperationId,
            state,
            previousEmissions: await tx.previousEmissions(),
            models: harnessOptions.models,
          });
          const harness = new AgentHarness({ ...harnessOptions, ...restoredOptions });

          return await withWorkflowAgentHarness({
            session,
            storage,
            harness,
            tx,
            runDurableStep: () =>
              harness.prompt(
                `External safety API returned ${apiResult.action} with ticket ${apiResult.ticketId}. Draft the operator summary.`,
              ),
            onTerminalOutcome: ({ operationEntries }) => {
              schedulePiOperationCompletedHook({
                tx,
                actor: params.actor,
                workflowName: autonomousSafetyWorkflow.name,
                sessionId: event.instanceId,
                metadata: { profileName: params.profileName },
                stepName: summaryStepName,
                operationId: summaryOperationId,
                operation: "prompt",
                operationEntries,
              });
            },
          });
        });
        state = applyWorkflowAgentHarnessStepResult(state, summaryResult);

        return {
          action: apiResult.action,
          ticketId: apiResult.ticketId,
          leafId: sessionEntriesLeafId(state.entries),
        };
      },
    );
    const config: PiFragmentConfig = {
      workflows: [autonomousSafetyWorkflow],
      onOperationCompleted,
    };

    await runScenario(
      defineScenario({
        name: "pi-harness-autonomous-safety-agent",
        workflows: createPiWorkflows({
          workflows: config.workflows,
        }),
        vars: () => ({ sessionId: undefined as string | undefined }),
        harness: {
          configureFragments: (harness) => ({
            pi: instantiate(piHarnessDefinition)
              .withConfig(config)
              .withRoutes([piRoutesFactory])
              .withServices({ workflows: harness.fragment.services }),
          }),
        },
        clients: ({ clientConfig }) => ({
          user: createPiFragmentClients(clientConfig("pi", { runner: "user" })),
        }),
        runners: ["agent", "user"],
        steps: ({ workflow, hooks, runners, clients }) => [
          workflow.read({
            read: async () => {
              const session = await clients.user.useCreateSession.mutateQuery({
                path: { workflowName: autonomousSafetyWorkflow.name },
                body: {
                  name: "Autonomous Safety Session",
                  input: { profileName: "default", text: "you are an idiot", actor },
                },
              });
              assert(session && !Array.isArray(session), "expected session response");
              return session.id;
            },
            storeAs: "sessionId",
          }),
          runners.agent.runUntilIdle({
            workflow: autonomousSafetyWorkflow.name,
            instanceId: (ctx) => ctx.vars.sessionId!,
            reason: "create",
          }),
          hooks.read<PiOperationCompletedHookPayload>({
            fragment: "pi",
            hookName: "onOperationCompleted",
            status: "pending",
            assert: (records) => {
              expect(records).toHaveLength(3);
              expect(records.map((record) => record.payload.stepName)).toEqual(
                expect.arrayContaining([
                  "classify-safety-0",
                  "classify-safety-1",
                  "summarize-safety-action",
                ]),
              );
              expect(onOperationCompleted).not.toHaveBeenCalled();
            },
          }),
          runners.agent.drainHooks(),
          hooks.read<PiOperationCompletedHookPayload>({
            fragment: "pi",
            hookName: "onOperationCompleted",
            status: "completed",
            assert: (records, ctx) => {
              assert(ctx.vars.sessionId, "session id should be set");
              expect(records).toHaveLength(3);

              const recordsByStepName = new Map(
                records.map((record) => [record.payload.stepName, record]),
              );
              const expectedUsage = {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              };
              const expectedStopReasons = new Map([
                ["classify-safety-0", "stop"],
                ["classify-safety-1", "toolUse"],
                ["summarize-safety-action", "stop"],
              ] as const);

              for (const [stepName, stopReason] of expectedStopReasons) {
                expect(recordsByStepName.get(stepName)).toEqual(
                  expect.objectContaining({
                    hookName: "onOperationCompleted",
                    status: "completed",
                    payload: {
                      actor,
                      workflowName: autonomousSafetyWorkflow.name,
                      sessionId: ctx.vars.sessionId,
                      metadata: { profileName: "default" },
                      stepName,
                      operationId: `${autonomousSafetyWorkflow.name}:${ctx.vars.sessionId}:${stepName}`,
                      operation: "prompt",
                      modelCalls: [
                        {
                          api: "openai-responses",
                          provider: "openai",
                          model: "test-model",
                          usage: expectedUsage,
                          stopReason,
                          timestamp: expect.any(Number),
                        },
                      ],
                      usage: expectedUsage,
                    },
                  }),
                );
              }
            },
          }),
          workflow.read({
            read: async (ctx) => ({
              detail: await clients.user.useSessionDetail.query({
                path: {
                  workflowName: autonomousSafetyWorkflow.name,
                  sessionId: ctx.vars.sessionId!,
                },
              }),
              status: await ctx.state.getStatus(autonomousSafetyWorkflow.name, ctx.vars.sessionId!),
            }),
            assert: ({ detail, status }) => {
              assert(detail && !Array.isArray(detail), "expected session detail response");
              assert(status.status === "complete");
              expect(status.output).toMatchObject({ action: "escalated", ticketId: "safety-123" });
              expect(fakeSafetyApi).toHaveBeenCalledWith({
                text: "you are an idiot",
                offensive: true,
              });
              assert(providerCalls === 3);
              expect(onOperationCompleted).toHaveBeenCalledTimes(3);
              expect(onOperationCompleted.mock.calls.map(([payload]) => payload)).toEqual(
                expect.arrayContaining([
                  expect.objectContaining({
                    actor,
                    operation: "prompt",
                    stepName: "classify-safety-0",
                  }),
                  expect.objectContaining({
                    actor,
                    operation: "prompt",
                    stepName: "classify-safety-1",
                  }),
                  expect.objectContaining({
                    actor,
                    operation: "prompt",
                    stepName: "summarize-safety-action",
                  }),
                ]),
              );
              expect(detail.agent.state.messages).toMatchObject([
                { role: "user" },
                { role: "assistant", stopReason: "stop" },
                { role: "user" },
                { role: "assistant", stopReason: "toolUse" },
                { role: "toolResult", toolName: "classifySafety" },
                { role: "user" },
                { role: "assistant", stopReason: "stop" },
              ]);
              expect(detail.agent.state.messages[4]).toMatchObject({
                role: "toolResult",
                content: [{ type: "text", text: "offensive" }],
                details: { offensive: true },
              });
              expect(detail.agent.state.messages[6]).toMatchObject({
                role: "assistant",
                content: [
                  {
                    type: "text",
                    text: "Created safety ticket safety-123 and drafted a moderator summary.",
                  },
                ],
              });
            },
          }),
        ],
      }),
    );
  });

  test("uses stopOnTools to terminate after a matching tool result", async () => {
    const classifyTool = definePiTool({
      name: "classify",
      label: "Classify",
      description: "Classify a request.",
      parameters: Type.Object({ request: Type.String() }),
      async execute(_toolCallId, params) {
        return {
          content: [{ type: "text", text: `classified:${params.request}` }],
          details: { stoppedBy: "workflow-option" as const },
        };
      },
    });
    const streamFn = vi.fn(
      createToolCallStreamFn({
        type: "toolCall",
        id: "call-1",
        name: "classify",
        arguments: { request: "handoff" },
      }),
    );
    const harnesses: Record<string, WorkflowAgentHarnessOptions> = {
      default: {
        systemPrompt: "You are helpful.",
        model: mockModel,
        models: createModelsForStreamFn(mockModel, streamFn),
      },
    };
    const tools = [classifyTool] as const;
    const stopOnToolsWorkflow = defineWorkflow(
      {
        name: "workflow-agent-harness-stop-on-tools",
        schema: z.object({ profileName: z.string() }),
      },
      async (event, step) => {
        const params = z.object({ profileName: z.string() }).parse(event.payload ?? {});
        const registeredHarness = harnesses[params.profileName];
        if (!registeredHarness) {
          throw new Error(`Harness ${params.profileName} not found.`);
        }
        let state = createPiHarnessSessionState({
          metadata: {
            id: event.instanceId,
            createdAt: event.timestamp.toISOString(),
          },
        });
        const commandEvent = await step.waitForEvent("command", {
          type: "command",
          timeout: "1 hour",
        });
        const command = piSessionCommandPayloadSchema.parse(commandEvent.payload);
        if (command.kind !== "prompt") {
          return { skipped: true };
        }
        const result = await step.do(`command:${command.commandId}`, async (tx) => {
          const {
            session,
            storage,
            options: restoredOptions,
          } = restoreWorkflowBackedSession({
            operationId: `${stopOnToolsWorkflow.name}:${event.instanceId}:command:${command.commandId}`,
            state,
            previousEmissions: await tx.previousEmissions(),
            models: registeredHarness.models,
          });
          const harness = new AgentHarness({
            ...registeredHarness,
            tools: [...tools],
            ...restoredOptions,
          });
          harness.on("tool_result", (toolResult) =>
            toolResult.toolName === "classify" ? { terminate: true } : undefined,
          );

          return await withWorkflowAgentHarness({
            session,
            storage,
            harness,
            tx,
            runDurableStep: () => harness.prompt(command.input.text),
          });
        });
        state = applyWorkflowAgentHarnessStepResult(state, result);

        return {
          entryCount: state.entries.length,
          leafId: sessionEntriesLeafId(state.entries),
        };
      },
    );
    const config: PiFragmentConfig = { workflows: [stopOnToolsWorkflow] };

    await runScenario(
      defineScenario({
        name: "pi-harness-stop-on-tools",
        workflows: createPiWorkflows({
          workflows: config.workflows,
        }),
        vars: () => ({ sessionId: undefined as string | undefined }),
        harness: {
          configureFragments: (harness) => ({
            pi: instantiate(piHarnessDefinition)
              .withConfig(config)
              .withRoutes([piRoutesFactory])
              .withServices({ workflows: harness.fragment.services }),
          }),
        },
        clients: ({ clientConfig }) => ({
          user: createPiFragmentClients(clientConfig("pi", { runner: "user" })),
        }),
        runners: ["agent", "user"],
        steps: ({ workflow, runners, clients }) => [
          workflow.read({
            read: async () => {
              const session = await clients.user.useCreateSession.mutateQuery({
                path: { workflowName: stopOnToolsWorkflow.name },
                body: { name: "Stop Tool Session", input: { profileName: "default" } },
              });
              assert(session && !Array.isArray(session), "expected session response");
              return session.id;
            },
            storeAs: "sessionId",
          }),
          runners.agent.runUntilIdle({
            workflow: stopOnToolsWorkflow.name,
            instanceId: (ctx) => ctx.vars.sessionId!,
            reason: "create",
          }),
          workflow.read({
            read: async (ctx) => {
              assert(ctx.vars.sessionId, "session id should be set");
              return await clients.user.useCommandSession.mutateQuery({
                path: { workflowName: stopOnToolsWorkflow.name, sessionId: ctx.vars.sessionId },
                body: { kind: "prompt", input: { text: "classify this" } },
              });
            },
          }),
          runners.agent.runUntilIdle({
            workflow: stopOnToolsWorkflow.name,
            instanceId: (ctx) => ctx.vars.sessionId!,
            reason: "event",
          }),
          workflow.read({
            read: async (ctx) =>
              clients.user.useSessionDetail.query({
                path: {
                  workflowName: stopOnToolsWorkflow.name,
                  sessionId: ctx.vars.sessionId!,
                },
              }),
            assert: (detail) => {
              assert(detail && !Array.isArray(detail), "expected session detail response");
              expect(streamFn).toHaveBeenCalledTimes(1);
              assert(detail.workflow.status === "complete");
              expect(detail.agent.state.messages).toMatchObject([
                { role: "user" },
                { role: "assistant", stopReason: "toolUse" },
                { role: "toolResult", toolCallId: "call-1", toolName: "classify" },
              ]);
              expect(detail.agent.state.messages[2]).toMatchObject({
                role: "toolResult",
                content: [{ type: "text", text: "classified:handoff" }],
                details: { stoppedBy: "workflow-option" },
              });
            },
          }),
        ],
      }),
    );
  });

  test("persists manual compaction and restores its context for the next prompt", async () => {
    const largeContinuation = "continue ".repeat(7_000);
    const observedContexts: Array<Array<{ role: string; text: string }>> = [];
    const streamFn = vi.fn<StreamFn>((model, context, options) => {
      observedContexts.push(
        context.messages.map((message) => ({
          role: message.role,
          text:
            typeof message.content === "string"
              ? message.content
              : message.content
                  .flatMap((content) => (content.type === "text" ? [content.text] : []))
                  .join(""),
        })),
      );
      return createTextStreamFn("continued after compaction")(model, context, options);
    });
    const compactWorkflow = defineWorkflow(
      { name: "workflow-agent-harness-manual-compaction" },
      async (event, step) => {
        const initialMessages: AgentMessage[] = [];
        for (let turn = 0; turn < 4; turn += 1) {
          initialMessages.push({
            role: "user",
            content: `turn-${turn} `.repeat(7_000),
            timestamp: Date.UTC(2026, 6, 1, 12, turn * 2),
          });
          initialMessages.push({
            ...createAssistantMessage(`response-${turn}`),
            timestamp: Date.UTC(2026, 6, 1, 12, turn * 2 + 1),
          });
        }

        let state = createPiHarnessSessionState({
          metadata: {
            id: event.instanceId,
            createdAt: event.timestamp.toISOString(),
          },
          initialMessages,
        });
        const models = createModelsForStreamFn(mockModel, streamFn);

        const compactResult = await step.do("compact", async (tx) => {
          const { session, storage, options } = restoreWorkflowBackedSession({
            operationId: `${event.instanceId}:compact`,
            state,
            previousEmissions: await tx.previousEmissions(),
            models,
          });
          const harness = new AgentHarness({ models, model: mockModel, ...options });
          mockAgentHarnessCompaction(harness, {
            summary: "Earlier turns established the durable compaction contract.",
            details: { source: "scenario-test" },
          });

          return await withWorkflowAgentHarness({
            session,
            storage,
            harness,
            tx,
            runDurableStep: () => harness.compact("Keep the compaction contract."),
          });
        });
        state = applyWorkflowAgentHarnessStepResult(state, compactResult);

        const promptResult = await step.do("prompt-after-compact", async (tx) => {
          const { session, storage, options } = restoreWorkflowBackedSession({
            operationId: `${event.instanceId}:prompt-after-compact`,
            state,
            previousEmissions: await tx.previousEmissions(),
            models,
          });
          const harness = new AgentHarness({ models, model: mockModel, ...options });

          return await withWorkflowAgentHarness({
            session,
            storage,
            harness,
            tx,
            runDurableStep: () => harness.prompt(largeContinuation),
          });
        });
        state = applyWorkflowAgentHarnessStepResult(state, promptResult);

        const secondCompactResult = await step.do("compact-again", async (tx) => {
          const { session, storage, options } = restoreWorkflowBackedSession({
            operationId: `${event.instanceId}:compact-again`,
            state,
            previousEmissions: await tx.previousEmissions(),
            models,
          });
          const harness = new AgentHarness({ models, model: mockModel, ...options });
          let summarizedTexts: string[] = [];
          let previousSummary: string | undefined;
          mockAgentHarnessCompaction(harness, (compactEvent) => {
            summarizedTexts = compactEvent.preparation.messagesToSummarize.map(agentMessageText);
            previousSummary = compactEvent.preparation.previousSummary;
            return { summary: "Updated durable compaction contract." };
          });

          return await withWorkflowAgentHarness({
            session,
            storage,
            harness,
            tx,
            runDurableStep: async () => ({
              compact: await harness.compact("Keep updating the compaction contract."),
              summarizedTexts,
              previousSummary,
            }),
          });
        });
        state = applyWorkflowAgentHarnessStepResult(state, secondCompactResult);

        const secondPromptResult = await step.do("prompt-after-second-compact", async (tx) => {
          const { session, storage, options } = restoreWorkflowBackedSession({
            operationId: `${event.instanceId}:prompt-after-second-compact`,
            state,
            previousEmissions: await tx.previousEmissions(),
            models,
          });
          const harness = new AgentHarness({ models, model: mockModel, ...options });

          return await withWorkflowAgentHarness({
            session,
            storage,
            harness,
            tx,
            runDurableStep: () => harness.prompt("continue again"),
          });
        });
        state = applyWorkflowAgentHarnessStepResult(state, secondPromptResult);

        const compactionEntries = state.entries.filter((entry) => entry.type === "compaction");
        const firstCompactionEntry = compactionEntries[0];
        const secondCompactionEntry = compactionEntries[1];
        assert(firstCompactionEntry?.type === "compaction");
        assert(secondCompactionEntry?.type === "compaction");
        return {
          firstSummary: firstCompactionEntry.summary,
          firstDetails: firstCompactionEntry.details,
          firstRetainedRoles: firstCompactionEntry.retainedTail?.map((message) => message.role),
          firstAssistantText: messageText(promptResult.value),
          secondSummary: secondCompactionEntry.summary,
          secondAssistantText: messageText(secondPromptResult.value),
          secondPreviousSummary: secondCompactResult.value.previousSummary,
          secondSummarizedEarlierTurn: secondCompactResult.value.summarizedTexts.some((text) =>
            text.includes("turn-"),
          ),
        };
      },
    );

    await runScenario(
      defineScenario({
        name: "workflow-agent-harness-manual-compaction",
        workflows: { MANUAL_COMPACTION: compactWorkflow },
        steps: ({ workflow, runner }) => [
          runner.initializeAndRunUntilIdle({
            workflow: "MANUAL_COMPACTION",
            id: "manual-compaction-session",
          }),
          workflow.read({
            read: async (ctx) =>
              ctx.state.getStatus("MANUAL_COMPACTION", "manual-compaction-session"),
            assert: (status) => {
              assert(status.status === "complete");
              expect(status.output).toEqual({
                firstSummary: "Earlier turns established the durable compaction contract.",
                firstDetails: { source: "scenario-test" },
                firstRetainedRoles: ["user", "assistant", "user", "assistant"],
                firstAssistantText: "continued after compaction",
                secondSummary: "Updated durable compaction contract.",
                secondAssistantText: "continued after compaction",
                secondPreviousSummary: "Earlier turns established the durable compaction contract.",
                secondSummarizedEarlierTurn: true,
              });
              expect(streamFn).toHaveBeenCalledTimes(2);
              expect(observedContexts).toHaveLength(2);
              expect(observedContexts[0]?.map(({ role }) => role)).toEqual([
                "user",
                "user",
                "assistant",
                "user",
                "assistant",
                "user",
              ]);
              expect(observedContexts[0]?.[0]?.text).toContain(
                "Earlier turns established the durable compaction contract.",
              );
              expect(observedContexts[0]?.at(-1)).toEqual({
                role: "user",
                text: largeContinuation,
              });
              expect(observedContexts[1]?.[0]?.text).toContain(
                "Updated durable compaction contract.",
              );
              expect(observedContexts[1]?.at(-1)).toEqual({
                role: "user",
                text: "continue again",
              });
            },
          }),
        ],
      }),
    );
  });

  test("runs one workflow step through a real Pi Session and AgentHarness", async () => {
    const streamFn = vi.fn(createTextStreamFn("hello from workflow AgentHarness"));
    const happyPathWorkflow = defineWorkflow(
      { name: "workflow-agent-harness-happy-path" },
      async (event, step) => {
        let state = createPiHarnessSessionState({
          metadata: {
            id: event.instanceId,
            createdAt: event.timestamp.toISOString(),
          },
        });

        const promptResult = await step.do("prompt", async (tx) => {
          const models = createModelsForStreamFn(mockModel, streamFn);
          const {
            session,
            storage,
            options: restoredOptions,
          } = restoreWorkflowBackedSession({
            operationId: `${event.instanceId}:prompt`,
            state,
            previousEmissions: await tx.previousEmissions(),
            models,
          });
          const harness = new AgentHarness({
            models,
            model: mockModel,
            systemPrompt: "You are helpful.",
            ...restoredOptions,
          });

          return await withWorkflowAgentHarness({
            session,
            storage,
            harness,
            tx,
            runDurableStep: () => harness.prompt("hello"),
          });
        });

        state = applyWorkflowAgentHarnessStepResult(state, promptResult);

        return {
          assistantText: messageText(promptResult.value),
          roles: state.entries.flatMap((entry) =>
            entry.type === "message" ? [entry.message.role] : [],
          ),
        };
      },
    );
    const workflows = { HAPPY_PATH: happyPathWorkflow };

    await runScenario(
      defineScenario({
        name: "workflow-agent-harness-happy-path",
        workflows,
        steps: ({ workflow, runner }) => [
          runner.initializeAndRunUntilIdle({
            workflow: "HAPPY_PATH",
            id: "workflow-agent-harness-session",
          }),
          workflow.read({
            read: async (ctx) => ({
              status: await ctx.state.getStatus("HAPPY_PATH", "workflow-agent-harness-session"),
              emissions: await ctx.state.getEmissions(
                "HAPPY_PATH",
                "workflow-agent-harness-session",
              ),
            }),
            assert: ({ status, emissions }) => {
              assert(status.status === "complete");
              expect(status.output).toEqual({
                assistantText: "hello from workflow AgentHarness",
                roles: ["user", "assistant"],
              });
              expect(streamFn).toHaveBeenCalledTimes(1);

              const emissionKinds = emissions.flatMap((emission) => {
                const payload = emission.payload;
                return typeof payload === "object" && payload !== null && "kind" in payload
                  ? [payload.kind]
                  : [];
              });
              expect(emissionKinds).toContain("harness-operation-start");
              expect(emissionKinds).toContain("harness-session-entry");
              expect(emissionKinds).toContain("harness-operation-complete");
            },
          }),
        ],
      }),
    );
  });
});
