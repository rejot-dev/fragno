import { assert, describe, expect, it, vi } from "vitest";

import type {
  WorkflowStep,
  WorkflowStepEmission,
  WorkflowStepTx,
} from "@fragno-dev/workflows/workflow";
import { Type } from "typebox";

import type { HandlerTxContext } from "@fragno-dev/db";

import type { AgentMessage, AgentTool, SessionTreeEntry } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Model,
  type ToolCall,
} from "@earendil-works/pi-ai";

import type { PiHarnessHooksMap } from "../definition";
import type { PiOperationCompletedHookPayload } from "../types";
import { projectPiWorkflowSession } from "../workflow-session-projection";
import { NoOpExecutionEnv } from "./execution-env";
import {
  createPiHarnessSessionState,
  runPiHarnessStep,
  type PiHarnessAgentOptions,
} from "./run-pi-harness-step";

const createEnv = () => new NoOpExecutionEnv();

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

const createTextStreamFn = (text: string, usage?: AssistantMessage["usage"]) => () => {
  const stream = createAssistantMessageEventStream();
  const message = createAssistantMessage(text);
  if (usage) {
    message.usage = structuredClone(usage);
  }

  stream.push({ type: "start", partial: message });
  stream.push({ type: "text_start", contentIndex: 0, partial: message });
  stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
  stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
  stream.push({ type: "done", reason: "stop", message });

  return stream;
};

const createAbortedStreamFn = (usage: AssistantMessage["usage"]) => () => {
  const stream = createAssistantMessageEventStream();
  const message = createAssistantMessage("");
  message.stopReason = "aborted";
  message.errorMessage = "Request was aborted";
  message.usage = structuredClone(usage);
  stream.push({ type: "error", reason: "aborted", error: message });
  return stream;
};

const createErrorStreamFn = (errorMessage: string, usage: AssistantMessage["usage"]) => () => {
  const stream = createAssistantMessageEventStream();
  const message = createAssistantMessage("");
  message.stopReason = "error";
  message.errorMessage = errorMessage;
  message.usage = structuredClone(usage);
  stream.push({ type: "error", reason: "error", error: message });
  return stream;
};

const createToolCallStreamFn = (toolCall: ToolCall, usage?: AssistantMessage["usage"]) => () => {
  const stream = createAssistantMessageEventStream();
  const message = createAssistantMessage("");
  if (usage) {
    message.usage = structuredClone(usage);
  }
  message.content = [toolCall];
  message.stopReason = "toolUse";

  stream.push({ type: "start", partial: message });
  stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
  stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
  stream.push({ type: "done", reason: "toolUse", message });

  return stream;
};

const createAlternatingToolThenTextStreamFn = (options: {
  toolCall: ToolCall;
  text: string;
  toolUsage?: AssistantMessage["usage"];
  textUsage?: AssistantMessage["usage"];
}) => {
  let callCount = 0;

  return () => {
    callCount += 1;
    if (callCount % 2 === 1) {
      return createToolCallStreamFn(options.toolCall, options.toolUsage)();
    }

    return createTextStreamFn(options.text, options.textUsage)();
  };
};

const activeMessageEntries = (
  entries: readonly SessionTreeEntry[],
  leafId: string | null,
): SessionTreeEntry[] => {
  if (!leafId) {
    return [];
  }

  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const path: SessionTreeEntry[] = [];
  let current = byId.get(leafId);
  while (current) {
    path.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }

  return path.filter((entry) => entry.type === "message");
};

type TriggeredOperationCompletedHook = {
  name: "onOperationCompleted";
  payload: PiOperationCompletedHookPayload;
};

type FakeStep = {
  step: WorkflowStep<PiHarnessHooksMap>;
  emitted: unknown[];
  triggeredHooks: TriggeredOperationCompletedHook[];
  mutationCount: () => number;
};

const toPreviousEmissions = (payloads: readonly unknown[]): WorkflowStepEmission[] =>
  payloads.map((payload, sequence) => ({
    id: `emission-${sequence}`,
    actor: "user",
    stepKey: "do:turn-0",
    epoch: "previous-attempt",
    sequence,
    payload,
    createdAt: new Date(),
  }));

