import { assert, describe, expect, test, vi } from "vitest";

import type { WorkflowStepEmission, WorkflowStepTx } from "@fragno-dev/workflows/workflow";
import { Type } from "typebox";

import type { HandlerTxContext } from "@fragno-dev/db";

import {
  AgentHarness,
  type AgentMessage,
  type AgentTool,
  type SessionTreeEntry,
} from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Model,
  type ToolCall,
} from "@earendil-works/pi-ai";

import type { PiHarnessHooksMap } from "../definition";
import type { PiOperationCompletedHookPayload } from "../types";
import {
  createPiHarnessSessionState,
  restoreWorkflowBackedSession,
  withWorkflowAgentHarness,
  type PiHarnessEmission,
  type WorkflowAgentHarnessStepResult,
} from "../workflows/workflow-agent-harness";
import { schedulePiOperationCompletedHook } from "./pi-operation-completed";
import { createModelsForStreamFn } from "./test-models";

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

const usage = (options: {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}): AssistantMessage["usage"] => {
  const cacheRead = options.cacheRead ?? 0;
  const cacheWrite = options.cacheWrite ?? 0;
  return {
    input: options.input,
    output: options.output,
    cacheRead,
    cacheWrite,
    totalTokens: options.input + options.output + cacheRead + cacheWrite,
    cost: {
      input: options.input / 100,
      output: options.output / 100,
      cacheRead: cacheRead / 100,
      cacheWrite: cacheWrite / 100,
      total: (options.input + options.output + cacheRead + cacheWrite) / 100,
    },
  };
};

const createAssistantMessage = (
  text: string,
  messageUsage: AssistantMessage["usage"],
): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: mockModel.api,
  provider: mockModel.provider,
  model: mockModel.id,
  usage: structuredClone(messageUsage),
  stopReason: "stop",
  timestamp: Date.now(),
});

const createTextStreamFn = (text: string, messageUsage: AssistantMessage["usage"]) => () => {
  const stream = createAssistantMessageEventStream();
  const message = createAssistantMessage(text, messageUsage);
  stream.push({ type: "start", partial: message });
  stream.push({ type: "text_start", contentIndex: 0, partial: message });
  stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
  stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
  stream.push({ type: "done", reason: "stop", message });
  stream.end();
  return stream;
};

const createAbortedStreamFn = (messageUsage: AssistantMessage["usage"]) => () => {
  const stream = createAssistantMessageEventStream();
  const message = createAssistantMessage("", messageUsage);
  message.stopReason = "aborted";
  message.errorMessage = "Request was aborted";
  stream.push({ type: "error", reason: "aborted", error: message });
  stream.end();
  return stream;
};

const createErrorStreamFn =
  (errorMessage: string, messageUsage: AssistantMessage["usage"]) => () => {
    const stream = createAssistantMessageEventStream();
    const message = createAssistantMessage("", messageUsage);
    message.stopReason = "error";
    message.errorMessage = errorMessage;
    stream.push({ type: "error", reason: "error", error: message });
    stream.end();
    return stream;
  };

const createToolCallStreamFn =
  (toolCall: ToolCall, messageUsage: AssistantMessage["usage"]) => () => {
    const stream = createAssistantMessageEventStream();
    const message = createAssistantMessage("", messageUsage);
    message.content = [toolCall];
    message.stopReason = "toolUse";
    stream.push({ type: "start", partial: message });
    stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
    stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
    stream.push({ type: "done", reason: "toolUse", message });
    stream.end();
    return stream;
  };

const createAlternatingToolThenTextStreamFn = (options: {
  toolCall: ToolCall;
  text: string;
  toolUsage: AssistantMessage["usage"];
  textUsage: AssistantMessage["usage"];
}) => {
  let callCount = 0;
  return () => {
    callCount += 1;
    return callCount % 2 === 1
      ? createToolCallStreamFn(options.toolCall, options.toolUsage)()
      : createTextStreamFn(options.text, options.textUsage)();
  };
};

type TriggeredOperationCompletedHook = {
  name: "onOperationCompleted";
  payload: PiOperationCompletedHookPayload;
};

type Mutation = (context: HandlerTxContext<PiHarnessHooksMap>) => void;

type AccountingAttempt = {
  tx: WorkflowStepTx<PiHarnessHooksMap>;
  emitted: PiHarnessEmission<WorkflowAgentHarnessStepResult<AssistantMessage>>[];
  commit: () => TriggeredOperationCompletedHook[];
};

