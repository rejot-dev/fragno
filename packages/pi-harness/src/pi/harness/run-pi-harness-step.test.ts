import { assert, describe, expect, it, vi } from "vitest";

import type {
  WorkflowStep,
  WorkflowStepEmission,
  WorkflowStepTx,
} from "@fragno-dev/workflows/workflow";
import { Type } from "typebox";

import type { AgentMessage, AgentTool, SessionTreeEntry } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Model,
  type ToolCall,
} from "@earendil-works/pi-ai";

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

const createTextStreamFn = (text: string) => () => {
  const stream = createAssistantMessageEventStream();
  const message = createAssistantMessage(text);

  stream.push({ type: "start", partial: message });
  stream.push({ type: "text_start", contentIndex: 0, partial: message });
  stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
  stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
  stream.push({ type: "done", reason: "stop", message });

  return stream;
};

const createToolCallStreamFn = (toolCall: ToolCall) => () => {
  const stream = createAssistantMessageEventStream();
  const message = createAssistantMessage("");
  message.content = [toolCall];
  message.stopReason = "toolUse";

  stream.push({ type: "start", partial: message });
  stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
  stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
  stream.push({ type: "done", reason: "toolUse", message });

  return stream;
};

const createAlternatingToolThenTextStreamFn = (options: { toolCall: ToolCall; text: string }) => {
  let callCount = 0;

  return () => {
    callCount += 1;
    if (callCount % 2 === 1) {
      return createToolCallStreamFn(options.toolCall)();
    }

    return createTextStreamFn(options.text)();
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

type FakeStep = {
  step: WorkflowStep;
  emitted: unknown[];
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
  const emitted: unknown[] = [];
  const mutations: unknown[] = [];
  const tx = {
    serviceCalls: () => undefined,
    workflowServiceCalls: () => undefined,
    mutate: (fn: unknown) => mutations.push(fn),
    emit: (payload: unknown) => emitted.push(payload),
    previousEmissions: async () => [...(options.previousEmissions ?? [])],
    onTerminalError: { mutate: () => undefined },
    onEvent: () => () => undefined,
  } as unknown as WorkflowStepTx;
  const step = {
    do: async (_name: string, ...args: unknown[]) => {
      const callback = args.at(-1) as (tx: WorkflowStepTx) => Promise<unknown>;
      const result = await callback(tx);
      if (options.failAfterCallback) {
        throw new Error("simulated crash after operation completion");
      }
      return result;
    },
  } as WorkflowStep;

  return { step, emitted, mutationCount: () => mutations.length };
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
    });
    const nextState = { entries: result.entries, leafId: result.leafId };

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
});

describe("runPiHarnessStep durable retry hardening", () => {
  it("replays a completed operation journal without running the provider again", async () => {
    const streamFn = vi.fn(createTextStreamFn("replayed assistant"));
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

    expect(streamFn).toHaveBeenCalledTimes(1);
    expect(firstAttempt.emitted).toContainEqual(
      expect.objectContaining({ kind: "harness-operation-complete" }),
    );

    const secondAttempt = createFakeStep({
      previousEmissions: toPreviousEmissions(firstAttempt.emitted),
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
      content: [{ type: "text", text: "replayed assistant" }],
    });
    expect(result.appendedEntries).toHaveLength(2);
    assert(secondAttempt.mutationCount() === 0);
    expect(secondAttempt.emitted).toEqual([]);
  });

  it("recovers an assistant entry emitted before operation completion without running the provider again", async () => {
    const streamFn = vi.fn(createTextStreamFn("recovered from assistant entry"));
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
      activeMessageEntries(result.entries, result.leafId).flatMap((entry) =>
        entry.type === "message" ? [entry.message.role] : [],
      ),
    ).toEqual(["user", "assistant", "toolResult", "assistant"]);
  });

  it("fails provider errors and retries without replaying the error assistant", async () => {
    const failingStreamFn = vi.fn(async () => {
      throw new Error("provider down");
    });
    const failingAgent: PiHarnessAgentOptions = {
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
        ...failingAgent,
        operation: { kind: "prompt", args: ["hello"] },
      }),
    ).rejects.toThrow("Pi harness agent stream failed: provider down");

    expect(firstAttempt.emitted).not.toContainEqual(
      expect.objectContaining({ kind: "harness-operation-complete" }),
    );

    const successfulStreamFn = vi.fn(createTextStreamFn("recovered"));
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
    expect(activeMessageEntries(result.entries, result.leafId)).toMatchObject([
      { type: "message", message: { role: "user" } },
      { type: "message", message: { role: "assistant" } },
    ]);
  });
});
