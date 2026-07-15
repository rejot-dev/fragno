import { assert, describe, expect, it } from "vitest";

import type { WorkflowStep, WorkflowStepTx } from "@fragno-dev/workflows/workflow";
import { Type } from "typebox";

import type { AgentTool, SessionTreeEntry, StreamFn } from "@earendil-works/pi-agent-core";

import { createAssistantStreamScript, createHarnessOptions } from "../pi-test-utils";
import {
  runPiHarnessStep,
  type PiHarnessEmission,
  type PiHarnessStepResult,
} from "./run-pi-harness-step";

const workflowName = "result-size-benchmark";

const serializedByteSize = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value), "utf8");

type CapturedStep = {
  step: WorkflowStep;
  emitted: PiHarnessEmission[];
};

const createCapturedStep = (): CapturedStep => {
  const emitted: PiHarnessEmission[] = [];
  const tx = {
    serviceCalls: () => undefined,
    workflowServiceCalls: () => undefined,
    mutate: () => undefined,
    emit: (payload: PiHarnessEmission) => emitted.push(payload),
    previousEmissions: async () => [],
    onTerminalError: { mutate: () => undefined },
    onEvent: () => () => undefined,
  } as unknown as WorkflowStepTx;
  const step = {
    do: async (_name: string, ...args: unknown[]) => {
      const callback = args.at(-1) as (stepTx: WorkflowStepTx) => Promise<unknown>;
      return await callback(tx);
    },
  } as WorkflowStep;

  return { step, emitted };
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
  sessionEntryCount: number,
  result: PiHarnessStepResult,
  emissions: readonly PiHarnessEmission[],
): StepResultSize => {
  const operationComplete = emissions.find(
    (emission) => emission.kind === "harness-operation-complete",
  );
  assert(operationComplete?.kind === "harness-operation-complete");

  return {
    step,
    sessionEntryCount,
    appendedEntryCount: result.appendedEntries.length,
    resultBytes: serializedByteSize(result),
    appendedEntriesBytes: serializedByteSize(result.appendedEntries),
    assistantMessageBytes: serializedByteSize(result.assistantMessage),
    operationCompleteEmissionBytes: serializedByteSize(operationComplete),
  };
};

const runPromptTrace = async (options: {
  sessionId: string;
  prompts: readonly string[];
  streamFn: StreamFn;
  tools?: readonly AgentTool[];
}): Promise<{ results: PiHarnessStepResult[]; sizes: StepResultSize[] }> => {
  let committedEntries: readonly SessionTreeEntry[] = [];
  const results: PiHarnessStepResult[] = [];
  const sizes: StepResultSize[] = [];

  for (const [index, prompt] of options.prompts.entries()) {
    const captured = createCapturedStep();
    const result = await runPiHarnessStep(captured.step, `turn-${index}`, {
      workflowName,
      sessionId: options.sessionId,
      agentName: "benchmark-agent",
      ...createHarnessOptions({
        streamFn: options.streamFn,
        tools: options.tools ? [...options.tools] : undefined,
      }),
      operation: { kind: "prompt", args: [prompt] },
      committedEntries,
      persistedEntryIds: committedEntries.map((entry) => entry.id),
    });

    committedEntries = [...committedEntries, ...result.appendedEntries];
    results.push(result);
    sizes.push(measureStepResult(index + 1, committedEntries.length, result, captured.emitted));
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

describe("runPiHarnessStep result size", () => {
  it("benchmarks delta-only results across repeated human/agent turns", async () => {
    const promptText = "human context ".repeat(80);
    const responseText = "agent response ".repeat(160);
    const script = createAssistantStreamScript()
      .text(`turn 1: ${responseText}`)
      .text(`turn 2: ${responseText}`)
      .text(`turn 3: ${responseText}`)
      .text(`turn 4: ${responseText}`)
      .build();

    const { sizes } = await runPromptTrace({
      sessionId: "conversation-result-size",
      prompts: [
        `human turn 1: ${promptText}`,
        `human turn 2: ${promptText}`,
        `human turn 3: ${promptText}`,
        `human turn 4: ${promptText}`,
      ],
      streamFn: script.streamFn,
    });

    const baseline = {
      resultBytes: 71_127,
      operationCompleteEmissionBytes: 71_595,
    } satisfies TraceSizeBaseline;
    const totalResultBytes = sum(sizes.map((size) => size.resultBytes));

    expect(sizes.map((size) => size.sessionEntryCount)).toEqual([2, 4, 6, 8]);
    expect(sizes.map((size) => size.appendedEntryCount)).toEqual([2, 2, 2, 2]);
    expect(totalResultBytes).toBeLessThan(baseline.resultBytes * 0.45);

    reportTraceSizes("delta-only human/agent result sizes", sizes, baseline);
  });

  it("benchmarks a multi-turn trace containing a large tool call and result", async () => {
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
    const script = createAssistantStreamScript()
      .text(`initial answer: ${responseText}`)
      .toolCall("lookupRecord", {
        id: "lookup-call-1",
        args: toolArguments,
        deltas: [JSON.stringify(toolArguments)],
      })
      .text(`tool-backed answer: ${responseText}`)
      .text(`follow-up answer: ${responseText}`)
      .build();

    const { results, sizes } = await runPromptTrace({
      sessionId: "tool-result-size",
      prompts: [
        `first human turn: ${"context ".repeat(100)}`,
        `please use the lookup tool: ${"details ".repeat(100)}`,
        `follow up on that tool result: ${"question ".repeat(100)}`,
      ],
      streamFn: script.streamFn,
      tools: [lookupTool],
    });

    const baseline = {
      resultBytes: 84_510,
      operationCompleteEmissionBytes: 84_837,
    } satisfies TraceSizeBaseline;
    const totalResultBytes = sum(sizes.map((size) => size.resultBytes));

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

    reportTraceSizes("delta-only multi-turn tool-calling result sizes", sizes, baseline);
  });
});