const createAccountingAttempt = (): AccountingAttempt => {
  const emitted: PiHarnessEmission<WorkflowAgentHarnessStepResult<AssistantMessage>>[] = [];
  const mutations: Mutation[] = [];
  const terminalErrorMutations: Mutation[] = [];
  const triggeredHooks: TriggeredOperationCompletedHook[] = [];
  const mutationContext = {
    idempotencyKey: "accounting-attempt",
    currentAttempt: 0,
    forSchema: () => ({
      triggerHook: (name: "onOperationCompleted", payload: PiOperationCompletedHookPayload) => {
        triggeredHooks.push({ name, payload });
      },
    }),
  } as unknown as HandlerTxContext<PiHarnessHooksMap>;
  const tx = {
    serviceCalls: () => undefined,
    workflowServiceCalls: () => undefined,
    mutate: (mutation: Mutation) => mutations.push(mutation),
    emit: (payload: unknown) =>
      emitted.push(payload as PiHarnessEmission<WorkflowAgentHarnessStepResult<AssistantMessage>>),
    previousEmissions: async () => [],
    previousConsumedEvents: async () => [],
    onTerminalError: { mutate: (mutation: Mutation) => terminalErrorMutations.push(mutation) },
    onEvent: () => () => undefined,
  } as WorkflowStepTx<PiHarnessHooksMap>;

  return {
    tx,
    emitted,
    commit: () => {
      for (const mutation of mutations) {
        mutation(mutationContext);
      }
      return triggeredHooks;
    },
  };
};

const toPreviousEmissions = (
  payloads: readonly unknown[],
  epoch = "previous-attempt",
): WorkflowStepEmission[] =>
  payloads.map((payload, sequence) => ({
    id: `${epoch}-emission-${sequence}`,
    actor: "user",
    stepKey: "do:prompt",
    executionId: `${epoch}-execution`,
    epoch,
    sequence,
    payload,
    createdAt: new Date("2026-07-01T12:00:00.000Z"),
  }));

const withoutOperationCompletion = (
  emissions: readonly PiHarnessEmission<WorkflowAgentHarnessStepResult<AssistantMessage>>[],
) => emissions.filter((emission) => emission.kind !== "harness-operation-complete");

const emissionsThroughFirstToolResult = (
  emissions: readonly PiHarnessEmission<WorkflowAgentHarnessStepResult<AssistantMessage>>[],
) => {
  const partial: PiHarnessEmission<WorkflowAgentHarnessStepResult<AssistantMessage>>[] = [];
  for (const emission of emissions) {
    partial.push(emission);
    if (
      emission.kind === "harness-session-entry" &&
      emission.entry.type === "message" &&
      emission.entry.message.role === "toolResult"
    ) {
      return partial;
    }
  }
  throw new Error("TEST_TOOL_RESULT_ENTRY_NOT_EMITTED");
};

const activeMessageRoles = (
  entries: readonly SessionTreeEntry[],
  leafId: string | null,
): string[] => {
  const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
  const roles: string[] = [];
  let entry = leafId ? entriesById.get(leafId) : undefined;
  while (entry) {
    if (entry.type === "message") {
      roles.unshift(entry.message.role);
    }
    entry = entry.parentId ? entriesById.get(entry.parentId) : undefined;
  }
  return roles;
};

const accountingMetadata = {
  actor: { type: "account", id: "account-1" },
  workflowName: "recovery-accounting-workflow",
  sessionId: "recovery-accounting-session",
  metadata: { runtime: "default" },
  stepName: "prompt",
  operation: "prompt" as const,
};

const runAccountingInvocation = async (options: {
  operationId: string;
  previousEmissions?: readonly WorkflowStepEmission[];
  streamFn: ReturnType<typeof createTextStreamFn>;
  tools?: readonly AgentTool[];
  initialMessages?: readonly AgentMessage[];
  checkpointTerminalAssistantError?: boolean;
  attempt: AccountingAttempt;
}) => {
  const models = createModelsForStreamFn(mockModel, options.streamFn);
  const restored = restoreWorkflowBackedSession({
    operationId: options.operationId,
    state: createPiHarnessSessionState({
      metadata: {
        id: accountingMetadata.sessionId,
        createdAt: "2026-07-01T12:00:00.000Z",
      },
      initialMessages: options.initialMessages,
    }),
    previousEmissions: options.previousEmissions ?? [],
    models,
  });
  const harness = new AgentHarness({
    systemPrompt: "You are helpful.",
    model: mockModel,
    models,
    tools: [...(options.tools ?? [])],
    ...restored.options,
  });

  return await withWorkflowAgentHarness({
    restored,
    harness,
    tx: options.attempt.tx,
    runDurableStep: () => harness.prompt("hello"),
    checkpointTerminalAssistantError: options.checkpointTerminalAssistantError,
    onTerminalOutcome: ({ operationEntries }) => {
      schedulePiOperationCompletedHook({
        tx: options.attempt.tx,
        ...accountingMetadata,
        operationId: options.operationId,
        operationEntries,
      });
    },
  });
};

