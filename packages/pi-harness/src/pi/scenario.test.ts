import { assert, describe, expect, test, vi } from "vitest";

import { defineScenario, runScenario } from "@fragno-dev/workflows/scenario";
import { defineWorkflow } from "@fragno-dev/workflows/workflow";
import { Type } from "typebox";
import { z } from "zod";

import { instantiate } from "@fragno-dev/core";

import type { AgentEvent, AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Model,
  type ToolCall,
} from "@earendil-works/pi-ai";

import { createPiFragmentClients } from "../client/clients";
import { piRoutesFactory } from "../routes";
import { piHarnessDefinition } from "./definition";
import { createPiWorkflows } from "./factory";
import { createModelsForStreamFn } from "./harness/test-models";
import { piSessionCommandPayloadSchema } from "./route-schemas";
import { definePiTool } from "./tools";
import type { PiFragmentConfig } from "./types";
import { createInteractiveChatWorkflow } from "./workflows/interactive-chat-workflow";

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

const createAbortableStreamFn =
  (onAbort: () => void): StreamFn =>
  (_model, _context, options) => {
    const stream = createAssistantMessageEventStream();
    const message = createAssistantMessage("aborted by test");
    const abortedMessage: AssistantMessage = {
      ...message,
      stopReason: "aborted",
      errorMessage: "aborted by test",
    };
    const abort = () => {
      onAbort();
      stream.push({ type: "error", reason: "aborted", error: abortedMessage });
    };

    stream.push({ type: "start", partial: message });
    if (options?.signal?.aborted) {
      abort();
    } else {
      options?.signal?.addEventListener("abort", abort, { once: true });
    }

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
  (
    toolCall: ToolCall,
    options: { deltas?: string[]; waitBeforeEnd?: Promise<unknown> } = {},
  ): StreamFn =>
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

    void (async () => {
      stream.push({ type: "start", partial: cloneAssistantMessage(startMessage) });
      stream.push({
        type: "toolcall_start",
        contentIndex: 0,
        partial: cloneAssistantMessage(partialMessage),
      });

      for (const delta of options.deltas ?? []) {
        partialToolCall.partialJson = `${partialToolCall.partialJson}${delta}`;
        partialToolCall.arguments = parseStreamingJson(partialToolCall.partialJson);
        stream.push({
          type: "toolcall_delta",
          contentIndex: 0,
          delta,
          partial: cloneAssistantMessage(partialMessage),
        });
      }

      await options.waitBeforeEnd;
      stream.push({
        type: "toolcall_end",
        contentIndex: 0,
        toolCall,
        partial: cloneAssistantMessage(finalMessage),
      });
      stream.push({ type: "done", reason: "toolUse", message: finalMessage });
    })();

    return stream;
  };

const commandEchoWorkflow = defineWorkflow(
  { name: "pi-harness-command-echo", schema: z.object({ profileName: z.string() }) },
  async (_event, step) => {
    const commandEvent = await step.waitForEvent("command", { type: "command" });
    const command = piSessionCommandPayloadSchema.parse(commandEvent.payload);

    return {
      kind: command.kind,
      text: command.kind === "prompt" ? command.input.text : null,
    };
  },
);

