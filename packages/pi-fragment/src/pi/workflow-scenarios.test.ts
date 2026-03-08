import { describe, expect, it, vi } from "vitest";
import {
  createScenarioSteps,
  defineScenario,
  runScenario,
  type WorkflowScenarioStepRow,
} from "@fragno-dev/workflows/scenario";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage } from "@mariozechner/pi-ai";

import {
  createFailingStreamFn,
  createStreamFn,
  createStreamFnScript,
  createTestWorkflows,
  mockModel,
} from "./test-utils";
import { defineAgent } from "./dsl";
import {
  PI_TOOL_JOURNAL_VERSION,
  type PiAgentDefinition,
  type PiPersistedToolCall,
  type PiToolFactory,
} from "./types";

type ScenarioStatus = { status: string; output?: unknown; error?: { message?: string } };

type BashState = {
  cwd: string;
  files: Record<string, string>;
};

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const jsonSchemaParameters = {
  type: "object",
  properties: {
    command: { type: "string" },
  },
  required: ["command"],
  additionalProperties: true,
} as const;

const sanitizeCallId = (value: string) => {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "default";
};

const buildAssistantMessage = (options: {
  content: AssistantMessage["content"];
  stopReason: AssistantMessage["stopReason"];
}): AssistantMessage => ({
  role: "assistant",
  content: options.content,
  api: "openai-responses",
  provider: "openai",
  model: "test-model",
  usage,
  stopReason: options.stopReason,
  timestamp: Date.now(),
});

const extractLastUserText = (messages: unknown[]): string => {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || typeof message !== "object" || (message as { role?: string }).role !== "user") {
      continue;
    }
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") {
      return content;
    }
    if (!Array.isArray(content)) {
      continue;
    }
    const textBlock = content.find((block) => {
      if (!block || typeof block !== "object") {
        return false;
      }
      return (block as { type?: string }).type === "text";
    }) as { text?: string } | undefined;
    if (typeof textBlock?.text === "string") {
      return textBlock.text;
    }
  }
  return "";
};

const isToolResultMessage = (value: unknown) =>
  value && typeof value === "object" && (value as { role?: string }).role === "toolResult";

const createToolLoopStreamFn = (options: {
  toolName: string;
  duplicateToolCallId?: string;
}): PiAgentDefinition["streamFn"] => {
  return (model, input, ctx) => {
    const lastMessage = input.messages[input.messages.length - 1];
    const userText = extractLastUserText(input.messages as unknown[]);

    if (isToolResultMessage(lastMessage)) {
      const response = buildAssistantMessage({
        content: [{ type: "text", text: `assistant:${userText}:done` }],
        stopReason: "stop",
      });
      return createStreamFnScript(
        [
          { type: "start", partial: response },
          { type: "done", reason: "stop", message: response },
        ],
        { result: response },
      )(model, input, ctx as never);
    }

    const callId =
      options.duplicateToolCallId ??
      `call-${sanitizeCallId(userText || input.messages.length.toString())}`;
    const toolCall = {
      type: "toolCall" as const,
      id: callId,
      name: options.toolName,
      arguments: { command: userText },
    };

    const content = options.duplicateToolCallId ? [toolCall, { ...toolCall }] : [toolCall];
    const response = buildAssistantMessage({ content, stopReason: "toolUse" });

    return createStreamFnScript(
      [
        { type: "start", partial: response },
        { type: "done", reason: "toolUse", message: response },
      ],
      { result: response },
    )(model, input, ctx as never);
  };
};

const createToolLoopStreamFnWithResultFailureOnce = (options: {
  toolName: string;
}): PiAgentDefinition["streamFn"] => {
  let failedOnce = false;

  return (model, input, ctx) => {
    const lastMessage = input.messages[input.messages.length - 1];
    const userText = extractLastUserText(input.messages as unknown[]);

    if (isToolResultMessage(lastMessage)) {
      const response = buildAssistantMessage({
        content: [{ type: "text", text: `assistant:${userText}:done` }],
        stopReason: "stop",
      });
      const resultError = !failedOnce ? new Error("STREAM_FAIL_AFTER_TOOL") : undefined;
      failedOnce = true;
      return createStreamFnScript(
        [
          { type: "start", partial: response },
          { type: "done", reason: "stop", message: response },
        ],
        { result: response, resultError },
      )(model, input, ctx as never);
    }

    const toolCall = {
      type: "toolCall" as const,
      id: `call-${sanitizeCallId(userText || "default")}`,
      name: options.toolName,
      arguments: { command: userText },
    };
    const response = buildAssistantMessage({ content: [toolCall], stopReason: "toolUse" });

    return createStreamFnScript(
      [
        { type: "start", partial: response },
        { type: "done", reason: "toolUse", message: response },
      ],
      { result: response },
    )(model, input, ctx as never);
  };
};

