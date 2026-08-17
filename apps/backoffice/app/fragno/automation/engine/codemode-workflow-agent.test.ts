import { assert, expect, test, vi } from "vitest";

import type { WorkflowAgentHarnessStepResult } from "@fragno-dev/pi-harness/workflows/workflow-agent-harness";
import {
  createRemoteWorkflowSuspension,
  type RemoteWorkflowStepHost,
} from "@fragno-dev/workflows/remote-workflow";

import type { AgentMessage, SessionTreeEntry } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";

import type { CodemodeWorkflowAgentToolResult } from "@/fragno/codemode/workflow-agent-rpc";

import {
  createCodemodeWorkflowAgent,
  projectCodemodeWorkflowAgentToolResult,
  serializeCodemodeWorkflowAgentToolResult,
} from "./codemode-workflow-agent";

const timestamp = Date.parse("2026-08-17T12:00:00.000Z");

const assistantMessage = (
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
): AssistantMessage => ({
  role: "assistant",
  content,
  api: "openai-responses",
  provider: "test-provider",
  model: "test-model",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason,
  timestamp,
});

const toolResultMessage = (
  toolCallId: string,
  toolName: string,
  result: unknown,
): AgentMessage => ({
  role: "toolResult",
  toolCallId,
  toolName,
  content: [{ type: "text", text: JSON.stringify(result) }],
  details: { result },
  isError: false,
  timestamp,
});

const createAgent = (remote: RemoteWorkflowStepHost) =>
  createCodemodeWorkflowAgent({
    workflowName: "test-workflow",
    workflowInstanceId: "test-instance",
    createdAt: new Date(timestamp),
    actor: null,
    metadata: null,
    remote,
    resolveHarnessOptions: async () => {
      throw new Error("HARNESS_OPTIONS_SHOULD_NOT_BE_RESOLVED");
    },
  });

test("serializes every workflow tool result as transcript text", () => {
  assert.equal(serializeCodemodeWorkflowAgentToolResult("plain text"), "plain text");
  assert.equal(serializeCodemodeWorkflowAgentToolResult({ value: 1 }), '{"value":1}');
  assert.equal(serializeCodemodeWorkflowAgentToolResult(undefined), "undefined");
  assert.equal(serializeCodemodeWorkflowAgentToolResult(1n), "1");
});

test("projects workflow tool results into transcript text and durable JSON", () => {
  assert.deepEqual(projectCodemodeWorkflowAgentToolResult("plain text"), {
    text: "plain text",
    persistedResult: "plain text",
  });
  assert.deepEqual(projectCodemodeWorkflowAgentToolResult({ value: 1 }), {
    text: '{"value":1}',
    persistedResult: { value: 1 },
  });
  assert.deepEqual(projectCodemodeWorkflowAgentToolResult(undefined), {
    text: "undefined",
    persistedResult: "undefined",
  });
  assert.deepEqual(projectCodemodeWorkflowAgentToolResult(1n), {
    text: "1",
    persistedResult: "1",
  });
  assert.deepEqual(projectCodemodeWorkflowAgentToolResult(new Date(timestamp)), {
    text: '"2026-08-17T12:00:00.000Z"',
    persistedResult: "2026-08-17T12:00:00.000Z",
  });
});

test("rejects overlapping prompts before they can branch the shared session", async () => {
  let rejectFirstPrompt!: (error: Error) => void;
  const firstPromptResult = new Promise<never>((_resolve, reject) => {
    rejectFirstPrompt = reject;
  });
  let doStepCallCount = 0;
  const doStep = vi.fn(() => {
    doStepCallCount += 1;
    return doStepCallCount === 1
      ? firstPromptResult
      : Promise.reject(new Error("THIRD_PROMPT_STOPPED"));
  });
  const agent = createAgent({ do: doStep } as unknown as RemoteWorkflowStepHost);

  const firstPromptError = agent
    .prompt(null, "first", { text: "First prompt" }, null)
    .catch((error: unknown) => error);

  await expect(agent.prompt(null, "second", { text: "Second prompt" }, null)).rejects.toThrow(
    "WORKFLOW_AGENT_CONCURRENT_PROMPT",
  );
  expect(doStep).toHaveBeenCalledTimes(1);

  rejectFirstPrompt(new Error("FIRST_PROMPT_STOPPED"));
  await expect(firstPromptError).resolves.toMatchObject({ message: "FIRST_PROMPT_STOPPED" });

  const nextPrompt = agent.prompt(null, "third", { text: "Third prompt" }, null);
  expect(doStep).toHaveBeenCalledTimes(2);
  await expect(nextPrompt).rejects.toThrow("THIRD_PROMPT_STOPPED");
});