describe("workflow AgentHarness recovery accounting", () => {
  test("accounts a recovered completion without calling the provider again", async () => {
    const operationId = "recovered-completion";
    const completedUsage = usage({ input: 80, output: 20, cacheRead: 10, cacheWrite: 5 });
    const streamFn = vi.fn(createTextStreamFn("completed once", completedUsage));
    const firstAttempt = createAccountingAttempt();

    await runAccountingInvocation({ operationId, streamFn, attempt: firstAttempt });

    const secondAttempt = createAccountingAttempt();
    const replayResult = await runAccountingInvocation({
      operationId,
      streamFn,
      attempt: secondAttempt,
      previousEmissions: toPreviousEmissions(firstAttempt.emitted),
    });
    const hooks = secondAttempt.commit();

    expect(streamFn).toHaveBeenCalledTimes(1);
    assert(replayResult.outcome === "completed");
    expect(replayResult.value).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "completed once" }],
    });
    expect(secondAttempt.emitted).toEqual([]);
    expect(hooks).toEqual([
      {
        name: "onOperationCompleted",
        payload: expect.objectContaining({
          operationId,
          modelCalls: [expect.objectContaining({ stopReason: "stop", usage: completedUsage })],
          usage: completedUsage,
        }),
      },
    ]);
  });

  test("excludes initial assistant usage from current-operation accounting", async () => {
    const historicalUsage = usage({ input: 900, output: 90, cacheRead: 45 });
    const currentUsage = usage({ input: 80, output: 20, cacheWrite: 5 });
    const historicalAssistant = createAssistantMessage("historical response", historicalUsage);
    historicalAssistant.timestamp = new Date("2026-07-01T11:59:00.000Z").getTime();
    const attempt = createAccountingAttempt();

    const result = await runAccountingInvocation({
      operationId: "initial-context-accounting",
      streamFn: createTextStreamFn("current response", currentUsage),
      initialMessages: [
        {
          role: "user",
          content: "historical prompt",
          timestamp: new Date("2026-07-01T11:58:00.000Z").getTime(),
        },
        historicalAssistant,
      ],
      attempt,
    });
    const hooks = attempt.commit();

    assert(result.outcome === "completed");
    expect(result.appendedEntries.filter((entry) => /^initial-\d+$/.test(entry.id))).toHaveLength(
      2,
    );
    expect(hooks).toEqual([
      {
        name: "onOperationCompleted",
        payload: expect.objectContaining({
          modelCalls: [expect.objectContaining({ usage: currentUsage })],
          usage: currentUsage,
        }),
      },
    ]);
  });

  test("accounts an aborted call recovered from a completion checkpoint", async () => {
    const operationId = "recovered-aborted-completion";
    const abortedUsage = usage({ input: 75, output: 4, cacheRead: 25 });
    const streamFn = vi.fn(createAbortedStreamFn(abortedUsage));
    const firstAttempt = createAccountingAttempt();
    await runAccountingInvocation({ operationId, streamFn, attempt: firstAttempt });

    const recoveredAttempt = createAccountingAttempt();
    const result = await runAccountingInvocation({
      operationId,
      streamFn,
      attempt: recoveredAttempt,
      previousEmissions: toPreviousEmissions(firstAttempt.emitted),
    });
    const hooks = recoveredAttempt.commit();

    expect(streamFn).toHaveBeenCalledTimes(1);
    assert(result.outcome === "aborted");
    expect(result.appendedEntries).toContainEqual(
      expect.objectContaining({
        type: "message",
        message: expect.objectContaining({ stopReason: "aborted", usage: abortedUsage }),
      }),
    );
    expect(hooks).toEqual([
      {
        name: "onOperationCompleted",
        payload: expect.objectContaining({
          modelCalls: [expect.objectContaining({ stopReason: "aborted", usage: abortedUsage })],
          usage: abortedUsage,
        }),
      },
    ]);
  });

  test("accounts an uncommitted aborted attempt when recovery checkpoints the abort", async () => {
    const operationId = "aborted-attempt-retry";
    const abortedUsage = usage({ input: 300, output: 3, cacheRead: 30 });
    const firstAttempt = createAccountingAttempt();
    await runAccountingInvocation({
      operationId,
      streamFn: createAbortedStreamFn(abortedUsage),
      attempt: firstAttempt,
    });

    const winningAttempt = createAccountingAttempt();
    const result = await runAccountingInvocation({
      operationId,
      streamFn: createTextStreamFn("must not run", usage({ input: 1, output: 1 })),
      attempt: winningAttempt,
      previousEmissions: toPreviousEmissions(withoutOperationCompletion(firstAttempt.emitted)),
    });
    const hooks = winningAttempt.commit();

    assert(result.outcome === "aborted");
    expect(hooks).toEqual([
      {
        name: "onOperationCompleted",
        payload: expect.objectContaining({
          modelCalls: [expect.objectContaining({ stopReason: "aborted", usage: abortedUsage })],
          usage: abortedUsage,
        }),
      },
    ]);
  });

  test("accounts every model call when recovering a completed tool loop", async () => {
    const operationId = "recovered-tool-loop";
    const toolUsage = usage({ input: 100, output: 15, cacheRead: 20, cacheWrite: 5 });
    const textUsage = usage({ input: 125, output: 25, cacheRead: 30 });
    const toolExecute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "looked up" }],
      details: { ok: true },
    }));
    const lookupTool: AgentTool = {
      name: "lookup",
      label: "Lookup",
      description: "Lookup test data.",
      parameters: Type.Object({}),
      execute: toolExecute,
    };
    const streamFn = vi.fn(
      createAlternatingToolThenTextStreamFn({
        toolCall: { type: "toolCall", id: "call-lookup", name: "lookup", arguments: {} },
        text: "lookup complete",
        toolUsage,
        textUsage,
      }),
    );
    const firstAttempt = createAccountingAttempt();
    await runAccountingInvocation({
      operationId,
      streamFn,
      tools: [lookupTool],
      attempt: firstAttempt,
    });

    const recoveredAttempt = createAccountingAttempt();
    await runAccountingInvocation({
      operationId,
      streamFn,
      tools: [lookupTool],
      attempt: recoveredAttempt,
      previousEmissions: toPreviousEmissions(firstAttempt.emitted),
    });
    const hooks = recoveredAttempt.commit();

    expect(streamFn).toHaveBeenCalledTimes(2);
    expect(toolExecute).toHaveBeenCalledTimes(1);
    expect(hooks).toEqual([
      {
        name: "onOperationCompleted",
        payload: expect.objectContaining({
          modelCalls: [
            expect.objectContaining({ stopReason: "toolUse", usage: toolUsage }),
            expect.objectContaining({ stopReason: "stop", usage: textUsage }),
          ],
          usage: {
            input: 225,
            output: 40,
            cacheRead: 50,
            cacheWrite: 5,
            totalTokens: 320,
            cost: {
              input: 2.25,
              output: 0.4,
              cacheRead: 0.5,
              cacheWrite: 0.05,
              total: 3.2,
            },
          },
        }),
      },
    ]);
  });

  test("accounts a provider failure when recovery checkpoints the interruption", async () => {
    const operationId = "failed-attempt-winner";
    const historicalUsage = usage({ input: 900, output: 90, cacheRead: 45 });
    const failedUsage = usage({ input: 500, output: 10, cacheRead: 50 });
    const historicalAssistant = createAssistantMessage("historical response", historicalUsage);
    historicalAssistant.timestamp = new Date("2026-07-01T11:59:00.000Z").getTime();
    const initialMessages: AgentMessage[] = [
      {
        role: "user",
        content: "historical prompt",
        timestamp: new Date("2026-07-01T11:58:00.000Z").getTime(),
      },
      historicalAssistant,
    ];
    const firstAttempt = createAccountingAttempt();

    await expect(
      runAccountingInvocation({
        operationId,
        streamFn: createErrorStreamFn("provider down", failedUsage),
        initialMessages,
        attempt: firstAttempt,
      }),
    ).rejects.toThrow("Pi harness agent stream failed: provider down");
    expect(firstAttempt.emitted).not.toContainEqual(
      expect.objectContaining({ kind: "harness-operation-complete" }),
    );

    const winningAttempt = createAccountingAttempt();
    const result = await runAccountingInvocation({
      operationId,
      streamFn: createTextStreamFn("must not run", usage({ input: 1, output: 1 })),
      initialMessages,
      attempt: winningAttempt,
      previousEmissions: toPreviousEmissions(firstAttempt.emitted),
    });
    const hooks = winningAttempt.commit();

    expect(result).toMatchObject({ outcome: "aborted" });
    expect(result).not.toHaveProperty("value");
    expect(hooks).toEqual([
      {
        name: "onOperationCompleted",
        payload: expect.objectContaining({
          modelCalls: [expect.objectContaining({ stopReason: "error", usage: failedUsage })],
          usage: failedUsage,
        }),
      },
    ]);
  });

  test("replays an explicitly checkpointed provider failure without calling the provider again", async () => {
    const operationId = "checkpointed-provider-failure";
    const failedUsage = usage({ input: 500, output: 10, cacheRead: 50 });
    const firstStreamFn = vi.fn(createErrorStreamFn("provider down", failedUsage));
    const firstAttempt = createAccountingAttempt();

    const firstResult = await runAccountingInvocation({
      operationId,
      streamFn: firstStreamFn,
      attempt: firstAttempt,
      checkpointTerminalAssistantError: true,
    });
    assert(firstResult.outcome === "completed");
    expect(firstResult.value).toMatchObject({
      stopReason: "error",
      errorMessage: "provider down",
    });
    expect(firstAttempt.emitted).toContainEqual(
      expect.objectContaining({ kind: "harness-operation-complete" }),
    );

    const replayStreamFn = vi.fn(
      createTextStreamFn("must not run", usage({ input: 1, output: 1 })),
    );
    const replayAttempt = createAccountingAttempt();
    const replayResult = await runAccountingInvocation({
      operationId,
      streamFn: replayStreamFn,
      attempt: replayAttempt,
      previousEmissions: toPreviousEmissions(firstAttempt.emitted),
      checkpointTerminalAssistantError: true,
    });
    const hooks = replayAttempt.commit();

    expect(firstStreamFn).toHaveBeenCalledTimes(1);
    expect(replayStreamFn).not.toHaveBeenCalled();
    expect(replayResult).toEqual(firstResult);
    expect(hooks).toEqual([
      {
        name: "onOperationCompleted",
        payload: expect.objectContaining({
          modelCalls: [expect.objectContaining({ stopReason: "error", usage: failedUsage })],
          usage: failedUsage,
        }),
      },
    ]);
  });

  test("does not repeat physical tool work when aborting before a durable completion", async () => {
    const operationId = "tool-side-effect-replay";
    const zeroUsage = usage({ input: 0, output: 0 });
    const toolExecute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "charged" }],
      details: { ok: true },
    }));
    const chargeTool: AgentTool = {
      name: "chargeCard",
      label: "Charge card",
      description: "Charge a test card.",
      parameters: Type.Object({}),
      execute: toolExecute,
    };
    const streamFn = vi.fn(
      createAlternatingToolThenTextStreamFn({
        toolCall: { type: "toolCall", id: "call-charge", name: "chargeCard", arguments: {} },
        text: "charged complete",
        toolUsage: zeroUsage,
        textUsage: zeroUsage,
      }),
    );
    const firstAttempt = createAccountingAttempt();
    await runAccountingInvocation({
      operationId,
      streamFn,
      tools: [chargeTool],
      attempt: firstAttempt,
    });
    assert(streamFn.mock.calls.length === 2);
    expect(toolExecute).toHaveBeenCalledTimes(1);

    const retryAttempt = createAccountingAttempt();
    const result = await runAccountingInvocation({
      operationId,
      streamFn,
      tools: [chargeTool],
      attempt: retryAttempt,
      previousEmissions: toPreviousEmissions(emissionsThroughFirstToolResult(firstAttempt.emitted)),
    });

    expect(streamFn).toHaveBeenCalledTimes(2);
    expect(toolExecute).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ outcome: "aborted" });
    expect(result).not.toHaveProperty("value");
    expect(activeMessageRoles(result.appendedEntries, result.leafId)).toEqual([
      "user",
      "assistant",
      "toolResult",
    ]);
  });
});