const sessionEntryIdsFromEmissions = (emissions: readonly unknown[]): string[] =>
  emissions.flatMap((emission) => {
    if (
      typeof emission !== "object" ||
      emission === null ||
      !("kind" in emission) ||
      emission.kind !== "harness-session-entry" ||
      !("entry" in emission) ||
      typeof emission.entry !== "object" ||
      emission.entry === null ||
      !("id" in emission.entry) ||
      typeof emission.entry.id !== "string"
    ) {
      return [];
    }

    return [emission.entry.id];
  });

const withoutOperationCompleteEmissions = (emissions: readonly unknown[]): unknown[] =>
  emissions.filter(
    (emission) =>
      typeof emission !== "object" ||
      emission === null ||
      !("kind" in emission) ||
      emission.kind !== "harness-operation-complete",
  );

const emissionsThroughFirstToolResultEntry = (emissions: readonly unknown[]): unknown[] => {
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
      emission.entry.message.role === "toolResult"
    ) {
      return partial;
    }
  }

  return partial;
};

const createFakeStep = (options: {
  previousEmissions?: readonly WorkflowStepEmission[];
  failAfterCallback?: boolean;
}): FakeStep => {
  type Mutation = (context: HandlerTxContext<PiHarnessHooksMap>) => void;

  const emitted: unknown[] = [];
  const mutations: Mutation[] = [];
  const terminalErrorMutations: Mutation[] = [];
  const triggeredHooks: TriggeredOperationCompletedHook[] = [];
  const mutationContext = {
    idempotencyKey: "fake-step-attempt",
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
    mutate: (fn: Mutation) => mutations.push(fn),
    emit: (payload: unknown) => emitted.push(payload),
    previousEmissions: async () => [...(options.previousEmissions ?? [])],
    onTerminalError: { mutate: (fn: Mutation) => terminalErrorMutations.push(fn) },
    onEvent: () => () => undefined,
  } as WorkflowStepTx<PiHarnessHooksMap>;
  const step = {
    do: async (_name: string, ...args: unknown[]) => {
      const callback = args.at(-1) as (tx: WorkflowStepTx<PiHarnessHooksMap>) => Promise<unknown>;
      try {
        const result = await callback(tx);
        if (options.failAfterCallback) {
          throw new Error("simulated crash after operation completion");
        }
        for (const mutation of mutations) {
          mutation(mutationContext);
        }
        return result;
      } catch (error) {
        if (!options.failAfterCallback) {
          for (const mutation of terminalErrorMutations) {
            mutation(mutationContext);
          }
        }
        throw error;
      }
    },
  } as WorkflowStep<PiHarnessHooksMap>;

  return {
    step,
    emitted,
    triggeredHooks,
    mutationCount: () => mutations.length + terminalErrorMutations.length,
  };
};