const createOrderedToolLoopStreamFn = (toolName: string): PiAgentDefinition["streamFn"] => {
  return (model, input, ctx) => {
    const lastMessage = input.messages[input.messages.length - 1];
    if (isToolResultMessage(lastMessage)) {
      const response = buildAssistantMessage({
        content: [{ type: "text", text: "assistant:ordered:done" }],
        stopReason: "stop",
      });
      return createStreamFnScript(
        [
          { type: "start", partial: response },
          { type: "done", reason: "stop", message: response },
        ],
        { result: response },
      )(model, input, ctx as never);
    }

    const response = buildAssistantMessage({
      content: [
        {
          type: "toolCall" as const,
          id: "call-b",
          name: toolName,
          arguments: { command: "b" },
        },
        {
          type: "toolCall" as const,
          id: "call-a",
          name: toolName,
          arguments: { command: "a" },
        },
      ],
      stopReason: "toolUse",
    });

    return createStreamFnScript(
      [
        { type: "start", partial: response },
        { type: "done", reason: "toolUse", message: response },
      ],
      { result: response },
    )(model, input, ctx as never);
  };
};

const createCounterTool =
  (options: { calls: { count: number }; throwError?: boolean }): PiToolFactory =>
  async () => ({
    name: "counter",
    label: "Counter",
    description: "Counts tool executions",
    parameters: jsonSchemaParameters as never,
    execute: async (_toolCallId, params) => {
      options.calls.count += 1;
      if (options.throwError) {
        throw new Error("COUNTER_FAIL");
      }
      const command =
        params &&
        typeof params === "object" &&
        typeof (params as { command?: unknown }).command === "string"
          ? ((params as { command: string }).command ?? "")
          : "";
      return {
        content: [{ type: "text", text: `counter:${command}:${options.calls.count}` }],
        details: { count: options.calls.count, command },
      };
    },
  });

const createOrderTool =
  (state: { snapshots: string[][]; calls: string[] }): PiToolFactory =>
  async (ctx) => {
    const replayState = Array.isArray(ctx.replay.sideEffects["order"])
      ? (ctx.replay.sideEffects["order"] as unknown[])
      : [];
    state.snapshots.push(replayState.filter((value): value is string => typeof value === "string"));

    return {
      name: "order",
      label: "Order",
      description: "Records execution order",
      parameters: jsonSchemaParameters as never,
      execute: async (_toolCallId, params) => {
        const command =
          params &&
          typeof params === "object" &&
          typeof (params as { command?: unknown }).command === "string"
            ? ((params as { command: string }).command ?? "")
            : "";
        state.calls.push(command);
        return {
          content: [{ type: "text", text: command }],
          details: { command },
        };
      },
    };
  };

const coerceBashState = (value: unknown): BashState => {
  const fallback: BashState = { cwd: "/", files: {} };
  if (!value || typeof value !== "object") {
    return fallback;
  }
  const record = value as { cwd?: unknown; files?: unknown };
  const files: Record<string, string> = {};
  if (record.files && typeof record.files === "object" && !Array.isArray(record.files)) {
    for (const [path, content] of Object.entries(record.files as Record<string, unknown>)) {
      if (typeof content === "string") {
        files[path] = content;
      }
    }
  }
  return {
    cwd: typeof record.cwd === "string" ? record.cwd : "/",
    files,
  };
};

