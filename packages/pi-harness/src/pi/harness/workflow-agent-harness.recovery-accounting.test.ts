import { assert, describe, expect, test, vi } from "vitest";

import type { WorkflowStepEmission, WorkflowStepTx } from "@fragno-dev/workflows/workflow";
import { Type } from "typebox";

import type { HandlerTxContext } from "@fragno-dev/db";

import { AgentHarness, type AgentTool, type SessionTreeEntry } from "@earendil-works/pi-agent-core";
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
    session: restored.session,
    storage: restored.storage,
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

  test("uses model calls from the same epoch as the canonical completion", async () => {
    const operationId = "canonical-completion-epoch";
    const firstUsage = usage({ input: 100, output: 10 });
    const secondUsage = usage({ input: 200, output: 20, cacheRead: 5 });
    const firstAttempt = createAccountingAttempt();
    await runAccountingInvocation({
      operationId,
      streamFn: createTextStreamFn("first completion", firstUsage),
      attempt: firstAttempt,
    });
    const secondAttempt = createAccountingAttempt();
    await runAccountingInvocation({
      operationId,
      streamFn: createTextStreamFn("second completion", secondUsage),
      attempt: secondAttempt,
    });
    const combinedEmissions = [
      ...toPreviousEmissions(firstAttempt.emitted, "first-epoch"),
      ...toPreviousEmissions(secondAttempt.emitted, "second-epoch"),
    ];
    const recoveredAttempt = createAccountingAttempt();
    const provider = vi.fn(createTextStreamFn("must not run", usage({ input: 999, output: 999 })));

    const result = await runAccountingInvocation({
      operationId,
      streamFn: provider,
      attempt: recoveredAttempt,
      previousEmissions: combinedEmissions,
    });
    const hooks = recoveredAttempt.commit();

    expect(provider).not.toHaveBeenCalled();
    expect(result.value).toMatchObject({ content: [{ type: "text", text: "second completion" }] });
    expect(hooks).toEqual([
      {
        name: "onOperationCompleted",
        payload: expect.objectContaining({
          modelCalls: [expect.objectContaining({ usage: secondUsage })],
          usage: secondUsage,
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
    expect(result.value).toMatchObject({ stopReason: "aborted", usage: abortedUsage });
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

  test("excludes an uncommitted aborted attempt when a later retry wins", async () => {
    const operationId = "aborted-attempt-retry";
    const abortedUsage = usage({ input: 300, output: 3, cacheRead: 30 });
    const successfulUsage = usage({ input: 45, output: 9, cacheRead: 6 });
    const firstAttempt = createAccountingAttempt();
    await runAccountingInvocation({
      operationId,
      streamFn: createAbortedStreamFn(abortedUsage),
      attempt: firstAttempt,
    });

    const winningAttempt = createAccountingAttempt();
    await runAccountingInvocation({
      operationId,
      streamFn: createTextStreamFn("retry complete", successfulUsage),
      attempt: winningAttempt,
      previousEmissions: toPreviousEmissions(withoutOperationCompletion(firstAttempt.emitted)),
    });
    const hooks = winningAttempt.commit();

    expect(hooks).toEqual([
      {
        name: "onOperationCompleted",
        payload: expect.objectContaining({
          modelCalls: [expect.objectContaining({ stopReason: "stop", usage: successfulUsage })],
          usage: successfulUsage,
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

  test("accounts only the winning call after a provider failure fails the default workflow step", async () => {
    const operationId = "failed-attempt-winner";
    const failedUsage = usage({ input: 500, output: 10, cacheRead: 50 });
    const successfulUsage = usage({ input: 60, output: 15, cacheRead: 5 });
    const firstAttempt = createAccountingAttempt();

    await expect(
      runAccountingInvocation({
        operationId,
        streamFn: createErrorStreamFn("provider down", failedUsage),
        attempt: firstAttempt,
      }),
    ).rejects.toThrow("Pi harness agent stream failed: provider down");
    expect(firstAttempt.emitted).not.toContainEqual(
      expect.objectContaining({ kind: "harness-operation-complete" }),
    );

    const winningAttempt = createAccountingAttempt();
    const result = await runAccountingInvocation({
      operationId,
      streamFn: createTextStreamFn("recovered", successfulUsage),
      attempt: winningAttempt,
      previousEmissions: toPreviousEmissions(firstAttempt.emitted),
    });
    const hooks = winningAttempt.commit();

    expect(result.value).toMatchObject({ content: [{ type: "text", text: "recovered" }] });
    expect(hooks).toEqual([
      {
        name: "onOperationCompleted",
        payload: expect.objectContaining({
          modelCalls: [expect.objectContaining({ stopReason: "stop", usage: successfulUsage })],
          usage: successfulUsage,
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

  test("repeats physical tool work when retrying before a durable completion", async () => {
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

    expect(streamFn).toHaveBeenCalledTimes(4);
    expect(toolExecute).toHaveBeenCalledTimes(2);
    expect(result.value).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "charged complete" }],
    });
    expect(activeMessageRoles(result.appendedEntries, result.leafId)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
    ]);
  });
});
