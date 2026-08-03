import { assert, describe, expect, test } from "vitest";

import { Type } from "typebox";

import { AgentHarness, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Model,
  type ToolCall,
} from "@earendil-works/pi-ai";

import { createModelsForStreamFn } from "../harness/test-models";
import {
  applyWorkflowAgentHarnessStepResult,
  createPiHarnessSessionState,
  restoreWorkflowBackedSession,
  withWorkflowAgentHarness,
  type PiHarnessEmission,
  type PiHarnessSessionStepState,
  type WorkflowAgentHarnessStepResult,
} from "./workflow-agent-harness";

const workflowName = "workflow-agent-harness-result-size";
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

const createAssistantMessage = (content: AssistantMessage["content"]): AssistantMessage => ({
  role: "assistant",
  content,
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
  stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
  timestamp: Date.now(),
});

const textStream = (text: string) => {
  const stream = createAssistantMessageEventStream();
  const message = createAssistantMessage([{ type: "text", text }]);
  stream.push({ type: "start", partial: message });
  stream.push({ type: "text_start", contentIndex: 0, partial: message });
  stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
  stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
  stream.push({ type: "done", reason: "stop", message });
  stream.end();
  return stream;
};

const toolCallStream = (toolCall: ToolCall) => {
  const stream = createAssistantMessageEventStream();
  const message = createAssistantMessage([toolCall]);
  stream.push({ type: "start", partial: message });
  stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
  stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
  stream.push({ type: "done", reason: "toolUse", message });
  stream.end();
  return stream;
};

type ScriptedResponse = { type: "text"; text: string } | { type: "toolCall"; toolCall: ToolCall };

const createScriptedStreamFn = (responses: readonly ScriptedResponse[]): StreamFn => {
  let nextResponse = 0;
  return () => {
    const response = responses[nextResponse++];
    if (!response) {
      throw new Error("TEST_STREAM_RESPONSE_EXHAUSTED");
    }
    return response.type === "text" ? textStream(response.text) : toolCallStream(response.toolCall);
  };
};

const serializedByteSize = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value), "utf8");

const createEmissionRecorder = () => {
  const emitted: PiHarnessEmission<WorkflowAgentHarnessStepResult<AssistantMessage>>[] = [];
  return {
    emitted,
    tx: {
      emit: (payload: unknown) =>
        emitted.push(
          payload as PiHarnessEmission<WorkflowAgentHarnessStepResult<AssistantMessage>>,
        ),
      onEvent: () => () => undefined,
    },
  };
};

type StepResultSize = {
  step: number;
  sessionEntryCount: number;
  appendedEntryCount: number;
  resultBytes: number;
  appendedEntriesBytes: number;
  assistantMessageBytes: number;
  operationCompleteEmissionBytes: number;
};

type TraceSizeBaseline = {
  resultBytes: number;
  operationCompleteEmissionBytes: number;
};

const measureStepResult = (
  step: number,
  state: PiHarnessSessionStepState,
  result: WorkflowAgentHarnessStepResult<AssistantMessage>,
  emissions: readonly PiHarnessEmission<WorkflowAgentHarnessStepResult<AssistantMessage>>[],
): StepResultSize => {
  const operationComplete = emissions.find(
    (emission) => emission.kind === "harness-operation-complete",
  );
  assert(operationComplete?.kind === "harness-operation-complete");

  return {
    step,
    sessionEntryCount: state.entries.length,
    appendedEntryCount: result.appendedEntries.length,
    resultBytes: serializedByteSize(result),
    appendedEntriesBytes: serializedByteSize(result.appendedEntries),
    assistantMessageBytes: serializedByteSize(result.value),
    operationCompleteEmissionBytes: serializedByteSize(operationComplete),
  };
};

const runPromptTrace = async (options: {
  sessionId: string;
  prompts: readonly string[];
  streamFn: StreamFn;
  tools?: readonly AgentTool[];
}): Promise<{
  results: WorkflowAgentHarnessStepResult<AssistantMessage>[];
  sizes: StepResultSize[];
}> => {
  const models = createModelsForStreamFn(mockModel, options.streamFn);
  let state = createPiHarnessSessionState({
    metadata: { id: options.sessionId, createdAt: "2026-07-01T12:00:00.000Z" },
  });
  const results: WorkflowAgentHarnessStepResult<AssistantMessage>[] = [];
  const sizes: StepResultSize[] = [];

  for (const [index, prompt] of options.prompts.entries()) {
    const operationId = `${workflowName}:${options.sessionId}:turn-${index}`;
    const restored = restoreWorkflowBackedSession({
      operationId,
      state,
      previousEmissions: [],
      models,
    });
    const harness = new AgentHarness({
      systemPrompt: "You are helpful.",
      model: mockModel,
      models,
      tools: [...(options.tools ?? [])],
      ...restored.options,
    });
    const recorder = createEmissionRecorder();
    const result = await withWorkflowAgentHarness({
      session: restored.session,
      storage: restored.storage,
      harness,
      tx: recorder.tx,
      runDurableStep: () => harness.prompt(prompt),
    });

    state = applyWorkflowAgentHarnessStepResult(state, result);
    results.push(result);
    sizes.push(measureStepResult(index + 1, state, result, recorder.emitted));
  }

  return { results, sizes };
};