const createBashTool =
  (state: { calls: { count: number }; snapshots: BashState[] }): PiToolFactory =>
  async (ctx) => {
    const replayState = coerceBashState(ctx.replay.sideEffects["bash"]);
    let runtime: BashState = {
      cwd: replayState.cwd,
      files: { ...replayState.files },
    };

    state.snapshots.push({ cwd: runtime.cwd, files: { ...runtime.files } });

    return {
      name: "bash",
      label: "Bash",
      description: "Bash-like filesystem tool",
      parameters: jsonSchemaParameters as never,
      execute: async (_toolCallId, params) => {
        state.calls.count += 1;

        const command =
          params &&
          typeof params === "object" &&
          typeof (params as { command?: unknown }).command === "string"
            ? ((params as { command: string }).command ?? "")
            : "";

        const writes: Array<{ path: string; content: string }> = [];
        const deletes: string[] = [];
        let observedContent: string | null = null;

        if (command.startsWith("write ")) {
          const [, path, ...contentParts] = command.split(" ");
          const content = contentParts.join(" ");
          if (path) {
            runtime.files[path] = content;
            writes.push({ path, content });
          }
        } else if (command.startsWith("delete ")) {
          const [, path] = command.split(" ");
          if (path) {
            delete runtime.files[path];
            deletes.push(path);
          }
        } else if (command.startsWith("read ")) {
          const [, path] = command.split(" ");
          if (path) {
            observedContent = runtime.files[path] ?? null;
          }
        }

        return {
          content: [{ type: "text", text: observedContent ?? "ok" }],
          details: {
            cwd: runtime.cwd,
            files: { ...runtime.files },
            writes,
            deletes,
            observedContent,
          },
        };
      },
    };
  };

const createAgents = (streamFn: PiAgentDefinition["streamFn"], tools?: string[]) => ({
  default: defineAgent("default", {
    systemPrompt: "You are helpful.",
    model: mockModel,
    streamFn,
    ...(tools ? { tools } : {}),
  }),
});

