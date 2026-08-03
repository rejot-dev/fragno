import { expect, test } from "vitest";

import type { SessionTreeEntry } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";

import {
  createPiOperationCompletedPayload,
  schedulePiOperationCompletedHook,
  type SchedulePiOperationCompletedHookOptions,
} from "./pi-operation-completed";

const usage = (input: number, output: number): AssistantMessage["usage"] => ({
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: input + output,
  cost: {
    input: input / 100,
    output: output / 100,
    cacheRead: 0,
    cacheWrite: 0,
    total: (input + output) / 100,
  },
});

const assistantEntry = (
  id: string,
  parentId: string | null,
  messageUsage: AssistantMessage["usage"],
): SessionTreeEntry => ({
  type: "message",
  id,
  parentId,
  timestamp: "2026-07-01T12:00:00.000Z",
  message: {
    role: "assistant",
    content: [{ type: "text", text: id }],
    api: "openai-responses",
    provider: "openai",
    model: "test-model",
    usage: messageUsage,
    stopReason: "stop",
    timestamp: Date.parse("2026-07-01T12:00:00.000Z"),
  },
});

const operationOptions = (operationEntries: readonly SessionTreeEntry[]) => ({
  actor: { userId: "user-1" },
  workflowName: "test-workflow",
  sessionId: "session-1",
  metadata: { runtime: "test" },
  stepName: "prompt",
  operationId: "session-1:prompt",
  operation: "prompt" as const,
  operationEntries,
});

test("builds Pi accounting from every model call in the invocation", () => {
  const payload = createPiOperationCompletedPayload(
    operationOptions([
      assistantEntry("assistant-1", null, usage(10, 5)),
      assistantEntry("assistant-2", "assistant-1", usage(20, 7)),
    ]),
  );

  expect(payload).toMatchObject({
    operationId: "session-1:prompt",
    modelCalls: [{ usage: usage(10, 5) }, { usage: usage(20, 7) }],
    usage: {
      input: 30,
      output: 12,
      totalTokens: 42,
    },
  });
  expect(payload?.usage.cost.input).toBeCloseTo(0.3);
  expect(payload?.usage.cost.output).toBeCloseTo(0.12);
  expect(payload?.usage.cost.total).toBeCloseTo(0.42);
});

test("omits accounting when Pi exposed no assistant model calls", () => {
  expect(createPiOperationCompletedPayload(operationOptions([]))).toBeUndefined();
});

test("registers both transaction outcomes whenever accounting is declared", () => {
  const committedMutations: unknown[] = [];
  const terminalErrorMutations: unknown[] = [];
  const tx: SchedulePiOperationCompletedHookOptions["tx"] = {
    mutate: (mutation) => committedMutations.push(mutation),
    onTerminalError: {
      mutate: (mutation) => terminalErrorMutations.push(mutation),
    },
  };
  const entries = [assistantEntry("assistant-1", null, usage(10, 5))];

  schedulePiOperationCompletedHook({ tx, ...operationOptions(entries) });
  schedulePiOperationCompletedHook({ tx, ...operationOptions(entries) });

  expect(committedMutations).toHaveLength(2);
  expect(terminalErrorMutations).toHaveLength(2);
});