describe("Pi harness workflow scenarios", () => {
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

  test("runs one interactive chat prompt through AgentHarness and persists workflow transcript", async () => {
    const observedSystemPrompts: string[] = [];
    const resolveOptions = vi.fn(() => ({
      systemPrompt: "You are resolved for this session.",
      model: mockModel,
      models: createModelsForStreamFn(mockModel, (_model, context) => {
        observedSystemPrompts.push(context.systemPrompt ?? "");
        return createTextStreamFn("hello from harness")();
      }),
    }));
    const interactiveChatWorkflow = createInteractiveChatWorkflow({ options: resolveOptions });
    const config: PiFragmentConfig = {
      workflows: [interactiveChatWorkflow],
    };

    await runScenario(
      defineScenario({
        name: "pi-harness-interactive-chat-prompt",
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
                path: { workflowName: interactiveChatWorkflow.name },
                body: {
                  name: "Scenario Session",
                  metadata: { runtime: "default" },
                  input: {},
                },
              });
              assert(session && !Array.isArray(session), "expected session response");
              return session.id;
            },
            storeAs: "sessionId",
          }),
          runners.agent.runUntilIdle({
            workflow: interactiveChatWorkflow.name,
            instanceId: (ctx) => ctx.vars.sessionId!,
            reason: "create",
          }),
          workflow.read({
            read: async (ctx) => {
              assert(ctx.vars.sessionId, "session id should be set");
              return await clients.user.useCommandSession.mutateQuery({
                path: { workflowName: interactiveChatWorkflow.name, sessionId: ctx.vars.sessionId },
                body: { kind: "prompt", input: { text: "hello harness" } },
              });
            },
            assert: (ack) => {
              assert(ack && !Array.isArray(ack), "expected command acknowledgement");
              assert(ack.accepted);
            },
          }),
          runners.agent.runUntilIdle({
            workflow: interactiveChatWorkflow.name,
            instanceId: (ctx) => ctx.vars.sessionId!,
            reason: "event",
          }),
          workflow.read({
            read: async (ctx) => ({
              status: await ctx.state.getStatus(
                interactiveChatWorkflow.name,
                ctx.vars.sessionId ?? "",
              ),
              steps: await ctx.state.getSteps(
                interactiveChatWorkflow.name,
                ctx.vars.sessionId ?? "",
              ),
              detail: await clients.user.useSessionDetail.query({
                path: {
                  workflowName: interactiveChatWorkflow.name,
                  sessionId: ctx.vars.sessionId!,
                },
              }),
            }),
            assert: ({ status, steps, detail }) => {
              assert(status.status === "waiting");
              expect(resolveOptions).toHaveBeenCalledWith(
                expect.objectContaining({
                  instanceId: expect.any(String),
                  payload: { metadata: { runtime: "default" } },
                }),
              );
              expect(observedSystemPrompts).toEqual(["You are resolved for this session."]);
              expect(steps).not.toContainEqual(
                expect.objectContaining({
                  name: "resolve-harnesses",
                  type: "do",
                }),
              );
              expect(steps).toContainEqual(
                expect.objectContaining({
                  name: expect.stringMatching(/^command:/),
                  status: "completed",
                  type: "do",
                }),
              );
              assert(detail && !Array.isArray(detail), "expected session detail response");
              expect(detail.agent.state.messages).toMatchObject([
                { role: "user" },
                { role: "assistant", stopReason: "stop" },
              ]);
              expect(detail.agent.state.messages[0]).toMatchObject({
                role: "user",
                content: [{ type: "text", text: "hello harness" }],
              });
              expect(detail.agent.state.messages[1]).toMatchObject({
                role: "assistant",
                content: [{ type: "text", text: "hello from harness" }],
              });
            },
          }),
        ],
      }),
    );
  });

  test("marks an interactive chat workflow errored when resolving options throws", async () => {
    const resolveOptions = vi.fn(() => {
      throw new Error("RESOLVE_OPTIONS_FAILED");
    });
    const interactiveChatWorkflow = createInteractiveChatWorkflow({
      name: "interactive-chat-resolve-throws-workflow",
      options: resolveOptions,
    });
    const config: PiFragmentConfig = { workflows: [interactiveChatWorkflow] };

    await runScenario(
      defineScenario({
        name: "pi-harness-interactive-chat-resolve-throws",
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
                path: { workflowName: interactiveChatWorkflow.name },
                body: {
                  name: "Resolve Throws Session",
                  metadata: { runtime: "default" },
                  input: {},
                },
              });
              assert(session && !Array.isArray(session), "expected session response");
              return session.id;
            },
            storeAs: "sessionId",
          }),
          runners.agent.runUntilIdle({
            workflow: interactiveChatWorkflow.name,
            instanceId: (ctx) => ctx.vars.sessionId!,
            reason: "create",
          }),
          workflow.read({
            read: async (ctx) => ({
              status: await ctx.state.getStatus(
                interactiveChatWorkflow.name,
                ctx.vars.sessionId ?? "",
              ),
              steps: await ctx.state.getSteps(
                interactiveChatWorkflow.name,
                ctx.vars.sessionId ?? "",
              ),
              detail: await clients.user.useSessionDetail.query({
                path: {
                  workflowName: interactiveChatWorkflow.name,
                  sessionId: ctx.vars.sessionId!,
                },
              }),
            }),
            assert: ({ status, steps, detail }) => {
              expect(resolveOptions).toHaveBeenCalledWith(
                expect.objectContaining({
                  instanceId: expect.any(String),
                  payload: { metadata: { runtime: "default" } },
                }),
              );
              expect(status).toMatchObject({
                status: "errored",
                error: { name: "Error", message: "RESOLVE_OPTIONS_FAILED" },
              });
              expect(steps).not.toContainEqual(
                expect.objectContaining({
                  name: "resolve-harnesses",
                  type: "do",
                }),
              );
              assert(detail && !Array.isArray(detail), "expected session detail response");
              expect(detail.workflow).toMatchObject({
                status: "errored",
                error: { name: "Error", message: "RESOLVE_OPTIONS_FAILED" },
              });
              expect(detail.agent.state.messages).toEqual([]);
            },
          }),
        ],
      }),
    );
  });

  test("aborts an in-flight AgentHarness prompt", async () => {
    const abortObserved = vi.fn();
    const interactiveChatWorkflow = createInteractiveChatWorkflow({
      name: "interactive-chat-abort-workflow",
      options: {
        systemPrompt: "You are helpful.",
        model: mockModel,
        models: createModelsForStreamFn(mockModel, createAbortableStreamFn(abortObserved)),
      },
    });
    const config: PiFragmentConfig = { workflows: [interactiveChatWorkflow] };

    await runScenario(
      defineScenario({
        name: "pi-harness-interactive-chat-abort",
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
        steps: ({ workflow, runners, concurrent, clients }) => [
          workflow.read({
            read: async () => {
              const session = await clients.user.useCreateSession.mutateQuery({
                path: { workflowName: interactiveChatWorkflow.name },
                body: { name: "Abort Session", input: { profileName: "default" } },
              });
              assert(session && !Array.isArray(session), "expected session response");
              return session.id;
            },
            storeAs: "sessionId",
          }),
          runners.agent.runUntilIdle({
            workflow: interactiveChatWorkflow.name,
            instanceId: (ctx) => ctx.vars.sessionId!,
            reason: "create",
          }),
          workflow.read({
            read: async (ctx) => {
              assert(ctx.vars.sessionId, "session id should be set");
              return await clients.user.useCommandSession.mutateQuery({
                path: { workflowName: interactiveChatWorkflow.name, sessionId: ctx.vars.sessionId },
                body: { kind: "prompt", input: { text: "please abort" } },
              });
            },
          }),
          concurrent({
            agent: [
              runners.agent.runUntilIdle({
                workflow: interactiveChatWorkflow.name,
                instanceId: (ctx) => ctx.vars.sessionId!,
                reason: "event",
              }),
            ],
            user: [
              runners.user.waitForEmission({
                workflow: interactiveChatWorkflow.name,
                instanceId: (ctx) => ctx.vars.sessionId!,
                match: (emission) => {
                  const payload = emission.payload;
                  if (
                    typeof payload !== "object" ||
                    payload === null ||
                    !("kind" in payload) ||
                    payload.kind !== "harness-event" ||
                    !("event" in payload)
                  ) {
                    return false;
                  }
                  const event = payload.event as AgentEvent;
                  return event.type === "message_start" && event.message.role === "assistant";
                },
              }),
              workflow.read({
                read: async (ctx) => {
                  assert(ctx.vars.sessionId, "session id should be set");
                  return await clients.user.useCommandSession.mutateQuery({
                    path: {
                      workflowName: interactiveChatWorkflow.name,
                      sessionId: ctx.vars.sessionId,
                    },
                    body: { kind: "abort", reason: "test" },
                  });
                },
              }),
            ],
          }),
          workflow.read({
            read: async (ctx) =>
              clients.user.useSessionDetail.query({
                path: {
                  workflowName: interactiveChatWorkflow.name,
                  sessionId: ctx.vars.sessionId!,
                },
              }),
            assert: (detail) => {
              assert(detail && !Array.isArray(detail), "expected session detail response");
              expect(abortObserved).toHaveBeenCalledTimes(1);
              expect(detail.agent.state.messages).toContainEqual(
                expect.objectContaining({ role: "assistant", stopReason: "aborted" }),
              );
            },
          }),
        ],
      }),
    );
  });

  test("executes a direct tool through AgentHarness and commits the tool result", async () => {
    const classifyTool = definePiTool({
      name: "classify",
      label: "Classify",
      description: "Classify a request.",
      parameters: Type.Object({ request: Type.String() }),
      async execute(_toolCallId, params) {
        return {
          content: [{ type: "text", text: `classified:${params.request}` }],
          details: { kind: "bug" as const, confidence: 0.91 },
          terminate: true,
        };
      },
    });
    const tools: AgentTool[] = [classifyTool];
    const resolveOptions = vi.fn(() => ({
      systemPrompt: "You are helpful.",
      model: mockModel,
      models: createModelsForStreamFn(
        mockModel,
        createToolCallStreamFn({
          type: "toolCall",
          id: "call-1",
          name: "classify",
          arguments: { request: "broken" },
        }),
      ),
      tools,
    }));
    const interactiveChatWorkflow = createInteractiveChatWorkflow({
      name: "interactive-chat-tool-workflow",
      options: resolveOptions,
    });
    const config: PiFragmentConfig = { workflows: [interactiveChatWorkflow] };

    await runScenario(
      defineScenario({
        name: "pi-harness-interactive-chat-tool",
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
                path: { workflowName: interactiveChatWorkflow.name },
                body: {
                  name: "Tool Session",
                  metadata: { runtime: "default" },
                  input: {},
                },
              });
              assert(session && !Array.isArray(session), "expected session response");
              return session.id;
            },
            storeAs: "sessionId",
          }),
          runners.agent.runUntilIdle({
            workflow: interactiveChatWorkflow.name,
            instanceId: (ctx) => ctx.vars.sessionId!,
            reason: "create",
          }),
          workflow.read({
            read: async (ctx) => {
              assert(ctx.vars.sessionId, "session id should be set");
              return await clients.user.useCommandSession.mutateQuery({
                path: { workflowName: interactiveChatWorkflow.name, sessionId: ctx.vars.sessionId },
                body: { kind: "prompt", input: { text: "classify this" } },
              });
            },
          }),
          runners.agent.runUntilIdle({
            workflow: interactiveChatWorkflow.name,
            instanceId: (ctx) => ctx.vars.sessionId!,
            reason: "event",
          }),
          workflow.read({
            read: async (ctx) =>
              clients.user.useSessionDetail.query({
                path: {
                  workflowName: interactiveChatWorkflow.name,
                  sessionId: ctx.vars.sessionId!,
                },
              }),
            assert: (detail) => {
              assert(detail && !Array.isArray(detail), "expected session detail response");
              expect(detail.agent.state.messages).toMatchObject([
                { role: "user" },
                { role: "assistant", stopReason: "toolUse" },
                { role: "toolResult", toolCallId: "call-1", toolName: "classify" },
              ]);
              expect(detail.agent.state.messages[2]).toMatchObject({
                role: "toolResult",
                content: [{ type: "text", text: "classified:broken" }],
                details: { kind: "bug", confidence: 0.91 },
              });
              expect(resolveOptions).toHaveBeenCalledWith(
                expect.objectContaining({
                  instanceId: expect.any(String),
                  payload: { metadata: { runtime: "default" } },
                }),
              );
            },
          }),
        ],
      }),
    );
  });
});