test("propagates a remote suspension before projecting the committed prompt result", async () => {
  const suspension = createRemoteWorkflowSuspension({
    type: "checkpoint",
    stepKey: "do:pi prompt: suspended",
    delayMs: 0,
  });
  const finalAssistant = assistantMessage([{ type: "text", text: "replayed response" }], "stop");
  const committedResult: WorkflowAgentHarnessStepResult<{ assistant: AssistantMessage }> = {
    type: "harness-run",
    outcome: "completed",
    value: { assistant: finalAssistant },
    appendedEntries: [],
    leafId: null,
  };
  let callCount = 0;
  const remote = {
    do: vi.fn(async <T>() => {
      callCount += 1;
      return (callCount === 1 ? suspension : committedResult) as T;
    }),
  } as unknown as RemoteWorkflowStepHost;
  const agent = createAgent(remote);

  await expect(agent.prompt(null, "suspended", { text: "Suspend" }, null)).rejects.toMatchObject({
    name: "RemoteWorkflowSuspendedError",
    reason: suspension.reason,
  });
  await expect(agent.prompt(null, "suspended", { text: "Replay" }, null)).resolves.toMatchObject({
    text: "replayed response",
    stopReason: "stop",
    leafId: null,
    toolResults: [],
  });
  expect(remote.do).toHaveBeenCalledTimes(2);
});

test("returns tool results in durable transcript order instead of executor completion order", async () => {
  const callAssistant = assistantMessage(
    [
      { type: "toolCall", id: "call-a", name: "tool-a", arguments: { value: "a" } },
      { type: "toolCall", id: "call-b", name: "tool-b", arguments: { value: "b" } },
    ],
    "toolUse",
  );
  const finalAssistant = assistantMessage([{ type: "text", text: "done" }], "stop");
  const entries: SessionTreeEntry[] = [
    {
      type: "message",
      id: "entry-assistant-calls",
      parentId: null,
      timestamp: new Date(timestamp).toISOString(),
      message: callAssistant,
    },
    {
      type: "message",
      id: "entry-result-a",
      parentId: "entry-assistant-calls",
      timestamp: new Date(timestamp).toISOString(),
      message: toolResultMessage("call-a", "tool-a", "result-a"),
    },
    {
      type: "message",
      id: "entry-result-b",
      parentId: "entry-result-a",
      timestamp: new Date(timestamp).toISOString(),
      message: toolResultMessage("call-b", "tool-b", "result-b"),
    },
    {
      type: "message",
      id: "entry-final-assistant",
      parentId: "entry-result-b",
      timestamp: new Date(timestamp).toISOString(),
      message: finalAssistant,
    },
  ];
  const completionOrderedResults: CodemodeWorkflowAgentToolResult[] = [
    {
      toolCallId: "call-b",
      toolName: "tool-b",
      arguments: { value: "b" },
      result: "result-b",
    },
    {
      toolCallId: "call-a",
      toolName: "tool-a",
      arguments: { value: "a" },
      result: "result-a",
    },
  ];
  const committedResult: WorkflowAgentHarnessStepResult<{
    assistant: AssistantMessage;
    toolResults: CodemodeWorkflowAgentToolResult[];
  }> = {
    type: "harness-run",
    outcome: "completed",
    value: { assistant: finalAssistant, toolResults: completionOrderedResults },
    appendedEntries: entries,
    leafId: "entry-final-assistant",
  };
  const remote = {
    do: async <T>() => committedResult as T,
  } as unknown as RemoteWorkflowStepHost;
  const agent = createAgent(remote);

  const result = await agent.prompt(null, "ordered-tools", { text: "Use both tools" }, null);

  expect(result.toolResults).toEqual([
    {
      toolCallId: "call-a",
      toolName: "tool-a",
      arguments: { value: "a" },
      result: "result-a",
    },
    {
      toolCallId: "call-b",
      toolName: "tool-b",
      arguments: { value: "b" },
      result: "result-b",
    },
  ]);
});