describe("pi-workflows scenarios", () => {
  it("stores messages and trace in step results", async () => {
    const agents = createAgents(createStreamFn("assistant:ping"));
    const workflows = createTestWorkflows({ agents, tools: {} });

    type ScenarioVars = {
      finalStatus?: ScenarioStatus;
      steps?: WorkflowScenarioStepRow[];
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "pi-workflows-store-messages",
      workflows,
      harness: { adapter: { type: "kysely-sqlite" } },
      steps: [
        scenarioSteps.initializeAndRunUntilIdle({
          workflow: "agentLoop",
          id: "session-1",
          params: {
            sessionId: "session-1",
            agentName: "default",
            systemPrompt: "You are helpful.",
            initialMessages: [],
          },
        }),
        scenarioSteps.eventAndRunUntilIdle({
          workflow: "agentLoop",
          instanceId: "session-1",
          event: {
            type: "user_message",
            payload: { text: "ping", done: true, steeringMode: "one-at-a-time" },
          },
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("agentLoop", "session-1"),
          storeAs: "finalStatus",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getSteps("agentLoop", "session-1"),
          storeAs: "steps",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.finalStatus?.status).toBe("complete");

          const output = ctx.vars.finalStatus?.output as { messages?: AgentMessage[] } | undefined;
          expect(output?.messages).toBeTruthy();
          expect(output?.messages?.length).toBeGreaterThanOrEqual(2);
          expect(output?.messages?.[0]).toMatchObject({ role: "user" });
          expect(output?.messages?.[1]).toMatchObject({ role: "assistant" });

          const steps = ctx.vars.steps ?? [];
          const userStep = steps.find((step) => step.name === "user-0");
          const assistantStep = steps.find((step) => step.name === "assistant-0");

          expect(userStep).toBeTruthy();
          expect(assistantStep).toBeTruthy();
          const assistantResult = assistantStep?.result as {
            assistant?: AgentMessage;
            trace?: unknown;
            toolJournal?: unknown[];
          };
          expect(assistantResult?.assistant).toMatchObject({ role: "assistant" });
          expect(Array.isArray(assistantResult?.trace)).toBe(true);
          expect(assistantResult?.toolJournal ?? []).toHaveLength(0);
        }),
      ],
    });

    await runScenario(scenario);
  });

  it("retries without duplicating the user message", async () => {
    const agents = createAgents(createFailingStreamFn({ failOnceForText: "retry" }));
    const workflows = createTestWorkflows({ agents, tools: {} });

    type ScenarioVars = {
      finalStatus?: ScenarioStatus;
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "pi-workflows-retry-no-dup",
      workflows,
      harness: { adapter: { type: "kysely-sqlite" } },
      steps: [
        scenarioSteps.initializeAndRunUntilIdle({
          workflow: "agentLoop",
          id: "session-2",
          params: {
            sessionId: "session-2",
            agentName: "default",
            systemPrompt: "You are helpful.",
            initialMessages: [],
          },
        }),
        scenarioSteps.eventAndRunUntilIdle({
          workflow: "agentLoop",
          instanceId: "session-2",
          event: {
            type: "user_message",
            payload: { text: "retry", done: true, steeringMode: "one-at-a-time" },
          },
        }),
        scenarioSteps.retryAndRunUntilIdle({
          workflow: "agentLoop",
          instanceId: "session-2",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("agentLoop", "session-2"),
          storeAs: "finalStatus",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.finalStatus?.status).toBe("complete");

          const output = ctx.vars.finalStatus?.output as { messages?: AgentMessage[] } | undefined;
          const userMessages = (output?.messages ?? []).filter((message) => {
            return (
              message && typeof message === "object" && "role" in message && message.role === "user"
            );
          });
          expect(userMessages).toHaveLength(1);
        }),
      ],
    });

    await runScenario(scenario);
  });

  it("captures tool executions in persisted assistant step journals", async () => {
    const callState = { count: 0 };
    const agents = createAgents(createToolLoopStreamFn({ toolName: "counter" }), ["counter"]);
    const workflows = createTestWorkflows({
      agents,
      tools: {
        counter: createCounterTool({ calls: callState }),
      },
    });

    type ScenarioVars = {
      steps?: WorkflowScenarioStepRow[];
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "pi-workflows-tool-journal",
      workflows,
      harness: { adapter: { type: "kysely-sqlite" } },
      steps: [
        scenarioSteps.initializeAndRunUntilIdle({
          workflow: "agentLoop",
          id: "session-tool-journal",
          params: {
            sessionId: "session-tool-journal",
            agentName: "default",
            initialMessages: [],
          },
        }),
        scenarioSteps.eventAndRunUntilIdle({
          workflow: "agentLoop",
          instanceId: "session-tool-journal",
          event: {
            type: "user_message",
            payload: { text: "alpha", done: true },
          },
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getSteps("agentLoop", "session-tool-journal"),
          storeAs: "steps",
        }),
        scenarioSteps.assert((ctx) => {
          expect(callState.count).toBe(1);

          const assistantStep = (ctx.vars.steps ?? []).find((step) => step.name === "assistant-0");
          const result = assistantStep?.result as
            | { toolJournal?: PiPersistedToolCall[] }
            | undefined;
          const journal = result?.toolJournal ?? [];
          expect(journal).toHaveLength(1);

          expect(journal[0]).toMatchObject({
            version: PI_TOOL_JOURNAL_VERSION,
            sessionId: "session-tool-journal",
            turnId: "session-tool-journal:0",
            toolCallId: "call-alpha",
            toolName: "counter",
            args: { command: "alpha" },
            isError: false,
            source: "executed",
            key: "session-tool-journal:session-tool-journal:0:call-alpha",
          });
        }),
      ],
    });

    await runScenario(scenario);
  });

  it("short-circuits duplicate tool calls and replays cached results", async () => {
    const callState = { count: 0 };
    const agents = createAgents(
      createToolLoopStreamFn({ toolName: "counter", duplicateToolCallId: "call-dup" }),
      ["counter"],
    );
    const workflows = createTestWorkflows({
      agents,
      tools: {
        counter: createCounterTool({ calls: callState }),
      },
    });

    type ScenarioVars = {
      steps?: WorkflowScenarioStepRow[];
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "pi-workflows-duplicate-tool-short-circuit",
      workflows,
      harness: { adapter: { type: "kysely-sqlite" } },
      steps: [
        scenarioSteps.initializeAndRunUntilIdle({
          workflow: "agentLoop",
          id: "session-tool-dup",
          params: {
            sessionId: "session-tool-dup",
            agentName: "default",
            initialMessages: [],
          },
        }),
        scenarioSteps.eventAndRunUntilIdle({
          workflow: "agentLoop",
          instanceId: "session-tool-dup",
          event: {
            type: "user_message",
            payload: { text: "dup", done: true },
          },
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getSteps("agentLoop", "session-tool-dup"),
          storeAs: "steps",
        }),
        scenarioSteps.assert((ctx) => {
          expect(callState.count).toBe(1);

          const assistantStep = (ctx.vars.steps ?? []).find((step) => step.name === "assistant-0");
          const result = assistantStep?.result as {
            messages?: AgentMessage[];
            toolJournal?: PiPersistedToolCall[];
          };

          const journal = result?.toolJournal ?? [];
          expect(journal).toHaveLength(2);
          expect(journal[0]?.source).toBe("executed");
          expect(journal[1]?.source).toBe("replay");
          expect(journal[0]?.key).toBe(journal[1]?.key);

          const toolResults = (result?.messages ?? []).filter(
            (message) => message && typeof message === "object" && message.role === "toolResult",
          );
          expect(toolResults).toHaveLength(2);
        }),
      ],
    });

    await runScenario(scenario);
  });

  it("replays error tool results consistently without re-executing the tool", async () => {
    const callState = { count: 0 };
    const agents = createAgents(
      createToolLoopStreamFn({ toolName: "counter", duplicateToolCallId: "call-error" }),
      ["counter"],
    );
    const workflows = createTestWorkflows({
      agents,
      tools: {
        counter: createCounterTool({ calls: callState, throwError: true }),
      },
    });

    type ScenarioVars = {
      steps?: WorkflowScenarioStepRow[];
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "pi-workflows-error-tool-replay",
      workflows,
      harness: { adapter: { type: "kysely-sqlite" } },
      steps: [
        scenarioSteps.initializeAndRunUntilIdle({
          workflow: "agentLoop",
          id: "session-tool-error",
          params: {
            sessionId: "session-tool-error",
            agentName: "default",
            initialMessages: [],
          },
        }),
        scenarioSteps.eventAndRunUntilIdle({
          workflow: "agentLoop",
          instanceId: "session-tool-error",
          event: {
            type: "user_message",
            payload: { text: "boom", done: true },
          },
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getSteps("agentLoop", "session-tool-error"),
          storeAs: "steps",
        }),
        scenarioSteps.assert((ctx) => {
          expect(callState.count).toBe(1);

          const assistantStep = (ctx.vars.steps ?? []).find((step) => step.name === "assistant-0");
          const result = assistantStep?.result as {
            messages?: AgentMessage[];
            toolJournal?: PiPersistedToolCall[];
          };

          const journal = result?.toolJournal ?? [];
          expect(journal).toHaveLength(2);
          expect(journal[0]?.isError).toBe(true);
          expect(journal[1]?.isError).toBe(true);
          expect(journal[0]?.source).toBe("executed");
          expect(journal[1]?.source).toBe("replay");

          const toolResults = (result?.messages ?? []).filter((message) => {
            return message && typeof message === "object" && message.role === "toolResult";
          }) as Array<{ isError?: boolean; content?: unknown }>;
          expect(toolResults).toHaveLength(2);
          expect(toolResults[0]?.isError).toBe(true);
          expect(toolResults[1]?.isError).toBe(true);
        }),
      ],
    });

    await runScenario(scenario);
  });

  it("retries after post-tool stream failures and re-executes tools on retry attempts", async () => {
    const callState = { count: 0 };
    const agents = createAgents(
      createToolLoopStreamFnWithResultFailureOnce({ toolName: "counter" }),
      ["counter"],
    );
    const workflows = createTestWorkflows({
      agents,
      tools: {
        counter: createCounterTool({ calls: callState }),
      },
    });

    type ScenarioVars = {
      finalStatus?: ScenarioStatus;
      steps?: WorkflowScenarioStepRow[];
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "pi-workflows-retry-after-tool-stream-failure",
      workflows,
      harness: { adapter: { type: "kysely-sqlite" } },
      steps: [
        scenarioSteps.initializeAndRunUntilIdle({
          workflow: "agentLoop",
          id: "session-retry-tool-failure",
          params: {
            sessionId: "session-retry-tool-failure",
            agentName: "default",
            initialMessages: [],
          },
        }),
        scenarioSteps.eventAndRunUntilIdle({
          workflow: "agentLoop",
          instanceId: "session-retry-tool-failure",
          event: {
            type: "user_message",
            payload: { text: "retry-tool", done: true },
          },
        }),
        scenarioSteps.retryAndRunUntilIdle({
          workflow: "agentLoop",
          instanceId: "session-retry-tool-failure",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("agentLoop", "session-retry-tool-failure"),
          storeAs: "finalStatus",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getSteps("agentLoop", "session-retry-tool-failure"),
          storeAs: "steps",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.finalStatus?.status).toBe("complete");
          expect(callState.count).toBe(2);

          const assistantStep = (ctx.vars.steps ?? []).find((step) => step.name === "assistant-0");
          const result = assistantStep?.result as
            | { messages?: AgentMessage[]; toolJournal?: PiPersistedToolCall[] }
            | undefined;
          const journal = result?.toolJournal ?? [];
          expect(journal).toHaveLength(1);
          expect(journal[0]?.source).toBe("executed");
          expect(journal[0]?.isError).toBe(false);

          const assistantMessages = (result?.messages ?? []).filter(
            (message) => message && typeof message === "object" && message.role === "assistant",
          ) as Array<{ content?: unknown; stopReason?: unknown }>;
          expect(assistantMessages.length).toBeGreaterThanOrEqual(1);
          const lastAssistant = assistantMessages[assistantMessages.length - 1] as {
            content?: Array<{ text?: string }>;
          };
          expect(lastAssistant.content?.[0]?.text).toBe("assistant:retry-tool:done");
        }),
      ],
    });

    await runScenario(scenario);
  });

  it("preserves tool execution order with seq when capturedAt timestamps collide", async () => {
    const state = {
      snapshots: [] as string[][],
      calls: [] as string[],
    };
    const agents = createAgents(createOrderedToolLoopStreamFn("order"), ["order"]);
    const workflows = createTestWorkflows({
      agents,
      tools: {
        order: createOrderTool(state),
      },
      toolSideEffectReducers: {
        order: (currentState, entry) => {
          const existing = Array.isArray(currentState) ? currentState : [];
          const command =
            entry.args &&
            typeof entry.args === "object" &&
            typeof (entry.args as { command?: unknown }).command === "string"
              ? ((entry.args as { command: string }).command ?? "")
              : "";
          return [...existing, command];
        },
      },
    });

    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_750_000_000_000);

    try {
      type ScenarioVars = {
        finalStatus?: ScenarioStatus;
      };

      const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
      const scenario = defineScenario<typeof workflows, ScenarioVars>({
        name: "pi-workflows-seq-ordering",
        workflows,
        harness: { adapter: { type: "kysely-sqlite" } },
        steps: [
          scenarioSteps.initializeAndRunUntilIdle({
            workflow: "agentLoop",
            id: "session-seq-ordering",
            params: {
              sessionId: "session-seq-ordering",
              agentName: "default",
              initialMessages: [],
            },
          }),
          scenarioSteps.eventAndRunUntilIdle({
            workflow: "agentLoop",
            instanceId: "session-seq-ordering",
            event: {
              type: "user_message",
              payload: { text: "first", done: false },
            },
          }),
          scenarioSteps.eventAndRunUntilIdle({
            workflow: "agentLoop",
            instanceId: "session-seq-ordering",
            event: {
              type: "user_message",
              payload: { text: "second", done: true },
            },
          }),
          scenarioSteps.read({
            read: (ctx) => ctx.state.getStatus("agentLoop", "session-seq-ordering"),
            storeAs: "finalStatus",
          }),
          scenarioSteps.assert((ctx) => {
            expect(ctx.vars.finalStatus?.status).toBe("complete");
            expect(state.snapshots[0]).toEqual([]);
            expect(state.snapshots[1]).toEqual(["b", "a"]);
            expect(state.calls).toEqual(["b", "a", "b", "a"]);
          }),
        ],
      });

      await runScenario(scenario);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("rebuilds bash side effects across turns via replay reducers", async () => {
    const callState = { count: 0 };
    const snapshots: BashState[] = [];
    const agents = createAgents(createToolLoopStreamFn({ toolName: "bash" }), ["bash"]);
    const workflows = createTestWorkflows({
      agents,
      tools: {
        bash: createBashTool({ calls: callState, snapshots }),
      },
    });

    type ScenarioVars = {
      steps?: WorkflowScenarioStepRow[];
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "pi-workflows-bash-side-effects",
      workflows,
      harness: { adapter: { type: "kysely-sqlite" } },
      steps: [
        scenarioSteps.initializeAndRunUntilIdle({
          workflow: "agentLoop",
          id: "session-bash",
          params: {
            sessionId: "session-bash",
            agentName: "default",
            initialMessages: [],
          },
        }),
        scenarioSteps.eventAndRunUntilIdle({
          workflow: "agentLoop",
          instanceId: "session-bash",
          event: {
            type: "user_message",
            payload: { text: "write /note.txt hello", done: false },
          },
        }),
        scenarioSteps.eventAndRunUntilIdle({
          workflow: "agentLoop",
          instanceId: "session-bash",
          event: {
            type: "user_message",
            payload: { text: "read /note.txt", done: true },
          },
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getSteps("agentLoop", "session-bash"),
          storeAs: "steps",
        }),
        scenarioSteps.assert((ctx) => {
          expect(callState.count).toBe(2);
          expect(snapshots.length).toBeGreaterThanOrEqual(2);
          expect(snapshots[0]?.files["/note.txt"]).toBeUndefined();
          expect(snapshots[1]?.files["/note.txt"]).toBe("hello");

          const secondAssistantStep = (ctx.vars.steps ?? []).find(
            (step) => step.name === "assistant-1",
          );
          const result = secondAssistantStep?.result as
            | { toolJournal?: PiPersistedToolCall[] }
            | undefined;
          const journal = result?.toolJournal ?? [];
          expect(journal).toHaveLength(1);
          const details = (journal[0]?.result.details ?? {}) as { observedContent?: string | null };
          expect(details.observedContent).toBe("hello");
        }),
      ],
    });

    await runScenario(scenario);
  });

  it("fails safely when replay hydration encounters an unsupported journal version", async () => {
    const agents = createAgents(createToolLoopStreamFn({ toolName: "counter" }), ["counter"]);
    const workflows = createTestWorkflows({
      agents,
      tools: {
        counter: createCounterTool({ calls: { count: 0 } }),
      },
    });

    type ScenarioVars = {
      finalStatus?: ScenarioStatus;
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "pi-workflows-unsupported-journal-version",
      workflows,
      harness: { adapter: { type: "kysely-sqlite" } },
      steps: [
        scenarioSteps.initializeAndRunUntilIdle({
          workflow: "agentLoop",
          id: "session-bad-journal",
          params: {
            sessionId: "session-bad-journal",
            agentName: "default",
            initialMessages: [],
          },
        }),
        scenarioSteps.eventAndRunUntilIdle({
          workflow: "agentLoop",
          instanceId: "session-bad-journal",
          event: {
            type: "user_message",
            payload: { text: "first", done: false },
          },
        }),
        scenarioSteps.read({
          read: async (ctx) => {
            const steps = await ctx.harness.db.find("workflow_step");
            const assistantStep = steps.find(
              (row: unknown) => (row as { name?: string }).name === "assistant-0",
            ) as { id: { valueOf: () => string }; result?: unknown } | undefined;
            if (!assistantStep?.id) {
              throw new Error("Expected assistant step row");
            }

            const existingResult =
              assistantStep.result && typeof assistantStep.result === "object"
                ? (assistantStep.result as Record<string, unknown>)
                : {};
            const existingJournal = Array.isArray(existingResult["toolJournal"])
              ? [...(existingResult["toolJournal"] as Array<Record<string, unknown>>)]
              : [];
            if (existingJournal.length === 0) {
              throw new Error("Expected persisted tool journal entries");
            }

            existingJournal[0] = { ...existingJournal[0], version: 999 };
            await ctx.harness.db.update("workflow_step", assistantStep.id.valueOf(), (b) =>
              b.set({
                result: {
                  ...existingResult,
                  toolJournal: existingJournal,
                },
              }),
            );
            return true;
          },
        }),
        scenarioSteps.eventAndRunUntilIdle({
          workflow: "agentLoop",
          instanceId: "session-bad-journal",
          event: {
            type: "user_message",
            payload: { text: "second", done: true },
          },
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("agentLoop", "session-bad-journal"),
          storeAs: "finalStatus",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.finalStatus?.status).toBe("errored");
          expect(ctx.vars.finalStatus?.error?.message ?? "").toContain("Unsupported tool journal");
        }),
      ],
    });

    await runScenario(scenario);
  });
});