describe("runPiHarnessStep", () => {
  it("threads committed entries through the low-level harness step", async () => {
    const streamFn = vi.fn(createTextStreamFn("stateful assistant"));
    const agent: PiHarnessAgentOptions = {
      env: createEnv(),
      systemPrompt: "You are helpful.",
      model: mockModel,
      streamFn,
    };
    const initialMessage: AgentMessage = {
      role: "user",
      content: "existing context",
      timestamp: Date.now(),
    };
    const state = createPiHarnessSessionState([initialMessage]);
    const fakeStep = createFakeStep({});

    const result = await runPiHarnessStep(fakeStep.step, "turn-1", {
      workflowName: "session-step-workflow",
      sessionId: "session-1",
      agentName: "default",
      ...agent,
      operation: { kind: "prompt", args: ["next prompt"] },
      committedEntries: state.entries,
      persistedEntryIds: state.entries.map((entry) => entry.id),
    });
    const nextState = {
      entries: [...state.entries, ...result.appendedEntries],
      leafId: result.leafId,
    };

    expect(result).not.toHaveProperty("entries");
    expect(result.appendedEntries).toHaveLength(2);
    expect(result.assistantMessage).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "stateful assistant" }],
    });
    expect(fakeStep.emitted).toContainEqual(
      expect.objectContaining({
        kind: "harness-operation-start",
        replay: { protocol: "pi-harness-operation", version: 1 },
      }),
    );
    assert(nextState.entries.length === 3);
    expect(nextState.entries[0]).toMatchObject({ id: "initial-0", message: initialMessage });
    assert(nextState.leafId === nextState.entries.at(-1)?.id);
  });

  it("preserves initial session messages in the completed workflow projection", async () => {
    const initialMessage: AgentMessage = {
      role: "user",
      content: "existing context",
      timestamp: Date.now(),
    };
    const state = createPiHarnessSessionState([initialMessage]);
    const result = await runPiHarnessStep(createFakeStep({}).step, "turn-1", {
      workflowName: "session-step-workflow",
      sessionId: "session-with-initial-context",
      agentName: "default",
      env: createEnv(),
      systemPrompt: "You are helpful.",
      model: mockModel,
      streamFn: createTextStreamFn("stateful assistant"),
      operation: { kind: "prompt", args: ["next prompt"] },
      committedEntries: state.entries,
    });

    const projection = projectPiWorkflowSession({
      workflowName: "session-step-workflow",
      sessionId: "session-with-initial-context",
      instance: { status: "active" },
      workflowSteps: [
        {
          stepKey: "do:turn-1",
          type: "do",
          status: "completed",
          waitEventType: null,
          result,
        },
      ],
    });

    expect(projection.state.messages).toHaveLength(3);
    expect(projection.state.messages[0]).toEqual(initialMessage);
  });
});