const sum = (values: readonly number[]): number =>
  values.reduce((total, value) => total + value, 0);

const reductionPercent = (before: number, after: number): number =>
  ((before - after) / before) * 100;

const reportTraceSizes = (
  name: string,
  sizes: readonly StepResultSize[],
  baseline: TraceSizeBaseline,
) => {
  const totalResultBytes = sum(sizes.map((size) => size.resultBytes));
  const totalOperationCompleteEmissionBytes = sum(
    sizes.map((size) => size.operationCompleteEmissionBytes),
  );

  console.info(name, {
    steps: sizes,
    result: {
      beforeBytes: baseline.resultBytes,
      afterBytes: totalResultBytes,
      savedBytes: baseline.resultBytes - totalResultBytes,
      reductionPercent: reductionPercent(baseline.resultBytes, totalResultBytes),
    },
    operationCompleteEmission: {
      beforeBytes: baseline.operationCompleteEmissionBytes,
      afterBytes: totalOperationCompleteEmissionBytes,
      savedBytes: baseline.operationCompleteEmissionBytes - totalOperationCompleteEmissionBytes,
      reductionPercent: reductionPercent(
        baseline.operationCompleteEmissionBytes,
        totalOperationCompleteEmissionBytes,
      ),
    },
  });
};

describe("workflow AgentHarness result size", () => {
  test("keeps repeated human and assistant turns delta-only", async () => {
    const promptText = "human context ".repeat(80);
    const responseText = "agent response ".repeat(160);
    const responses = [1, 2, 3, 4].map(
      (turn): ScriptedResponse => ({ type: "text", text: `turn ${turn}: ${responseText}` }),
    );

    const { sizes } = await runPromptTrace({
      sessionId: "conversation-result-size",
      prompts: [1, 2, 3, 4].map((turn) => `human turn ${turn}: ${promptText}`),
      streamFn: createScriptedStreamFn(responses),
    });

    const baseline = {
      resultBytes: 71_127,
      operationCompleteEmissionBytes: 71_595,
    } satisfies TraceSizeBaseline;
    const totalResultBytes = sum(sizes.map((size) => size.resultBytes));
    const totalOperationCompleteEmissionBytes = sum(
      sizes.map((size) => size.operationCompleteEmissionBytes),
    );

    expect(sizes.map((size) => size.sessionEntryCount)).toEqual([2, 4, 6, 8]);
    expect(sizes.map((size) => size.appendedEntryCount)).toEqual([2, 2, 2, 2]);
    expect(totalResultBytes).toBeLessThan(baseline.resultBytes * 0.45);
    expect(totalOperationCompleteEmissionBytes).toBeLessThan(
      baseline.operationCompleteEmissionBytes * 0.45,
    );

    reportTraceSizes("delta-only human/agent result sizes", sizes, baseline);
  });

  test("does not carry a large tool call and result into later step results", async () => {
    const toolResultText = "tool result payload ".repeat(300);
    const lookupTool: AgentTool = {
      name: "lookupRecord",
      label: "Lookup record",
      description: "Returns a deliberately substantial benchmark payload.",
      parameters: Type.Object({ query: Type.String() }),
      execute: async () => ({
        content: [{ type: "text", text: toolResultText }],
        details: { payload: toolResultText },
      }),
    };
    const toolArguments = { query: `account ${"lookup context ".repeat(70)}` };
    const responseText = "agent tool summary ".repeat(120);
    const streamFn = createScriptedStreamFn([
      { type: "text", text: `initial answer: ${responseText}` },
      {
        type: "toolCall",
        toolCall: {
          type: "toolCall",
          id: "lookup-call-1",
          name: "lookupRecord",
          arguments: toolArguments,
        },
      },
      { type: "text", text: `tool-backed answer: ${responseText}` },
      { type: "text", text: `follow-up answer: ${responseText}` },
    ]);

    const { results, sizes } = await runPromptTrace({
      sessionId: "tool-result-size",
      prompts: [
        `first human turn: ${"context ".repeat(100)}`,
        `please use the lookup tool: ${"details ".repeat(100)}`,
        `follow up on that tool result: ${"question ".repeat(100)}`,
      ],
      streamFn,
      tools: [lookupTool],
    });

    const baseline = {
      resultBytes: 84_510,
      operationCompleteEmissionBytes: 84_837,
    } satisfies TraceSizeBaseline;
    const totalResultBytes = sum(sizes.map((size) => size.resultBytes));
    const totalOperationCompleteEmissionBytes = sum(
      sizes.map((size) => size.operationCompleteEmissionBytes),
    );

    expect(sizes.map((size) => size.sessionEntryCount)).toEqual([2, 6, 8]);
    expect(sizes.map((size) => size.appendedEntryCount)).toEqual([2, 4, 2]);
    expect(results[1]?.appendedEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "message",
          message: expect.objectContaining({ role: "toolResult", toolName: "lookupRecord" }),
        }),
      ]),
    );
    expect(JSON.stringify(results[2])).not.toContain(toolResultText);
    expect(totalResultBytes).toBeLessThan(baseline.resultBytes * 0.45);
    expect(totalOperationCompleteEmissionBytes).toBeLessThan(
      baseline.operationCompleteEmissionBytes * 0.45,
    );

    reportTraceSizes("delta-only multi-turn tool-calling result sizes", sizes, baseline);
  });
});