describe("runPiHarnessStep durable retry hardening", () => {
  it("records a recovered completed operation journal without running the provider again", async () => {
    const usage = {
      input: 80,
      output: 20,
      cacheRead: 10,
      cacheWrite: 5,
      totalTokens: 115,
      cost: { input: 0.8, output: 0.2, cacheRead: 0.1, cacheWrite: 0.05, total: 1.15 },
    };
    const actor = { type: "account", id: "account-replay" };
    const previousAssistantMessage = createAssistantMessage("previous assistant");
    previousAssistantMessage.usage = {
      input: 999,
      output: 999,
      cacheRead: 999,
      cacheWrite: 999,
      totalTokens: 3996,
      cost: { input: 9, output: 9, cacheRead: 9, cacheWrite: 9, total: 36 },
    };
    const previousState = createPiHarnessSessionState([previousAssistantMessage]);
    const streamFn = vi.fn(createTextStreamFn("replayed assistant", usage));
    const agent: PiHarnessAgentOptions = {
      env: createEnv(),
      systemPrompt: "You are helpful.",
      model: mockModel,
      streamFn,
    };

    const firstAttempt = createFakeStep({ failAfterCallback: true });
    await expect(
      runPiHarnessStep(firstAttempt.step, "turn-0", {
        workflowName: "retry-workflow",
        sessionId: "session-1",
        agentName: "default",
        actor,
        ...agent,
        operation: { kind: "prompt", args: ["hello"] },
        committedEntries: previousState.entries,
        persistedEntryIds: previousState.entries.map((entry) => entry.id),
      }),
    ).rejects.toThrow("simulated crash");

    expect(streamFn).toHaveBeenCalledTimes(1);
    expect(firstAttempt.emitted).toContainEqual(
      expect.objectContaining({ kind: "harness-operation-complete" }),
    );
    expect(firstAttempt.triggeredHooks).toEqual([]);

    const secondAttempt = createFakeStep({
      previousEmissions: toPreviousEmissions(firstAttempt.emitted),
    });
    const result = await runPiHarnessStep(secondAttempt.step, "turn-0", {
      workflowName: "retry-workflow",
      sessionId: "session-1",
      agentName: "default",
      actor,
      ...agent,
      operation: { kind: "prompt", args: ["hello"] },
      committedEntries: previousState.entries,
      persistedEntryIds: previousState.entries.map((entry) => entry.id),
    });

    expect(streamFn).toHaveBeenCalledTimes(1);
    expect(result.assistantMessage).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "replayed assistant" }],
    });
    expect(result.appendedEntries).toHaveLength(2);
    expect(secondAttempt.triggeredHooks).toEqual([
      {
        name: "onOperationCompleted",
        payload: expect.objectContaining({
          actor,
          workflowName: "retry-workflow",
          sessionId: "session-1",
          agentName: "default",
          stepName: "turn-0",
          operationId: "retry-workflow:session-1:turn-0",
          operation: "prompt",
          modelCalls: [expect.objectContaining({ stopReason: "stop", usage })],
          usage,
        }),
      },
    ]);
    assert(secondAttempt.mutationCount() === 1);
    expect(secondAttempt.emitted).toEqual([]);
  });

  it("uses model calls from the same epoch as the recovered completion", async () => {
    const firstUsage = {
      input: 100,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 110,
      cost: { input: 1, output: 0.1, cacheRead: 0, cacheWrite: 0, total: 1.1 },
    };
    const secondUsage = {
      input: 200,
      output: 20,
      cacheRead: 5,
      cacheWrite: 0,
      totalTokens: 225,
      cost: { input: 2, output: 0.2, cacheRead: 0.05, cacheWrite: 0, total: 2.25 },
    };
    const firstMessage = createAssistantMessage("first attempt");
    firstMessage.usage = structuredClone(firstUsage);
    const secondMessage = createAssistantMessage("second attempt");
    secondMessage.usage = structuredClone(secondUsage);
    const firstEntry: SessionTreeEntry = {
      type: "message",
      id: "first-assistant",
      parentId: null,
      timestamp: new Date(firstMessage.timestamp).toISOString(),
      message: firstMessage,
    };
    const secondEntry: SessionTreeEntry = {
      type: "message",
      id: "second-assistant",
      parentId: null,
      timestamp: new Date(secondMessage.timestamp).toISOString(),
      message: secondMessage,
    };
    const operationId = "retry-workflow:session-multiple-epochs:turn-epochs";
    const journalEmission = (
      epoch: string,
      sequence: number,
      payload: unknown,
    ): WorkflowStepEmission => ({
      id: `${epoch}-${sequence}`,
      actor: "user",
      stepKey: "do:turn-epochs",
      epoch,
      sequence,
      payload,
      createdAt: new Date(),
    });
    const previousEmissions = [
      journalEmission("first-epoch", 0, {
        kind: "harness-operation-start",
        operationId,
        operation: { kind: "prompt", args: ["hello"] },
        replay: { protocol: "pi-harness-operation", version: 1 },
      }),
      journalEmission("first-epoch", 1, {
        kind: "harness-session-entry",
        entry: firstEntry,
      }),
      journalEmission("first-epoch", 2, {
        kind: "harness-operation-complete",
        operationId,
        result: {
          type: "harness-run",
          operation: "prompt",
          appendedEntries: [firstEntry],
          leafId: firstEntry.id,
          assistantMessage: firstMessage,
        },
      }),
      journalEmission("second-epoch", 0, {
        kind: "harness-operation-start",
        operationId,
        operation: { kind: "prompt", args: ["hello"] },
        replay: { protocol: "pi-harness-operation", version: 1 },
      }),
      journalEmission("second-epoch", 1, {
        kind: "harness-session-entry",
        entry: secondEntry,
      }),
      journalEmission("second-epoch", 2, {
        kind: "harness-operation-complete",
        operationId,
        result: {
          type: "harness-run",
          operation: "prompt",
          appendedEntries: [secondEntry],
          leafId: secondEntry.id,
          assistantMessage: secondMessage,
        },
      }),
    ];
    const streamFn = vi.fn(createTextStreamFn("provider should not run"));
    const recoveredAttempt = createFakeStep({ previousEmissions });

    const result = await runPiHarnessStep(recoveredAttempt.step, "turn-epochs", {
      workflowName: "retry-workflow",
      sessionId: "session-multiple-epochs",
      agentName: "default",
      env: createEnv(),
      systemPrompt: "You are helpful.",
      model: mockModel,
      streamFn,
      operation: { kind: "prompt", args: ["hello"] },
    });

    expect(streamFn).not.toHaveBeenCalled();
    expect(result.assistantMessage).toMatchObject({
      content: [{ type: "text", text: "second attempt" }],
      usage: secondUsage,
    });
    expect(recoveredAttempt.triggeredHooks).toEqual([
      {
        name: "onOperationCompleted",
        payload: expect.objectContaining({
          modelCalls: [expect.objectContaining({ usage: secondUsage })],
          usage: secondUsage,
        }),
      },
    ]);
  });

  it("records an aborted call recovered from a completed operation journal", async () => {
    const usage = {
      input: 75,
      output: 4,
      cacheRead: 25,
      cacheWrite: 0,
      totalTokens: 104,
      cost: { input: 0.75, output: 0.04, cacheRead: 0.25, cacheWrite: 0, total: 1.04 },
    };
    const streamFn = vi.fn(createAbortedStreamFn(usage));
    const agent: PiHarnessAgentOptions = {
      env: createEnv(),
      systemPrompt: "You are helpful.",
      model: mockModel,
      streamFn,
    };

    const firstAttempt = createFakeStep({ failAfterCallback: true });
    await expect(
      runPiHarnessStep(firstAttempt.step, "turn-aborted", {
        workflowName: "retry-workflow",
        sessionId: "session-aborted",
        agentName: "default",
        ...agent,
        operation: { kind: "prompt", args: ["hello"] },
      }),
    ).rejects.toThrow("simulated crash");

    const secondAttempt = createFakeStep({
      previousEmissions: toPreviousEmissions(firstAttempt.emitted),
    });
    const result = await runPiHarnessStep(secondAttempt.step, "turn-aborted", {
      workflowName: "retry-workflow",
      sessionId: "session-aborted",
      agentName: "default",
      ...agent,
      operation: { kind: "prompt", args: ["hello"] },
    });

    expect(streamFn).toHaveBeenCalledTimes(1);
    expect(result.assistantMessage).toMatchObject({ stopReason: "aborted", usage });
    expect(firstAttempt.triggeredHooks).toEqual([]);
    expect(secondAttempt.triggeredHooks).toEqual([
      {
        name: "onOperationCompleted",
        payload: expect.objectContaining({
          modelCalls: [expect.objectContaining({ stopReason: "aborted", usage })],
          usage,
        }),
      },
    ]);
  });

  it("records a recovered assistant entry emitted before operation completion", async () => {
    const usage = {
      input: 40,
      output: 12,
      cacheRead: 7,
      cacheWrite: 3,
      totalTokens: 62,
      cost: { input: 0.4, output: 0.12, cacheRead: 0.07, cacheWrite: 0.03, total: 0.62 },
    };
    const streamFn = vi.fn(createTextStreamFn("recovered from assistant entry", usage));
    const agent: PiHarnessAgentOptions = {
      env: createEnv(),
      systemPrompt: "You are helpful.",
      model: mockModel,
      streamFn,
    };

    const firstAttempt = createFakeStep({ failAfterCallback: true });
    await expect(
      runPiHarnessStep(firstAttempt.step, "turn-0", {
        workflowName: "retry-workflow",
        sessionId: "session-1",
        agentName: "default",
        ...agent,
        operation: { kind: "prompt", args: ["hello"] },
      }),
    ).rejects.toThrow("simulated crash");
    expect(firstAttempt.triggeredHooks).toEqual([]);

    const secondAttempt = createFakeStep({
      previousEmissions: toPreviousEmissions(
        withoutOperationCompleteEmissions(firstAttempt.emitted),
      ),
    });
    const result = await runPiHarnessStep(secondAttempt.step, "turn-0", {
      workflowName: "retry-workflow",
      sessionId: "session-1",
      agentName: "default",
      ...agent,
      operation: { kind: "prompt", args: ["hello"] },
    });

    expect(streamFn).toHaveBeenCalledTimes(1);
    expect(result.assistantMessage).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "recovered from assistant entry" }],
    });
    expect(secondAttempt.emitted).toContainEqual(
      expect.objectContaining({ kind: "harness-operation-complete" }),
    );
    expect(secondAttempt.triggeredHooks).toEqual([
      {
        name: "onOperationCompleted",
        payload: expect.objectContaining({
          modelCalls: [expect.objectContaining({ stopReason: "stop", usage })],
          usage,
        }),
      },
    ]);
  });

  it("does not record an aborted attempt that is replayed without its completion journal", async () => {
    const abortedUsage = {
      input: 300,
      output: 3,
      cacheRead: 30,
      cacheWrite: 0,
      totalTokens: 333,
      cost: { input: 3, output: 0.03, cacheRead: 0.3, cacheWrite: 0, total: 3.33 },
    };
    const successfulUsage = {
      input: 45,
      output: 9,
      cacheRead: 6,
      cacheWrite: 0,
      totalTokens: 60,
      cost: { input: 0.45, output: 0.09, cacheRead: 0.06, cacheWrite: 0, total: 0.6 },
    };
    const abortedStreamFn = vi.fn(createAbortedStreamFn(abortedUsage));
    const firstAttempt = createFakeStep({ failAfterCallback: true });
    await expect(
      runPiHarnessStep(firstAttempt.step, "turn-aborted-retry", {
        workflowName: "retry-workflow",
        sessionId: "session-aborted-retry",
        agentName: "default",
        env: createEnv(),
        systemPrompt: "You are helpful.",
        model: mockModel,
        streamFn: abortedStreamFn,
        operation: { kind: "prompt", args: ["hello"] },
      }),
    ).rejects.toThrow("simulated crash");

    const successfulStreamFn = vi.fn(createTextStreamFn("retry complete", successfulUsage));
    const secondAttempt = createFakeStep({
      previousEmissions: toPreviousEmissions(
        withoutOperationCompleteEmissions(firstAttempt.emitted),
      ),
    });
    await runPiHarnessStep(secondAttempt.step, "turn-aborted-retry", {
      workflowName: "retry-workflow",
      sessionId: "session-aborted-retry",
      agentName: "default",
      env: createEnv(),
      systemPrompt: "You are helpful.",
      model: mockModel,
      streamFn: successfulStreamFn,
      operation: { kind: "prompt", args: ["hello"] },
    });

    expect(abortedStreamFn).toHaveBeenCalledTimes(1);
    expect(successfulStreamFn).toHaveBeenCalledTimes(1);
    expect(firstAttempt.triggeredHooks).toEqual([]);
    expect(secondAttempt.triggeredHooks).toEqual([
      {
        name: "onOperationCompleted",
        payload: expect.objectContaining({
          modelCalls: [expect.objectContaining({ stopReason: "stop", usage: successfulUsage })],
          usage: successfulUsage,
        }),
      },
    ]);
  });

  it("records every model call when recovering a completed tool loop", async () => {
    const toolUsage = {
      input: 100,
      output: 15,
      cacheRead: 20,
      cacheWrite: 5,
      totalTokens: 140,
      cost: { input: 1, output: 0.15, cacheRead: 0.2, cacheWrite: 0.05, total: 1.4 },
    };
    const textUsage = {
      input: 125,
      output: 25,
      cacheRead: 30,
      cacheWrite: 0,
      totalTokens: 180,
      cost: { input: 1.25, output: 0.25, cacheRead: 0.3, cacheWrite: 0, total: 1.8 },
    };
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
    const agent: PiHarnessAgentOptions = {
      env: createEnv(),
      systemPrompt: "You are helpful.",
      model: mockModel,
      streamFn,
      tools: [lookupTool],
    };

    const firstAttempt = createFakeStep({ failAfterCallback: true });
    await expect(
      runPiHarnessStep(firstAttempt.step, "turn-tools", {
        workflowName: "retry-workflow",
        sessionId: "session-tools",
        agentName: "default",
        ...agent,
        operation: { kind: "prompt", args: ["lookup"] },
      }),
    ).rejects.toThrow("simulated crash");

    const secondAttempt = createFakeStep({
      previousEmissions: toPreviousEmissions(
        withoutOperationCompleteEmissions(firstAttempt.emitted),
      ),
    });
    await runPiHarnessStep(secondAttempt.step, "turn-tools", {
      workflowName: "retry-workflow",
      sessionId: "session-tools",
      agentName: "default",
      ...agent,
      operation: { kind: "prompt", args: ["lookup"] },
    });

    expect(streamFn).toHaveBeenCalledTimes(2);
    expect(toolExecute).toHaveBeenCalledTimes(1);
    expect(firstAttempt.triggeredHooks).toEqual([]);
    expect(secondAttempt.triggeredHooks).toEqual([
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

  it("reruns prompt-like operations when retrying after emitted tool results", async () => {
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
      }),
    );
    const agent: PiHarnessAgentOptions = {
      env: createEnv(),
      systemPrompt: "You are helpful.",
      model: mockModel,
      streamFn,
      tools: [chargeTool],
    };

    const firstAttempt = createFakeStep({ failAfterCallback: true });
    await expect(
      runPiHarnessStep(firstAttempt.step, "turn-0", {
        workflowName: "retry-workflow",
        sessionId: "session-1",
        agentName: "default",
        ...agent,
        operation: { kind: "prompt", args: ["charge"] },
      }),
    ).rejects.toThrow("simulated crash");

    expect(streamFn).toHaveBeenCalledTimes(2);
    expect(toolExecute).toHaveBeenCalledTimes(1);

    const secondAttempt = createFakeStep({
      previousEmissions: toPreviousEmissions(
        emissionsThroughFirstToolResultEntry(firstAttempt.emitted),
      ),
    });
    const result = await runPiHarnessStep(secondAttempt.step, "turn-0", {
      workflowName: "retry-workflow",
      sessionId: "session-1",
      agentName: "default",
      ...agent,
      operation: { kind: "prompt", args: ["charge"] },
    });

    expect(streamFn).toHaveBeenCalledTimes(4);
    expect(toolExecute).toHaveBeenCalledTimes(2);
    expect(result.assistantMessage).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "charged complete" }],
    });
    expect(
      activeMessageEntries(result.appendedEntries, result.leafId).flatMap((entry) =>
        entry.type === "message" ? [entry.message.role] : [],
      ),
    ).toEqual(["user", "assistant", "toolResult", "assistant"]);
  });

  it("records only the winning call when recovering after an uncommitted provider error", async () => {
    const failedUsage = {
      input: 500,
      output: 10,
      cacheRead: 50,
      cacheWrite: 0,
      totalTokens: 560,
      cost: { input: 5, output: 0.1, cacheRead: 0.5, cacheWrite: 0, total: 5.6 },
    };
    const successfulUsage = {
      input: 60,
      output: 15,
      cacheRead: 5,
      cacheWrite: 0,
      totalTokens: 80,
      cost: { input: 0.6, output: 0.15, cacheRead: 0.05, cacheWrite: 0, total: 0.8 },
    };
    const failingStreamFn = vi.fn(createErrorStreamFn("provider down", failedUsage));
    const failingAgent: PiHarnessAgentOptions = {
      env: createEnv(),
      systemPrompt: "You are helpful.",
      model: mockModel,
      streamFn: failingStreamFn,
    };
    const firstAttempt = createFakeStep({ failAfterCallback: true });

    await expect(
      runPiHarnessStep(firstAttempt.step, "turn-0", {
        workflowName: "retry-workflow",
        sessionId: "session-1",
        agentName: "default",
        ...failingAgent,
        operation: { kind: "prompt", args: ["hello"] },
      }),
    ).rejects.toThrow("Pi harness agent stream failed: provider down");

    expect(firstAttempt.emitted).not.toContainEqual(
      expect.objectContaining({ kind: "harness-operation-complete" }),
    );
    expect(firstAttempt.triggeredHooks).toEqual([]);

    const successfulStreamFn = vi.fn(createTextStreamFn("recovered", successfulUsage));
    const successfulAgent: PiHarnessAgentOptions = {
      env: createEnv(),
      systemPrompt: "You are helpful.",
      model: mockModel,
      streamFn: successfulStreamFn,
    };
    const secondAttempt = createFakeStep({
      previousEmissions: toPreviousEmissions(firstAttempt.emitted),
    });

    const result = await runPiHarnessStep(secondAttempt.step, "turn-0", {
      workflowName: "retry-workflow",
      sessionId: "session-1",
      agentName: "default",
      ...successfulAgent,
      operation: { kind: "prompt", args: ["hello"] },
    });

    expect(failingStreamFn).toHaveBeenCalledTimes(1);
    expect(successfulStreamFn).toHaveBeenCalledTimes(1);
    expect(result.assistantMessage).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "recovered" }],
    });
    expect(secondAttempt.triggeredHooks).toEqual([
      {
        name: "onOperationCompleted",
        payload: expect.objectContaining({
          modelCalls: [expect.objectContaining({ stopReason: "stop", usage: successfulUsage })],
          usage: successfulUsage,
        }),
      },
    ]);
  });

  it("does not reuse entry ids from rolled-back failed attempts", async () => {
    const failingStreamFn = vi.fn(async () => {
      throw new Error("provider down");
    });
    const agent: PiHarnessAgentOptions = {
      env: createEnv(),
      systemPrompt: "You are helpful.",
      model: mockModel,
      streamFn: failingStreamFn,
    };

    const firstAttempt = createFakeStep({});
    await expect(
      runPiHarnessStep(firstAttempt.step, "turn-0", {
        workflowName: "retry-workflow",
        sessionId: "session-1",
        agentName: "default",
        ...agent,
        operation: { kind: "prompt", args: ["hello"] },
      }),
    ).rejects.toThrow("Pi harness agent stream failed: provider down");

    const secondAttempt = createFakeStep({
      previousEmissions: toPreviousEmissions(firstAttempt.emitted),
    });
    await expect(
      runPiHarnessStep(secondAttempt.step, "turn-0", {
        workflowName: "retry-workflow",
        sessionId: "session-1",
        agentName: "default",
        ...agent,
        operation: { kind: "prompt", args: ["hello"] },
      }),
    ).rejects.toThrow("Pi harness agent stream failed: provider down");

    const firstAttemptIds = new Set(sessionEntryIdsFromEmissions(firstAttempt.emitted));
    const reusedIds = sessionEntryIdsFromEmissions(secondAttempt.emitted).filter((id) =>
      firstAttemptIds.has(id),
    );

    expect(reusedIds).toEqual([]);
  });

  it("replays a partial prompt attempt without duplicate active prompt entries", async () => {
    const streamFn = vi.fn(createTextStreamFn("partial"));
    const agent: PiHarnessAgentOptions = {
      env: createEnv(),
      systemPrompt: "You are helpful.",
      model: mockModel,
      streamFn,
    };
    const partialEntryEmission = {
      kind: "harness-session-entry",
      entry: {
        type: "message",
        id: "entry-1",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: "hello", timestamp: Date.now() },
      },
    };
    const step = createFakeStep({ previousEmissions: toPreviousEmissions([partialEntryEmission]) });

    const result = await runPiHarnessStep(step.step, "turn-0", {
      workflowName: "retry-workflow",
      sessionId: "session-1",
      agentName: "default",
      ...agent,
      operation: { kind: "prompt", args: ["hello"] },
    });

    expect(streamFn).toHaveBeenCalledTimes(1);
    expect(activeMessageEntries(result.appendedEntries, result.leafId)).toMatchObject([
      { type: "message", message: { role: "user" } },
      { type: "message", message: { role: "assistant" } },
    ]);
  });
});
