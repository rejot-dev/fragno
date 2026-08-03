import { assert, describe, expect, test, vi } from "vitest";

import {
  defineScenario,
  runScenario,
  type WorkflowScenarioObservedEmission,
} from "@fragno-dev/workflows/scenario";
import { selectCanonicalWorkflowStepEmissions } from "@fragno-dev/workflows/step-emission-control";
import { Type } from "typebox";

import { instantiate } from "@fragno-dev/core";

import {
  formatSkillsForSystemPrompt,
  type AgentEvent,
  type AgentHarnessEvent,
  type AgentMessage,
  type AgentTool,
  type Skill,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Message,
  type Model,
  type ToolCall,
} from "@earendil-works/pi-ai";

import { createPiFragmentClients } from "../../client/clients";
import { piRoutesFactory } from "../../routes";
import { piHarnessDefinition } from "../definition";
import { createPiWorkflows } from "../factory";
import { createModelsForStreamFn } from "../harness/test-models";
import { definePiTool } from "../tools";
import { MAX_PI_COMMAND_IMAGE_DATA_LENGTH, type PiFragmentConfig } from "../types";
import { createInteractiveChatWorkflow } from "./interactive-chat-workflow";

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

const createGatedTextStreamFn =
  (text: string, completionGate: Promise<void>): StreamFn =>
  () => {
    const stream = createAssistantMessageEventStream();
    const message = createAssistantMessage(text);

    stream.push({ type: "start", partial: message });
    void (async () => {
      await completionGate;
      stream.push({ type: "text_start", contentIndex: 0, partial: message });
      stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
      stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
      stream.push({ type: "done", reason: "stop", message });
    })();

    return stream;
  };

const modelMessageText = (message: Message): string =>
  typeof message.content === "string"
    ? message.content
    : message.content
        .flatMap((content) => (content.type === "text" ? [content.text] : []))
        .join("");

const agentMessageText = (message: AgentMessage): string => {
  if (message.role !== "user" && message.role !== "assistant") {
    return "";
  }

  return typeof message.content === "string"
    ? message.content
    : message.content
        .flatMap((content) => (content.type === "text" ? [content.text] : []))
        .join("");
};

const harnessEventFromEmission = (emission: {
  payload: unknown;
}): AgentHarnessEvent | undefined => {
  const payload = emission.payload;
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("kind" in payload) ||
    payload.kind !== "harness-event" ||
    !("event" in payload)
  ) {
    return undefined;
  }

  return payload.event as AgentHarnessEvent;
};

const createCompletionGate = (): { promise: Promise<void>; release: () => void } => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};

const matchesHarnessMessage = (
  emission: WorkflowScenarioObservedEmission,
  type: "message_start" | "message_end",
  role: "user" | "assistant",
  text: string,
): boolean => {
  const event = harnessEventFromEmission(emission);
  return (
    event?.type === type && event.message.role === role && agentMessageText(event.message) === text
  );
};

const matchesControlQueue = (
  emission: WorkflowScenarioObservedEmission,
  queue: "steer" | "followUp",
  expectedTexts: readonly string[],
): boolean => {
  const event = harnessEventFromEmission(emission);
  return (
    event?.type === "queue_update" &&
    event[queue].map((message) => agentMessageText(message)).join("\n") === expectedTexts.join("\n")
  );
};

const matchesSteerQueue = (
  emission: WorkflowScenarioObservedEmission,
  expectedTexts: readonly string[],
): boolean => matchesControlQueue(emission, "steer", expectedTexts);

const matchesToolExecutionStart = (
  emission: WorkflowScenarioObservedEmission,
  toolName: string,
): boolean => {
  const event = harnessEventFromEmission(emission);
  return event?.type === "tool_execution_start" && event.toolName === toolName;
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

describe("Interactive chat workflow scenarios", () => {
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
              expect(resolveOptions).toHaveBeenCalledWith({
                payload: { metadata: { runtime: "default" } },
                instanceId: expect.any(String),
                timestamp: expect.any(Date),
              });
              expect(observedSystemPrompts).toEqual(["You are resolved for this session."]);
              expect(steps).not.toContainEqual(
                expect.objectContaining({
                  name: "resolve-options",
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

  test("invokes skills and prompt templates with reconstructed AgentHarness resources", async () => {
    const skill: Skill = {
      name: "fragno",
      description: "Use for durable Fragno workflow changes.",
      content: "Always preserve workflow session state.",
      filePath: "/skills/fragno/SKILL.md",
    };
    const promptTemplate = {
      name: "review",
      description: "Review a durable workflow change.",
      content: "Review $1 for durable workflow behavior.",
    };
    const observedResourceSkills: Array<Array<Pick<Skill, "name" | "content" | "filePath">>> = [];
    const observedSystemPrompts: string[] = [];
    const observedPrompts: string[] = [];
    const interactiveChatWorkflow = createInteractiveChatWorkflow({
      name: "interactive-chat-skill-resources-workflow",
      options: {
        resources: { skills: [skill], promptTemplates: [promptTemplate] },
        systemPrompt: ({ resources }) => {
          observedResourceSkills.push(
            (resources.skills ?? []).map((resourceSkill) => ({
              name: resourceSkill.name,
              content: resourceSkill.content,
              filePath: resourceSkill.filePath,
            })),
          );
          return formatSkillsForSystemPrompt(resources.skills ?? []);
        },
        model: mockModel,
        models: createModelsForStreamFn(mockModel, (_model, context) => {
          observedSystemPrompts.push(context.systemPrompt ?? "");
          observedPrompts.push(modelMessageText(context.messages.at(-1)!));
          return createTextStreamFn("resource command complete")();
        }),
      },
    });
    const config: PiFragmentConfig = { workflows: [interactiveChatWorkflow] };

    await runScenario(
      defineScenario({
        name: "pi-harness-interactive-chat-skill-resources",
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
                body: { name: "Skill Resources Session", input: { profileName: "default" } },
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
                body: {
                  kind: "skill",
                  input: {
                    name: "fragno",
                    additionalInstructions: "Apply it to the workflow adapter.",
                  },
                },
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
              clients.user.useCommandSession.mutateQuery({
                path: {
                  workflowName: interactiveChatWorkflow.name,
                  sessionId: ctx.vars.sessionId!,
                },
                body: {
                  kind: "promptFromTemplate",
                  input: { name: "review", args: ["the workflow adapter"] },
                },
              }),
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
              expect(observedResourceSkills.length).toBeGreaterThan(0);
              for (const resourceSkills of observedResourceSkills) {
                expect(resourceSkills).toEqual([
                  {
                    name: "fragno",
                    content: "Always preserve workflow session state.",
                    filePath: "/skills/fragno/SKILL.md",
                  },
                ]);
              }
              expect(observedSystemPrompts).toHaveLength(2);
              for (const systemPrompt of observedSystemPrompts) {
                expect(systemPrompt).toContain("<name>fragno</name>");
                expect(systemPrompt).toContain("<location>/skills/fragno/SKILL.md</location>");
              }
              expect(observedPrompts[0]).toContain('<skill name="fragno"');
              expect(observedPrompts[0]).toContain("Always preserve workflow session state.");
              expect(observedPrompts[0]).toContain("Apply it to the workflow adapter.");
              assert(
                observedPrompts[1] === "Review the workflow adapter for durable workflow behavior.",
              );
              assert(detail && !Array.isArray(detail), "expected session detail response");
              expect(detail.agent.state.messages).toMatchObject([
                { role: "user" },
                {
                  role: "assistant",
                  content: [{ type: "text", text: "resource command complete" }],
                },
                { role: "user" },
                {
                  role: "assistant",
                  content: [{ type: "text", text: "resource command complete" }],
                },
              ]);
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
              expect(resolveOptions).toHaveBeenCalledWith({
                payload: { metadata: { runtime: "default" } },
                instanceId: expect.any(String),
                timestamp: expect.any(Date),
              });
              expect(status).toMatchObject({
                status: "errored",
                error: { name: "Error", message: "RESOLVE_OPTIONS_FAILED" },
              });
              expect(steps).not.toContainEqual(
                expect.objectContaining({
                  name: "resolve-options",
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

  test("steers an in-flight AgentHarness prompt and includes the steering message in the next model turn", async () => {
    let releaseFirstResponse: () => void = () => {
      throw new Error("FIRST_RESPONSE_GATE_NOT_INITIALIZED");
    };
    const firstResponseCompletionGate = new Promise<void>((resolve) => {
      releaseFirstResponse = resolve;
    });
    const observedModelContexts: Array<Array<{ role: Message["role"]; text: string }>> = [];
    let modelRequestIndex = 0;
    const interactiveChatWorkflow = createInteractiveChatWorkflow({
      name: "interactive-chat-steer-workflow",
      options: {
        systemPrompt: "You are helpful.",
        model: mockModel,
        models: createModelsForStreamFn(mockModel, (_model, context) => {
          observedModelContexts.push(
            context.messages.map((message) => ({
              role: message.role,
              text: modelMessageText(message),
            })),
          );
          const requestIndex = modelRequestIndex;
          modelRequestIndex += 1;
          return requestIndex === 0
            ? createGatedTextStreamFn("initial response", firstResponseCompletionGate)(
                _model,
                context,
              )
            : createTextStreamFn("steered response")();
        }),
      },
    });
    const config: PiFragmentConfig = { workflows: [interactiveChatWorkflow] };

    await runScenario(
      defineScenario({
        name: "pi-harness-interactive-chat-steer",
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
        steps: ({ workflow, runners, concurrent, clients }) => [
          workflow.read({
            read: async () => {
              const session = await clients.user.useCreateSession.mutateQuery({
                path: { workflowName: interactiveChatWorkflow.name },
                body: { name: "Steer Session", input: { profileName: "default" } },
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
                body: { kind: "prompt", input: { text: "write an implementation plan" } },
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
                    body: { kind: "steer", input: { text: "focus on the tests first" } },
                  });
                },
              }),
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
                  const event = payload.event as AgentHarnessEvent;
                  return (
                    event.type === "queue_update" &&
                    event.steer.some(
                      (message) =>
                        message.role === "user" &&
                        (typeof message.content === "string"
                          ? message.content === "focus on the tests first"
                          : message.content.some(
                              (content) =>
                                content.type === "text" &&
                                content.text === "focus on the tests first",
                            )),
                    )
                  );
                },
              }),
              workflow.read({
                read: async () => {
                  releaseFirstResponse();
                },
              }),
            ],
          }),
          workflow.read({
            read: async (ctx) => ({
              detail: await clients.user.useSessionDetail.query({
                path: {
                  workflowName: interactiveChatWorkflow.name,
                  sessionId: ctx.vars.sessionId!,
                },
              }),
              steps: await ctx.state.getSteps(
                interactiveChatWorkflow.name,
                ctx.vars.sessionId ?? "",
              ),
            }),
            assert: ({ detail, steps }) => {
              assert(detail && !Array.isArray(detail), "expected session detail response");
              expect(observedModelContexts).toEqual([
                [{ role: "user", text: "write an implementation plan" }],
                [
                  { role: "user", text: "write an implementation plan" },
                  { role: "assistant", text: "initial response" },
                  { role: "user", text: "focus on the tests first" },
                ],
              ]);
              expect(detail.agent.state.messages).toMatchObject([
                {
                  role: "user",
                  content: [{ type: "text", text: "write an implementation plan" }],
                },
                {
                  role: "assistant",
                  content: [{ type: "text", text: "initial response" }],
                },
                {
                  role: "user",
                  content: [{ type: "text", text: "focus on the tests first" }],
                },
                {
                  role: "assistant",
                  content: [{ type: "text", text: "steered response" }],
                },
              ]);
              expect(
                steps.filter((step) => step.type === "do" && step.name.startsWith("command:")),
              ).toHaveLength(1);
            },
          }),
        ],
      }),
    );
  });

  test("applies followUp during an active operation", async () => {
    const initialResponse = createCompletionGate();
    const followUpText = "add migration tests";
    const observedModelContexts: Array<Array<{ role: Message["role"]; text: string }>> = [];
    let providerCallIndex = 0;
    const interactiveChatWorkflow = createInteractiveChatWorkflow({
      name: "interactive-chat-active-follow-up",
      options: {
        systemPrompt: "You are helpful.",
        model: mockModel,
        models: createModelsForStreamFn(mockModel, (model, context, options) => {
          observedModelContexts.push(
            context.messages.map((message) => ({
              role: message.role,
              text: modelMessageText(message),
            })),
          );
          const requestIndex = providerCallIndex;
          providerCallIndex += 1;
          if (requestIndex === 0) {
            return createGatedTextStreamFn("initial response", initialResponse.promise)(
              model,
              context,
              options,
            );
          }
          if (requestIndex === 1) {
            return createTextStreamFn("response after follow-up")();
          }
          throw new Error(`UNEXPECTED_PROVIDER_CALL:${requestIndex}`);
        }),
      },
    });
    const config: PiFragmentConfig = { workflows: [interactiveChatWorkflow] };

    await runScenario(
      defineScenario({
        name: "pi-harness-interactive-chat-active-follow-up",
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
        steps: ({ workflow, runners, concurrent, clients }) => [
          workflow.read({
            read: async () => {
              const session = await clients.user.useCreateSession.mutateQuery({
                path: { workflowName: interactiveChatWorkflow.name },
                body: { name: "Active Follow-up", input: { profileName: "default" } },
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
            read: async (ctx) =>
              clients.user.useCommandSession.mutateQuery({
                path: {
                  workflowName: interactiveChatWorkflow.name,
                  sessionId: ctx.vars.sessionId!,
                },
                body: { kind: "prompt", input: { text: "draft the migration" } },
              }),
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
                match: (emission) =>
                  matchesHarnessMessage(emission, "message_start", "assistant", "initial response"),
              }),
              workflow.read({
                read: async (ctx) =>
                  clients.user.useCommandSession.mutateQuery({
                    path: {
                      workflowName: interactiveChatWorkflow.name,
                      sessionId: ctx.vars.sessionId!,
                    },
                    body: { kind: "followUp", input: { text: followUpText } },
                  }),
              }),
              runners.user.waitForEmission({
                workflow: interactiveChatWorkflow.name,
                instanceId: (ctx) => ctx.vars.sessionId!,
                match: (emission) => matchesControlQueue(emission, "followUp", [followUpText]),
              }),
              workflow.read({
                read: async () => {
                  initialResponse.release();
                },
              }),
            ],
          }),
          workflow.read({
            read: async (ctx) => ({
              status: await ctx.state.getStatus(interactiveChatWorkflow.name, ctx.vars.sessionId!),
              detail: await clients.user.useSessionDetail.query({
                path: {
                  workflowName: interactiveChatWorkflow.name,
                  sessionId: ctx.vars.sessionId!,
                },
              }),
            }),
            assert: ({ status, detail }) => {
              expect(status).toMatchObject({ status: "waiting" });
              assert(detail && !Array.isArray(detail), "expected session detail response");
              expect(observedModelContexts).toEqual([
                [{ role: "user", text: "draft the migration" }],
                [
                  { role: "user", text: "draft the migration" },
                  { role: "assistant", text: "initial response" },
                  { role: "user", text: followUpText },
                ],
              ]);
              expect(detail.agent.state.messages.map((message) => message.role)).toEqual([
                "user",
                "assistant",
                "user",
                "assistant",
              ]);
            },
          }),
        ],
      }),
    );
  });

  test("applies a steer that is already queued when the prompt operation starts", async () => {
    const initialResponse = createCompletionGate();
    const observedModelContexts: Array<Array<{ role: Message["role"]; text: string }>> = [];
    let modelRequestIndex = 0;
    const interactiveChatWorkflow = createInteractiveChatWorkflow({
      name: "interactive-chat-prequeued-steer-workflow",
      options: {
        systemPrompt: "You are helpful.",
        model: mockModel,
        models: createModelsForStreamFn(mockModel, (_model, context) => {
          observedModelContexts.push(
            context.messages.map((message) => ({
              role: message.role,
              text: modelMessageText(message),
            })),
          );
          const requestIndex = modelRequestIndex;
          modelRequestIndex += 1;
          return requestIndex === 0
            ? createGatedTextStreamFn("initial response", initialResponse.promise)(_model, context)
            : createTextStreamFn("response after queued steer")();
        }),
      },
    });
    const config: PiFragmentConfig = { workflows: [interactiveChatWorkflow] };

    await runScenario(
      defineScenario({
        name: "pi-harness-interactive-chat-prequeued-steer",
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
        steps: ({ workflow, runners, concurrent, clients }) => [
          workflow.read({
            read: async () => {
              const session = await clients.user.useCreateSession.mutateQuery({
                path: { workflowName: interactiveChatWorkflow.name },
                body: { name: "Prequeued Steer", input: { profileName: "default" } },
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
              const path = {
                workflowName: interactiveChatWorkflow.name,
                sessionId: ctx.vars.sessionId!,
              };
              await clients.user.useCommandSession.mutateQuery({
                path,
                body: { kind: "prompt", input: { text: "write the migration" } },
              });
              return await clients.user.useCommandSession.mutateQuery({
                path,
                body: { kind: "steer", input: { text: "preserve compatibility" } },
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
                match: (emission) => matchesSteerQueue(emission, ["preserve compatibility"]),
              }),
              workflow.read({
                read: async () => {
                  initialResponse.release();
                },
              }),
            ],
          }),
          workflow.read({
            read: async (ctx) => ({
              status: await ctx.state.getStatus(interactiveChatWorkflow.name, ctx.vars.sessionId!),
              detail: await clients.user.useSessionDetail.query({
                path: {
                  workflowName: interactiveChatWorkflow.name,
                  sessionId: ctx.vars.sessionId!,
                },
              }),
            }),
            assert: ({ status, detail }) => {
              expect(status).toMatchObject({ status: "waiting" });
              expect(observedModelContexts).toEqual([
                [{ role: "user", text: "write the migration" }],
                [
                  { role: "user", text: "write the migration" },
                  { role: "assistant", text: "initial response" },
                  { role: "user", text: "preserve compatibility" },
                ],
              ]);
              assert(detail && !Array.isArray(detail), "expected session detail response");
              expect(detail.agent.state.messages.map((message) => message.role)).toEqual([
                "user",
                "assistant",
                "user",
                "assistant",
              ]);
            },
          }),
        ],
      }),
    );
  });

  const runSteeringRecoveryScenario = async (
    restartAfter: "queued" | "steering-message",
  ): Promise<void> => {
    const originalFirstResponse = createCompletionGate();
    const interruptedSecondResponse = createCompletionGate();
    const recoveryFirstResponse = createCompletionGate();
    const recoveryFirstRequestIndex = restartAfter === "queued" ? 1 : 2;
    const observedModelContexts: Array<Array<{ role: Message["role"]; text: string }>> = [];
    let providerCallIndex = 0;
    const interactiveChatWorkflow = createInteractiveChatWorkflow({
      name: `interactive-chat-steer-recovery-${restartAfter}`,
      options: {
        systemPrompt: "You are helpful.",
        model: mockModel,
        models: createModelsForStreamFn(mockModel, (_model, context) => {
          observedModelContexts.push(
            context.messages.map((message) => ({
              role: message.role,
              text: modelMessageText(message),
            })),
          );
          const requestIndex = providerCallIndex;
          providerCallIndex += 1;

          if (requestIndex === 0) {
            return createGatedTextStreamFn(
              "discarded initial response",
              originalFirstResponse.promise,
            )(_model, context);
          }
          if (restartAfter === "steering-message" && requestIndex === 1) {
            return createGatedTextStreamFn(
              "discarded steered response",
              interruptedSecondResponse.promise,
            )(_model, context);
          }
          if (requestIndex === recoveryFirstRequestIndex) {
            return createGatedTextStreamFn(
              "recovered initial response",
              recoveryFirstResponse.promise,
            )(_model, context);
          }
          if (requestIndex === recoveryFirstRequestIndex + 1) {
            return createTextStreamFn("recovered steered response")();
          }

          throw new Error(`UNEXPECTED_PROVIDER_CALL:${requestIndex}`);
        }),
      },
    });
    const config: PiFragmentConfig = { workflows: [interactiveChatWorkflow] };

    await runScenario(
      defineScenario({
        name: `pi-harness-interactive-chat-steer-recovery-${restartAfter}`,
        workflows: createPiWorkflows({ workflows: config.workflows }),
        vars: () => ({
          sessionId: undefined as string | undefined,
          firstQueueUpdate: undefined as WorkflowScenarioObservedEmission | undefined,
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
          observer: createPiFragmentClients(clientConfig("pi", { runner: "observer" })),
        }),
        runners: ["agent", "recovery", "observer"],
        steps: ({ workflow, runners, concurrent, clients }) => {
          const stepsBeforeRestart =
            restartAfter === "queued"
              ? []
              : [
                  workflow.read({
                    read: async () => {
                      originalFirstResponse.release();
                    },
                  }),
                  runners.observer.waitForEmission({
                    workflow: interactiveChatWorkflow.name,
                    instanceId: (ctx) => ctx.vars.sessionId!,
                    match: (emission) =>
                      matchesHarnessMessage(
                        emission,
                        "message_start",
                        "assistant",
                        "discarded steered response",
                      ),
                  }),
                ];

          return [
            workflow.read({
              read: async () => {
                const session = await clients.observer.useCreateSession.mutateQuery({
                  path: { workflowName: interactiveChatWorkflow.name },
                  body: { name: "Steer Recovery Session", input: { profileName: "default" } },
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
              read: async (ctx) =>
                clients.observer.useCommandSession.mutateQuery({
                  path: {
                    workflowName: interactiveChatWorkflow.name,
                    sessionId: ctx.vars.sessionId!,
                  },
                  body: { kind: "prompt", input: { text: "write the migration" } },
                }),
            }),
            concurrent({
              agent: [
                runners.agent.tick({
                  workflow: interactiveChatWorkflow.name,
                  instanceId: (ctx) => ctx.vars.sessionId!,
                  reason: "event",
                }),
              ],
              recovery: [
                runners.recovery.waitForControl({ key: "recover-steering" }),
                runners.recovery.tick({
                  workflow: interactiveChatWorkflow.name,
                  instanceId: (ctx) => ctx.vars.sessionId!,
                  reason: "create",
                }),
              ],
              observer: [
                runners.observer.waitForEmission({
                  workflow: interactiveChatWorkflow.name,
                  instanceId: (ctx) => ctx.vars.sessionId!,
                  match: (emission) =>
                    matchesHarnessMessage(
                      emission,
                      "message_start",
                      "assistant",
                      "discarded initial response",
                    ),
                }),
                workflow.read({
                  read: async (ctx) =>
                    clients.observer.useCommandSession.mutateQuery({
                      path: {
                        workflowName: interactiveChatWorkflow.name,
                        sessionId: ctx.vars.sessionId!,
                      },
                      body: { kind: "steer", input: { text: "preserve the tests" } },
                    }),
                }),
                runners.observer.waitForEmission({
                  workflow: interactiveChatWorkflow.name,
                  instanceId: (ctx) => ctx.vars.sessionId!,
                  match: (emission) => matchesSteerQueue(emission, ["preserve the tests"]),
                  storeAs: "firstQueueUpdate",
                }),
                ...stepsBeforeRestart,
                runners.observer.restart(),
                runners.observer.resolveControl({ key: "recover-steering" }),
                runners.observer.waitForEmission({
                  workflow: interactiveChatWorkflow.name,
                  instanceId: (ctx) => ctx.vars.sessionId!,
                  match: (emission) =>
                    matchesHarnessMessage(
                      emission,
                      "message_start",
                      "assistant",
                      "recovered initial response",
                    ),
                }),
                workflow.read({
                  read: async () => {
                    originalFirstResponse.release();
                    interruptedSecondResponse.release();
                  },
                }),
                runners.observer.waitForEmission({
                  workflow: interactiveChatWorkflow.name,
                  instanceId: (ctx) => ctx.vars.sessionId!,
                  match: (emission, ctx) =>
                    emission.id !== ctx.vars.firstQueueUpdate?.id &&
                    matchesSteerQueue(emission, ["preserve the tests"]),
                }),
                workflow.read({
                  read: async () => {
                    recoveryFirstResponse.release();
                  },
                }),
              ],
            }),
            workflow.read({
              read: async (ctx) => ({
                detail: await clients.observer.useSessionDetail.query({
                  path: {
                    workflowName: interactiveChatWorkflow.name,
                    sessionId: ctx.vars.sessionId!,
                  },
                }),
                history: await ctx.state.getHistory(
                  interactiveChatWorkflow.name,
                  ctx.vars.sessionId!,
                ),
              }),
              assert: ({ detail, history }) => {
                assert(detail && !Array.isArray(detail), "expected session detail response");
                expect(providerCallIndex).toBeGreaterThanOrEqual(3);
                assert(
                  observedModelContexts.some((context) =>
                    context.some(
                      (message) => message.role === "user" && message.text === "preserve the tests",
                    ),
                  ),
                );
                expect(detail.agent.state.messages.map((message) => message.role)).toEqual([
                  "user",
                  "assistant",
                  "user",
                  "assistant",
                ]);
                assert(agentMessageText(detail.agent.state.messages[0]!) === "write the migration");
                expect(["discarded initial response", "recovered initial response"]).toContain(
                  agentMessageText(detail.agent.state.messages[1]!),
                );
                assert(agentMessageText(detail.agent.state.messages[2]!) === "preserve the tests");
                expect(["discarded steered response", "recovered steered response"]).toContain(
                  agentMessageText(detail.agent.state.messages[3]!),
                );
                assert(
                  history.emissions.some(
                    (emission) =>
                      typeof emission.payload === "object" &&
                      emission.payload !== null &&
                      "kind" in emission.payload &&
                      emission.payload.kind === "harness-operation-complete",
                  ),
                );
                const canonicalEmissions = selectCanonicalWorkflowStepEmissions({
                  steps: history.steps,
                  emissions: history.emissions,
                });
                expect(history.emissions.length).toBeGreaterThan(canonicalEmissions.length);
              },
            }),
          ];
        },
      }),
    );
  };

  test("recovers steering after steering is queued", async () => {
    await runSteeringRecoveryScenario("queued");
  });

  test("recovers steering after the steering message is emitted", async () => {
    await runSteeringRecoveryScenario("steering-message");
  });

  test("preserves multiple steering messages in order without duplication across restart", async () => {
    const interruptedFirstResponse = createCompletionGate();
    const recoveryFirstResponse = createCompletionGate();
    const observedModelContexts: Array<Array<{ role: Message["role"]; text: string }>> = [];
    let providerCallIndex = 0;
    const interactiveChatWorkflow = createInteractiveChatWorkflow({
      name: "interactive-chat-multiple-steer-recovery",
      options: {
        systemPrompt: "You are helpful.",
        model: mockModel,
        models: createModelsForStreamFn(mockModel, (_model, context) => {
          const messages = context.messages.map((message) => ({
            role: message.role,
            text: modelMessageText(message),
          }));
          observedModelContexts.push(messages);
          const requestIndex = providerCallIndex;
          providerCallIndex += 1;
          const steeringMessages = messages.filter(
            (message) =>
              message.role === "user" &&
              (message.text === "first correction" || message.text === "second correction"),
          );

          if (steeringMessages.length === 0) {
            return createGatedTextStreamFn(
              requestIndex === 0 ? "discarded initial response" : "recovered initial response",
              requestIndex === 0 ? interruptedFirstResponse.promise : recoveryFirstResponse.promise,
            )(_model, context);
          }

          return createTextStreamFn(
            steeringMessages.at(-1)?.text === "second correction"
              ? "response after second correction"
              : "response after first correction",
          )();
        }),
      },
    });
    const config: PiFragmentConfig = { workflows: [interactiveChatWorkflow] };

    await runScenario(
      defineScenario({
        name: "pi-harness-interactive-chat-multiple-steer-recovery",
        workflows: createPiWorkflows({ workflows: config.workflows }),
        vars: () => ({
          sessionId: undefined as string | undefined,
          queuedBothSteers: undefined as WorkflowScenarioObservedEmission | undefined,
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
          observer: createPiFragmentClients(clientConfig("pi", { runner: "observer" })),
        }),
        runners: ["agent", "recovery", "observer"],
        steps: ({ workflow, runners, concurrent, clients }) => [
          workflow.read({
            read: async () => {
              const session = await clients.observer.useCreateSession.mutateQuery({
                path: { workflowName: interactiveChatWorkflow.name },
                body: { name: "Multiple Steer Recovery", input: { profileName: "default" } },
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
            read: async (ctx) =>
              clients.observer.useCommandSession.mutateQuery({
                path: {
                  workflowName: interactiveChatWorkflow.name,
                  sessionId: ctx.vars.sessionId!,
                },
                body: { kind: "prompt", input: { text: "draft the implementation" } },
              }),
          }),
          concurrent({
            agent: [
              runners.agent.tick({
                workflow: interactiveChatWorkflow.name,
                instanceId: (ctx) => ctx.vars.sessionId!,
                reason: "event",
              }),
            ],
            recovery: [
              runners.recovery.waitForControl({ key: "recover-multiple-steering" }),
              runners.recovery.tick({
                workflow: interactiveChatWorkflow.name,
                instanceId: (ctx) => ctx.vars.sessionId!,
                reason: "create",
              }),
            ],
            observer: [
              runners.observer.waitForEmission({
                workflow: interactiveChatWorkflow.name,
                instanceId: (ctx) => ctx.vars.sessionId!,
                match: (emission) =>
                  matchesHarnessMessage(
                    emission,
                    "message_start",
                    "assistant",
                    "discarded initial response",
                  ),
              }),
              workflow.read({
                read: async (ctx) =>
                  clients.observer.useCommandSession.mutateQuery({
                    path: {
                      workflowName: interactiveChatWorkflow.name,
                      sessionId: ctx.vars.sessionId!,
                    },
                    body: { kind: "steer", input: { text: "first correction" } },
                  }),
              }),
              runners.observer.waitForEmission({
                workflow: interactiveChatWorkflow.name,
                instanceId: (ctx) => ctx.vars.sessionId!,
                match: (emission) => matchesSteerQueue(emission, ["first correction"]),
              }),
              workflow.read({
                read: async (ctx) =>
                  clients.observer.useCommandSession.mutateQuery({
                    path: {
                      workflowName: interactiveChatWorkflow.name,
                      sessionId: ctx.vars.sessionId!,
                    },
                    body: { kind: "steer", input: { text: "second correction" } },
                  }),
              }),
              runners.observer.waitForEmission({
                workflow: interactiveChatWorkflow.name,
                instanceId: (ctx) => ctx.vars.sessionId!,
                match: (emission) =>
                  matchesSteerQueue(emission, ["first correction", "second correction"]),
                storeAs: "queuedBothSteers",
              }),
              runners.observer.restart(),
              runners.observer.resolveControl({ key: "recover-multiple-steering" }),
              runners.observer.waitForEmission({
                workflow: interactiveChatWorkflow.name,
                instanceId: (ctx) => ctx.vars.sessionId!,
                match: (emission) =>
                  matchesHarnessMessage(
                    emission,
                    "message_start",
                    "assistant",
                    "recovered initial response",
                  ),
              }),
              workflow.read({
                read: async () => {
                  interruptedFirstResponse.release();
                },
              }),
              runners.observer.waitForEmission({
                workflow: interactiveChatWorkflow.name,
                instanceId: (ctx) => ctx.vars.sessionId!,
                match: (emission, ctx) =>
                  emission.id !== ctx.vars.queuedBothSteers?.id &&
                  matchesSteerQueue(emission, ["first correction", "second correction"]),
              }),
              workflow.read({
                read: async () => {
                  recoveryFirstResponse.release();
                },
              }),
            ],
          }),
          workflow.read({
            read: async (ctx) =>
              clients.observer.useSessionDetail.query({
                path: {
                  workflowName: interactiveChatWorkflow.name,
                  sessionId: ctx.vars.sessionId!,
                },
              }),
            assert: (detail) => {
              assert(detail && !Array.isArray(detail), "expected session detail response");
              expect(detail.agent.state.messages.map((message) => message.role)).toEqual([
                "user",
                "assistant",
                "user",
                "assistant",
                "user",
                "assistant",
              ]);
              expect(
                detail.agent.state.messages.flatMap((message) =>
                  message.role === "user" ? [agentMessageText(message)] : [],
                ),
              ).toEqual(["draft the implementation", "first correction", "second correction"]);
              assert(
                agentMessageText(detail.agent.state.messages[3]!) ===
                  "response after first correction",
              );
              assert(
                agentMessageText(detail.agent.state.messages[5]!) ===
                  "response after second correction",
              );
              expect(
                observedModelContexts
                  .at(-1)
                  ?.filter(
                    (message) =>
                      message.role === "user" &&
                      (message.text === "first correction" || message.text === "second correction"),
                  ),
              ).toEqual([
                { role: "user", text: "first correction" },
                { role: "user", text: "second correction" },
              ]);
            },
          }),
        ],
      }),
    );
  });

  test("does not start a model turn for idle abort, steer, or followUp commands", async () => {
    const observedPrompts: string[] = [];
    const interactiveChatWorkflow = createInteractiveChatWorkflow({
      name: "interactive-chat-idle-steer",
      options: {
        systemPrompt: "You are helpful.",
        model: mockModel,
        models: createModelsForStreamFn(mockModel, (_model, context) => {
          const prompt = modelMessageText(context.messages.at(-1)!);
          observedPrompts.push(prompt);
          return createTextStreamFn(`response:${prompt}`)();
        }),
      },
    });
    const config: PiFragmentConfig = { workflows: [interactiveChatWorkflow] };

    await runScenario(
      defineScenario({
        name: "pi-harness-interactive-chat-idle-steer",
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
                body: { name: "Idle Steer", input: { profileName: "default" } },
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
              const path = {
                workflowName: interactiveChatWorkflow.name,
                sessionId: ctx.vars.sessionId!,
              };
              await clients.user.useCommandSession.mutateQuery({
                path,
                body: { kind: "abort", reason: "nothing is running" },
              });
              await clients.user.useCommandSession.mutateQuery({
                path,
                body: { kind: "steer", input: { text: "idle correction" } },
              });
              return await clients.user.useCommandSession.mutateQuery({
                path,
                body: { kind: "followUp", input: { text: "idle follow-up" } },
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
              clients.user.useCommandSession.mutateQuery({
                path: {
                  workflowName: interactiveChatWorkflow.name,
                  sessionId: ctx.vars.sessionId!,
                },
                body: { kind: "prompt", input: { text: "actual prompt" } },
              }),
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
              expect(observedPrompts).toEqual(["actual prompt"]);
              expect(detail.agent.state.messages.map((message) => message.role)).toEqual([
                "user",
                "assistant",
              ]);
              assert(agentMessageText(detail.agent.state.messages[0]!) === "actual prompt");
            },
          }),
        ],
      }),
    );
  });

  test("recovers steering after a terminal assistant emission before the operation checkpoint", async () => {
    const originalFirstResponse = createCompletionGate();
    const recoveryFirstResponse = createCompletionGate();
    const interruptedToolExecution = createCompletionGate();
    const recoveryToolExecution = createCompletionGate();
    let providerCallIndex = 0;
    let toolExecutionIndex = 0;
    const finishTool = definePiTool({
      name: "finish-steered-turn",
      label: "Finish steered turn",
      description: "Finish the steered turn after a controlled durability boundary.",
      parameters: Type.Object({}),
      async execute() {
        const executionIndex = toolExecutionIndex;
        toolExecutionIndex += 1;
        await (executionIndex === 0
          ? interruptedToolExecution.promise
          : recoveryToolExecution.promise);
        return {
          content: [{ type: "text" as const, text: `finished:${executionIndex}` }],
          details: { executionIndex },
          terminate: true,
        };
      },
    });
    const interactiveChatWorkflow = createInteractiveChatWorkflow({
      name: "interactive-chat-steer-terminal-recovery",
      options: {
        systemPrompt: "You are helpful.",
        model: mockModel,
        tools: [finishTool],
        models: createModelsForStreamFn(mockModel, (_model, context, options) => {
          const requestIndex = providerCallIndex;
          providerCallIndex += 1;
          const hasSteering = context.messages.some(
            (message) => message.role === "user" && modelMessageText(message) === "finish now",
          );
          if (hasSteering) {
            return createToolCallStreamFn({
              type: "toolCall",
              id: `finish-call-${requestIndex}`,
              name: "finish-steered-turn",
              arguments: {},
            })(_model, context, options);
          }
          return createGatedTextStreamFn(
            requestIndex === 0 ? "discarded initial response" : "recovered initial response",
            requestIndex === 0 ? originalFirstResponse.promise : recoveryFirstResponse.promise,
          )(_model, context);
        }),
      },
    });
    const config: PiFragmentConfig = { workflows: [interactiveChatWorkflow] };

    await runScenario(
      defineScenario({
        name: "pi-harness-interactive-chat-steer-terminal-recovery",
        workflows: createPiWorkflows({ workflows: config.workflows }),
        vars: () => ({
          sessionId: undefined as string | undefined,
          firstQueueUpdate: undefined as WorkflowScenarioObservedEmission | undefined,
          firstToolExecution: undefined as WorkflowScenarioObservedEmission | undefined,
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
          observer: createPiFragmentClients(clientConfig("pi", { runner: "observer" })),
        }),
        runners: ["agent", "recovery", "observer"],
        steps: ({ workflow, runners, concurrent, clients }) => [
          workflow.read({
            read: async () => {
              const session = await clients.observer.useCreateSession.mutateQuery({
                path: { workflowName: interactiveChatWorkflow.name },
                body: { name: "Steer Terminal Recovery", input: { profileName: "default" } },
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
            read: async (ctx) =>
              clients.observer.useCommandSession.mutateQuery({
                path: {
                  workflowName: interactiveChatWorkflow.name,
                  sessionId: ctx.vars.sessionId!,
                },
                body: { kind: "prompt", input: { text: "prepare the change" } },
              }),
          }),
          concurrent({
            agent: [
              runners.agent.tick({
                workflow: interactiveChatWorkflow.name,
                instanceId: (ctx) => ctx.vars.sessionId!,
                reason: "event",
              }),
            ],
            recovery: [
              runners.recovery.waitForControl({ key: "recover-terminal-steering" }),
              runners.recovery.tick({
                workflow: interactiveChatWorkflow.name,
                instanceId: (ctx) => ctx.vars.sessionId!,
                reason: "create",
              }),
            ],
            observer: [
              runners.observer.waitForEmission({
                workflow: interactiveChatWorkflow.name,
                instanceId: (ctx) => ctx.vars.sessionId!,
                match: (emission) =>
                  matchesHarnessMessage(
                    emission,
                    "message_start",
                    "assistant",
                    "discarded initial response",
                  ),
              }),
              workflow.read({
                read: async (ctx) =>
                  clients.observer.useCommandSession.mutateQuery({
                    path: {
                      workflowName: interactiveChatWorkflow.name,
                      sessionId: ctx.vars.sessionId!,
                    },
                    body: { kind: "steer", input: { text: "finish now" } },
                  }),
              }),
              runners.observer.waitForEmission({
                workflow: interactiveChatWorkflow.name,
                instanceId: (ctx) => ctx.vars.sessionId!,
                match: (emission) => matchesSteerQueue(emission, ["finish now"]),
                storeAs: "firstQueueUpdate",
              }),
              workflow.read({
                read: async () => {
                  originalFirstResponse.release();
                },
              }),
              runners.observer.waitForEmission({
                workflow: interactiveChatWorkflow.name,
                instanceId: (ctx) => ctx.vars.sessionId!,
                match: (emission) => {
                  const event = harnessEventFromEmission(emission);
                  return (
                    event?.type === "message_end" &&
                    event.message.role === "assistant" &&
                    event.message.stopReason === "toolUse"
                  );
                },
              }),
              runners.observer.waitForEmission({
                workflow: interactiveChatWorkflow.name,
                instanceId: (ctx) => ctx.vars.sessionId!,
                match: (emission) => matchesToolExecutionStart(emission, "finish-steered-turn"),
                storeAs: "firstToolExecution",
              }),
              runners.observer.restart(),
              runners.observer.resolveControl({ key: "recover-terminal-steering" }),
              runners.observer.waitForEmission({
                workflow: interactiveChatWorkflow.name,
                instanceId: (ctx) => ctx.vars.sessionId!,
                match: (emission) =>
                  matchesHarnessMessage(
                    emission,
                    "message_start",
                    "assistant",
                    "recovered initial response",
                  ),
              }),
              workflow.read({
                read: async () => {
                  interruptedToolExecution.release();
                },
              }),
              runners.observer.waitForEmission({
                workflow: interactiveChatWorkflow.name,
                instanceId: (ctx) => ctx.vars.sessionId!,
                match: (emission, ctx) =>
                  emission.id !== ctx.vars.firstQueueUpdate?.id &&
                  matchesSteerQueue(emission, ["finish now"]),
              }),
              workflow.read({
                read: async () => {
                  recoveryFirstResponse.release();
                },
              }),
              runners.observer.waitForEmission({
                workflow: interactiveChatWorkflow.name,
                instanceId: (ctx) => ctx.vars.sessionId!,
                match: (emission, ctx) =>
                  emission.id !== ctx.vars.firstToolExecution?.id &&
                  matchesToolExecutionStart(emission, "finish-steered-turn"),
              }),
              workflow.read({
                read: async () => {
                  recoveryToolExecution.release();
                },
              }),
            ],
          }),
          workflow.read({
            read: async (ctx) =>
              clients.observer.useSessionDetail.query({
                path: {
                  workflowName: interactiveChatWorkflow.name,
                  sessionId: ctx.vars.sessionId!,
                },
              }),
            assert: (detail) => {
              assert(detail && !Array.isArray(detail), "expected session detail response");
              expect(providerCallIndex).toBeGreaterThanOrEqual(3);
              expect(toolExecutionIndex).toBeGreaterThanOrEqual(1);
              expect(detail.agent.state.messages.map((message) => message.role)).toEqual([
                "user",
                "assistant",
                "user",
                "assistant",
                "toolResult",
              ]);
              expect(
                detail.agent.state.messages.filter(
                  (message) =>
                    message.role === "user" && agentMessageText(message) === "finish now",
                ),
              ).toHaveLength(1);
              expect(detail.agent.state.messages[3]).toMatchObject({
                role: "assistant",
                stopReason: "toolUse",
              });
              expect(detail.agent.state.messages[4]).toMatchObject({
                role: "toolResult",
                toolName: "finish-steered-turn",
              });
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
              expect(resolveOptions).toHaveBeenCalledWith({
                payload: { metadata: { runtime: "default" } },
                instanceId: expect.any(String),
                timestamp: expect.any(Date),
              });
            },
          }),
        ],
      }),
    );
  });

  test("forwards valid raw base64 prompt images from the command route to the model", async () => {
    const imageData = "aGVsbG8=";
    const imageModel: Model<Api> = { ...mockModel, input: ["text", "image"] };
    const observedMessages: Message[] = [];
    const interactiveChatWorkflow = createInteractiveChatWorkflow({
      name: "interactive-chat-image-workflow",
      options: {
        model: imageModel,
        models: createModelsForStreamFn(imageModel, (_model, context) => {
          observedMessages.push(context.messages.at(-1)!);
          return createTextStreamFn("image received")();
        }),
      },
    });
    const config: PiFragmentConfig = { workflows: [interactiveChatWorkflow] };

    await runScenario(
      defineScenario({
        name: "pi-harness-interactive-chat-image",
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
                body: { name: "Image Session", input: { profileName: "default" } },
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
            read: async (ctx) =>
              clients.user.useCommandSession.mutateQuery({
                path: {
                  workflowName: interactiveChatWorkflow.name,
                  sessionId: ctx.vars.sessionId!,
                },
                body: {
                  kind: "prompt",
                  input: {
                    text: "describe the image",
                    images: [{ type: "image", data: imageData, mimeType: "image/png" }],
                  },
                },
              }),
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
              expect(observedMessages).toHaveLength(1);
              expect(observedMessages[0]).toMatchObject({
                role: "user",
                content: [
                  { type: "text", text: "describe the image" },
                  { type: "image", data: imageData, mimeType: "image/png" },
                ],
              });
              assert(detail && !Array.isArray(detail), "expected session detail response");
              expect(detail.agent.state.messages[0]).toMatchObject({
                role: "user",
                content: [
                  { type: "text", text: "describe the image" },
                  { type: "image", data: imageData, mimeType: "image/png" },
                ],
              });
            },
          }),
        ],
      }),
    );
  });

  test("rejects invalid base64 and data URL image commands without persisting a workflow event", async () => {
    const interactiveChatWorkflow = createInteractiveChatWorkflow({
      name: "interactive-chat-invalid-image-workflow",
      options: {
        model: mockModel,
        models: createModelsForStreamFn(mockModel, createTextStreamFn("unexpected response")),
      },
    });
    const config: PiFragmentConfig = { workflows: [interactiveChatWorkflow] };

    await runScenario(
      defineScenario({
        name: "pi-harness-interactive-chat-invalid-image",
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
                body: { name: "Invalid Image Session", input: { profileName: "default" } },
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
              for (const data of ["not base64!", "data:image/png;base64,aGVsbG8="]) {
                await expect(
                  clients.user.useCommandSession.mutateQuery({
                    path: {
                      workflowName: interactiveChatWorkflow.name,
                      sessionId: ctx.vars.sessionId!,
                    },
                    body: {
                      kind: "prompt",
                      input: {
                        text: "invalid image",
                        images: [{ type: "image", data, mimeType: "image/png" }],
                      },
                    },
                  }),
                ).rejects.toThrow();
              }

              return await ctx.state.getHistory(interactiveChatWorkflow.name, ctx.vars.sessionId!);
            },
            assert: (history) => {
              expect(history.events).toEqual([]);
            },
          }),
        ],
      }),
    );
  });

  test("queues prompt, skill, and promptFromTemplate commands received during an active operation", async () => {
    const firstResponse = createCompletionGate();
    const skill: Skill = {
      name: "fragno",
      description: "Use the Fragno workflow conventions.",
      content: "Preserve durable workflow state.",
      filePath: "/skills/fragno/SKILL.md",
    };
    const observedPrompts: string[] = [];
    let providerCallIndex = 0;
    const interactiveChatWorkflow = createInteractiveChatWorkflow({
      name: "interactive-chat-queued-operations-workflow",
      options: {
        resources: {
          skills: [skill],
          promptTemplates: [{ name: "review", content: "Review $1 carefully." }],
        },
        model: mockModel,
        models: createModelsForStreamFn(mockModel, (_model, context) => {
          observedPrompts.push(modelMessageText(context.messages.at(-1)!));
          const callIndex = providerCallIndex;
          providerCallIndex += 1;
          return callIndex === 0
            ? createGatedTextStreamFn("initial response", firstResponse.promise)(_model, context)
            : createTextStreamFn(`queued response ${callIndex}`)();
        }),
      },
    });
    const config: PiFragmentConfig = { workflows: [interactiveChatWorkflow] };

    await runScenario(
      defineScenario({
        name: "pi-harness-interactive-chat-queued-operations",
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
        steps: ({ workflow, runners, concurrent, clients }) => [
          workflow.read({
            read: async () => {
              const session = await clients.user.useCreateSession.mutateQuery({
                path: { workflowName: interactiveChatWorkflow.name },
                body: { name: "Queued Operations", input: { profileName: "default" } },
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
            read: async (ctx) =>
              clients.user.useCommandSession.mutateQuery({
                path: {
                  workflowName: interactiveChatWorkflow.name,
                  sessionId: ctx.vars.sessionId!,
                },
                body: { kind: "prompt", input: { text: "initial prompt" } },
              }),
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
                match: (emission) =>
                  matchesHarnessMessage(emission, "message_start", "assistant", "initial response"),
              }),
              workflow.read({
                read: async (ctx) => {
                  const path = {
                    workflowName: interactiveChatWorkflow.name,
                    sessionId: ctx.vars.sessionId!,
                  };
                  await clients.user.useCommandSession.mutateQuery({
                    path,
                    body: { kind: "prompt", input: { text: "queued prompt" } },
                  });
                  await clients.user.useCommandSession.mutateQuery({
                    path,
                    body: {
                      kind: "skill",
                      input: { name: "fragno", additionalInstructions: "Apply the skill now." },
                    },
                  });
                  return await clients.user.useCommandSession.mutateQuery({
                    path,
                    body: {
                      kind: "promptFromTemplate",
                      input: { name: "review", args: ["the queued operations"] },
                    },
                  });
                },
              }),
              workflow.read({
                read: async () => {
                  firstResponse.release();
                },
              }),
            ],
          }),
          workflow.read({
            read: async (ctx) => ({
              detail: await clients.user.useSessionDetail.query({
                path: {
                  workflowName: interactiveChatWorkflow.name,
                  sessionId: ctx.vars.sessionId!,
                },
              }),
              steps: await ctx.state.getSteps(interactiveChatWorkflow.name, ctx.vars.sessionId!),
              history: await ctx.state.getHistory(
                interactiveChatWorkflow.name,
                ctx.vars.sessionId!,
              ),
            }),
            assert: ({ detail, steps, history }) => {
              assert(detail && !Array.isArray(detail), "expected session detail response");
              expect(observedPrompts).toHaveLength(4);
              assert(observedPrompts[0] === "initial prompt");
              assert(observedPrompts[1] === "queued prompt");
              expect(observedPrompts[2]).toContain('<skill name="fragno"');
              expect(observedPrompts[2]).toContain("Apply the skill now.");
              assert(observedPrompts[3] === "Review the queued operations carefully.");
              expect(detail.agent.state.messages.map((message) => message.role)).toEqual([
                "user",
                "assistant",
                "user",
                "assistant",
                "user",
                "assistant",
                "user",
                "assistant",
              ]);
              expect(
                steps.filter((step) => step.type === "do" && step.name.startsWith("command:")),
              ).toHaveLength(4);
              expect(history.events.filter((event) => event.type === "command")).toHaveLength(4);
              assert(history.events.every((event) => event.consumedByStepKey !== null));
            },
          }),
        ],
      }),
    );
  });

  test.each([
    { kind: "skill" as const, expectedError: "Unknown skill: missing-resource" },
    {
      kind: "promptFromTemplate" as const,
      expectedError: "Unknown prompt template: missing-resource",
    },
  ])("fails an unknown $kind command without a completion checkpoint", async (testCase) => {
    let providerCallCount = 0;
    const interactiveChatWorkflow = createInteractiveChatWorkflow({
      name: `interactive-chat-unknown-${testCase.kind}`,
      options: {
        model: mockModel,
        models: createModelsForStreamFn(mockModel, () => {
          providerCallCount += 1;
          return createTextStreamFn("unexpected response")();
        }),
      },
    });
    const config: PiFragmentConfig = { workflows: [interactiveChatWorkflow] };

    await runScenario(
      defineScenario({
        name: `pi-harness-interactive-chat-unknown-${testCase.kind}`,
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
                body: { name: "Unknown Resource", input: { profileName: "default" } },
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
            read: async (ctx) =>
              testCase.kind === "skill"
                ? clients.user.useCommandSession.mutateQuery({
                    path: {
                      workflowName: interactiveChatWorkflow.name,
                      sessionId: ctx.vars.sessionId!,
                    },
                    body: { kind: "skill", input: { name: "missing-resource" } },
                  })
                : clients.user.useCommandSession.mutateQuery({
                    path: {
                      workflowName: interactiveChatWorkflow.name,
                      sessionId: ctx.vars.sessionId!,
                    },
                    body: { kind: "promptFromTemplate", input: { name: "missing-resource" } },
                  }),
          }),
          runners.agent.runUntilIdle({
            workflow: interactiveChatWorkflow.name,
            instanceId: (ctx) => ctx.vars.sessionId!,
            reason: "event",
          }),
          workflow.read({
            read: async (ctx) => ({
              status: await ctx.state.getStatus(interactiveChatWorkflow.name, ctx.vars.sessionId!),
              history: await ctx.state.getHistory(
                interactiveChatWorkflow.name,
                ctx.vars.sessionId!,
              ),
            }),
            assert: ({ status, history }) => {
              expect(status).toMatchObject({
                status: "errored",
                error: { message: testCase.expectedError },
              });
              assert(providerCallCount === 0);
              expect(
                history.emissions.filter(
                  (emission) =>
                    typeof emission.payload === "object" &&
                    emission.payload !== null &&
                    "kind" in emission.payload &&
                    emission.payload.kind === "harness-operation-complete",
                ),
              ).toEqual([]);
            },
          }),
        ],
      }),
    );
  });

  test.each(["skill", "promptFromTemplate"] as const)(
    "recovers a %s command after entry emission without duplicate transcript entries",
    async (operationKind) => {
      const interruptedResponse = createCompletionGate();
      const recoveryResponse = createCompletionGate();
      const observedPrompts: string[] = [];
      let providerCallIndex = 0;
      const interactiveChatWorkflow = createInteractiveChatWorkflow({
        name: `interactive-chat-${operationKind}-recovery`,
        options: {
          resources: {
            skills: [
              {
                name: "fragno",
                description: "Use the Fragno workflow conventions.",
                content: "Preserve durable workflow state.",
                filePath: "/skills/fragno/SKILL.md",
              },
            ],
            promptTemplates: [{ name: "review", content: "Review $1 carefully." }],
          },
          model: mockModel,
          models: createModelsForStreamFn(mockModel, (_model, context) => {
            observedPrompts.push(modelMessageText(context.messages.at(-1)!));
            const callIndex = providerCallIndex;
            providerCallIndex += 1;
            return createGatedTextStreamFn(
              callIndex === 0 ? "interrupted response" : "recovery response",
              callIndex === 0 ? interruptedResponse.promise : recoveryResponse.promise,
            )(_model, context);
          }),
        },
      });
      const config: PiFragmentConfig = { workflows: [interactiveChatWorkflow] };

      await runScenario(
        defineScenario({
          name: `pi-harness-interactive-chat-${operationKind}-recovery`,
          workflows: createPiWorkflows({ workflows: config.workflows }),
          vars: () => ({
            sessionId: undefined as string | undefined,
            firstUserMessage: undefined as WorkflowScenarioObservedEmission | undefined,
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
            observer: createPiFragmentClients(clientConfig("pi", { runner: "observer" })),
          }),
          runners: ["agent", "recovery", "observer"],
          steps: ({ workflow, runners, concurrent, clients }) => [
            workflow.read({
              read: async () => {
                const session = await clients.observer.useCreateSession.mutateQuery({
                  path: { workflowName: interactiveChatWorkflow.name },
                  body: { name: "Resource Recovery", input: { profileName: "default" } },
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
              read: async (ctx) =>
                operationKind === "skill"
                  ? clients.observer.useCommandSession.mutateQuery({
                      path: {
                        workflowName: interactiveChatWorkflow.name,
                        sessionId: ctx.vars.sessionId!,
                      },
                      body: {
                        kind: "skill",
                        input: { name: "fragno", additionalInstructions: "Apply it now." },
                      },
                    })
                  : clients.observer.useCommandSession.mutateQuery({
                      path: {
                        workflowName: interactiveChatWorkflow.name,
                        sessionId: ctx.vars.sessionId!,
                      },
                      body: {
                        kind: "promptFromTemplate",
                        input: { name: "review", args: ["the recovery path"] },
                      },
                    }),
            }),
            concurrent({
              agent: [
                runners.agent.tick({
                  workflow: interactiveChatWorkflow.name,
                  instanceId: (ctx) => ctx.vars.sessionId!,
                  reason: "event",
                }),
              ],
              recovery: [
                runners.recovery.waitForControl({ key: "recover-resource-operation" }),
                runners.recovery.tick({
                  workflow: interactiveChatWorkflow.name,
                  instanceId: (ctx) => ctx.vars.sessionId!,
                  reason: "create",
                }),
              ],
              observer: [
                runners.observer.waitForEmission({
                  workflow: interactiveChatWorkflow.name,
                  instanceId: (ctx) => ctx.vars.sessionId!,
                  match: (emission) => {
                    const event = harnessEventFromEmission(emission);
                    return event?.type === "message_start" && event.message.role === "user";
                  },
                  storeAs: "firstUserMessage",
                }),
                runners.observer.restart(),
                runners.observer.resolveControl({ key: "recover-resource-operation" }),
                runners.observer.waitForEmission({
                  workflow: interactiveChatWorkflow.name,
                  instanceId: (ctx) => ctx.vars.sessionId!,
                  match: (emission, ctx) => {
                    const event = harnessEventFromEmission(emission);
                    return (
                      emission.id !== ctx.vars.firstUserMessage?.id &&
                      event?.type === "message_start" &&
                      event.message.role === "user"
                    );
                  },
                }),
                workflow.read({
                  read: async () => {
                    interruptedResponse.release();
                    recoveryResponse.release();
                  },
                }),
              ],
            }),
            workflow.read({
              read: async (ctx) => ({
                detail: await clients.observer.useSessionDetail.query({
                  path: {
                    workflowName: interactiveChatWorkflow.name,
                    sessionId: ctx.vars.sessionId!,
                  },
                }),
                history: await ctx.state.getHistory(
                  interactiveChatWorkflow.name,
                  ctx.vars.sessionId!,
                ),
              }),
              assert: ({ detail, history }) => {
                assert(detail && !Array.isArray(detail), "expected session detail response");
                expect(providerCallIndex).toBeGreaterThanOrEqual(2);
                assert(new Set(observedPrompts).size === 1);
                expect(detail.agent.state.messages.map((message) => message.role)).toEqual([
                  "user",
                  "assistant",
                ]);
                expect(
                  detail.agent.state.messages.filter((message) => message.role === "user"),
                ).toHaveLength(1);
                const canonicalEmissions = selectCanonicalWorkflowStepEmissions({
                  steps: history.steps,
                  emissions: history.emissions,
                });
                expect(history.emissions.length).toBeGreaterThan(canonicalEmissions.length);
                expect(
                  canonicalEmissions.filter(
                    (emission) =>
                      typeof emission.payload === "object" &&
                      emission.payload !== null &&
                      "kind" in emission.payload &&
                      emission.payload.kind === "harness-operation-complete",
                  ),
                ).toHaveLength(1);
              },
            }),
          ],
        }),
      );
    },
  );

  test("restores an in-flight harness prompt step after runner restart without duplicating the prompt", async () => {
    const interruptedResponse = createCompletionGate();
    const recoveredResponse = createCompletionGate();
    let providerCallCount = 0;
    const interactiveChatWorkflow = createInteractiveChatWorkflow({
      name: "interactive-chat-in-flight-prompt-restart",
      options: {
        systemPrompt: "You are helpful.",
        model: mockModel,
        models: createModelsForStreamFn(mockModel, (_model, context) => {
          const callIndex = providerCallCount;
          providerCallCount += 1;
          return createGatedTextStreamFn(
            callIndex === 0 ? "interrupted response" : "recovered response",
            callIndex === 0 ? interruptedResponse.promise : recoveredResponse.promise,
          )(_model, context);
        }),
      },
    });
    const config: PiFragmentConfig = { workflows: [interactiveChatWorkflow] };

    await runScenario(
      defineScenario({
        name: "pi-harness-interactive-chat-in-flight-prompt-restart",
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
          observer: createPiFragmentClients(clientConfig("pi", { runner: "observer" })),
        }),
        runners: ["agent", "recovery", "observer"],
        steps: ({ workflow, runners, concurrent, clients }) => [
          workflow.read({
            read: async () => {
              const session = await clients.observer.useCreateSession.mutateQuery({
                path: { workflowName: interactiveChatWorkflow.name },
                body: { name: "Prompt Restart", input: { profileName: "default" } },
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
            read: async (ctx) =>
              clients.observer.useCommandSession.mutateQuery({
                path: {
                  workflowName: interactiveChatWorkflow.name,
                  sessionId: ctx.vars.sessionId!,
                },
                body: { kind: "prompt", input: { text: "hello after restart" } },
              }),
          }),
          concurrent({
            agent: [
              runners.agent.tick({
                workflow: interactiveChatWorkflow.name,
                instanceId: (ctx) => ctx.vars.sessionId!,
                reason: "event",
              }),
            ],
            recovery: [
              runners.recovery.waitForControl({ key: "recover-in-flight-prompt" }),
              runners.recovery.tick({
                workflow: interactiveChatWorkflow.name,
                instanceId: (ctx) => ctx.vars.sessionId!,
                reason: "create",
              }),
            ],
            observer: [
              runners.observer.waitForEmission({
                workflow: interactiveChatWorkflow.name,
                instanceId: (ctx) => ctx.vars.sessionId!,
                match: (emission) =>
                  matchesHarnessMessage(
                    emission,
                    "message_start",
                    "assistant",
                    "interrupted response",
                  ),
              }),
              runners.observer.restart(),
              runners.observer.resolveControl({ key: "recover-in-flight-prompt" }),
              runners.observer.waitForEmission({
                workflow: interactiveChatWorkflow.name,
                instanceId: (ctx) => ctx.vars.sessionId!,
                match: (emission) =>
                  matchesHarnessMessage(
                    emission,
                    "message_start",
                    "assistant",
                    "recovered response",
                  ),
              }),
              workflow.read({
                read: async () => {
                  interruptedResponse.release();
                  recoveredResponse.release();
                },
              }),
            ],
          }),
          workflow.read({
            read: async (ctx) => ({
              detail: await clients.observer.useSessionDetail.query({
                path: {
                  workflowName: interactiveChatWorkflow.name,
                  sessionId: ctx.vars.sessionId!,
                },
              }),
              history: await ctx.state.getHistory(
                interactiveChatWorkflow.name,
                ctx.vars.sessionId!,
              ),
            }),
            assert: ({ detail, history }) => {
              assert(detail && !Array.isArray(detail), "expected session detail response");
              expect(providerCallCount).toBeGreaterThanOrEqual(2);
              expect(detail.agent.state.messages.map((message) => message.role)).toEqual([
                "user",
                "assistant",
              ]);
              expect(
                detail.agent.state.messages.filter((message) => message.role === "user"),
              ).toHaveLength(1);
              assert(agentMessageText(detail.agent.state.messages[0]!) === "hello after restart");
              expect(["interrupted response", "recovered response"]).toContain(
                agentMessageText(detail.agent.state.messages[1]!),
              );
              const canonicalEmissions = selectCanonicalWorkflowStepEmissions({
                steps: history.steps,
                emissions: history.emissions,
              });
              expect(
                canonicalEmissions.filter(
                  (emission) =>
                    typeof emission.payload === "object" &&
                    emission.payload !== null &&
                    "kind" in emission.payload &&
                    emission.payload.kind === "harness-operation-complete",
                ),
              ).toHaveLength(1);
            },
          }),
        ],
      }),
    );
  });

  test("rebuilds persisted session entry state when replaying completed steps after restart", async () => {
    const observedModelContexts: Array<Array<{ role: Message["role"]; text: string }>> = [];
    let providerCallCount = 0;
    const interactiveChatWorkflow = createInteractiveChatWorkflow({
      name: "interactive-chat-completed-step-replay",
      options: {
        systemPrompt: "You are helpful.",
        model: mockModel,
        models: createModelsForStreamFn(mockModel, (_model, context) => {
          observedModelContexts.push(
            context.messages.map((message) => ({
              role: message.role,
              text: modelMessageText(message),
            })),
          );
          providerCallCount += 1;
          return createTextStreamFn(
            providerCallCount === 1 ? "first response" : "second response",
          )();
        }),
      },
    });
    const config: PiFragmentConfig = { workflows: [interactiveChatWorkflow] };

    await runScenario(
      defineScenario({
        name: "pi-harness-interactive-chat-completed-step-replay",
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
                body: { name: "Completed Replay", input: { profileName: "default" } },
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
            read: async (ctx) =>
              clients.user.useCommandSession.mutateQuery({
                path: {
                  workflowName: interactiveChatWorkflow.name,
                  sessionId: ctx.vars.sessionId!,
                },
                body: { kind: "prompt", input: { text: "first prompt" } },
              }),
          }),
          runners.agent.runUntilIdle({
            workflow: interactiveChatWorkflow.name,
            instanceId: (ctx) => ctx.vars.sessionId!,
            reason: "event",
          }),
          runners.agent.restart(),
          workflow.read({
            read: async (ctx) =>
              clients.user.useCommandSession.mutateQuery({
                path: {
                  workflowName: interactiveChatWorkflow.name,
                  sessionId: ctx.vars.sessionId!,
                },
                body: { kind: "prompt", input: { text: "second prompt" } },
              }),
          }),
          runners.agent.runUntilIdle({
            workflow: interactiveChatWorkflow.name,
            instanceId: (ctx) => ctx.vars.sessionId!,
            reason: "event",
          }),
          workflow.read({
            read: async (ctx) => ({
              detail: await clients.user.useSessionDetail.query({
                path: {
                  workflowName: interactiveChatWorkflow.name,
                  sessionId: ctx.vars.sessionId!,
                },
              }),
              steps: await ctx.state.getSteps(interactiveChatWorkflow.name, ctx.vars.sessionId!),
            }),
            assert: ({ detail, steps }) => {
              assert(detail && !Array.isArray(detail), "expected session detail response");
              expect(providerCallCount).toBe(2);
              expect(observedModelContexts).toEqual([
                [{ role: "user", text: "first prompt" }],
                [
                  { role: "user", text: "first prompt" },
                  { role: "assistant", text: "first response" },
                  { role: "user", text: "second prompt" },
                ],
              ]);
              expect(detail.agent.state.messages.map((message) => message.role)).toEqual([
                "user",
                "assistant",
                "user",
                "assistant",
              ]);
              expect(
                steps.filter((step) => step.type === "do" && step.name.startsWith("command:")),
              ).toMatchObject([
                { status: "completed", attempts: 1 },
                { status: "completed", attempts: 1 },
              ]);
            },
          }),
        ],
      }),
    );
  });

  test("applies the configured active tool policy to registered tools", async () => {
    const observedToolNames: string[][] = [];
    const searchTool = definePiTool({
      name: "search",
      label: "Search",
      description: "Search docs.",
      parameters: Type.Object({ query: Type.String() }),
      async execute(_toolCallId, params) {
        return { content: [{ type: "text", text: `searched:${params.query}` }], details: {} };
      },
    });
    const writeTool = definePiTool({
      name: "write",
      label: "Write",
      description: "Write docs.",
      parameters: Type.Object({ path: Type.String() }),
      async execute(_toolCallId, params) {
        return { content: [{ type: "text", text: `wrote:${params.path}` }], details: {} };
      },
    });
    const interactiveChatWorkflow = createInteractiveChatWorkflow({
      name: "interactive-chat-active-tools-policy",
      options: {
        systemPrompt: "Use only exposed tools.",
        model: mockModel,
        models: createModelsForStreamFn(mockModel, (_model, context) => {
          observedToolNames.push((context.tools ?? []).map((tool) => tool.name));
          return createTextStreamFn("used only the active tool")();
        }),
        tools: [searchTool, writeTool],
        activeToolNames: ["search"],
      },
    });
    const config: PiFragmentConfig = { workflows: [interactiveChatWorkflow] };

    await runScenario(
      defineScenario({
        name: "pi-harness-interactive-chat-active-tools-policy",
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
                body: { name: "Active Tools", input: { profileName: "default" } },
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
            read: async (ctx) =>
              clients.user.useCommandSession.mutateQuery({
                path: {
                  workflowName: interactiveChatWorkflow.name,
                  sessionId: ctx.vars.sessionId!,
                },
                body: { kind: "prompt", input: { text: "search only" } },
              }),
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
              expect(observedToolNames).toEqual([["search"]]);
              expect(detail.agent.state.messages.map((message) => message.role)).toEqual([
                "user",
                "assistant",
              ]);
            },
          }),
        ],
      }),
    );
  });

  test("covers the remaining session route integration with the interactive chat workflow", async () => {
    const actor = { type: "account", id: "account-123" };
    const failedUsage = {
      input: 50,
      output: 5,
      cacheRead: 10,
      cacheWrite: 0,
      totalTokens: 65,
      cost: {
        input: 0.0005,
        output: 0.0001,
        cacheRead: 0.00001,
        cacheWrite: 0,
        total: 0.00061,
      },
    };
    const onOperationCompleted = vi.fn();
    const interactiveChatWorkflow = createInteractiveChatWorkflow({
      name: "interactive-chat-route-integration",
      options: {
        systemPrompt: "You are helpful.",
        model: mockModel,
        models: createModelsForStreamFn(mockModel, (_model, context) => {
          if (modelMessageText(context.messages.at(-1)!) !== "fail") {
            return createTextStreamFn("successful response")();
          }

          const stream = createAssistantMessageEventStream();
          const message = createAssistantMessage("");
          message.stopReason = "error";
          message.errorMessage = "provider failed";
          message.usage = failedUsage;
          stream.push({ type: "error", reason: "error", error: message });
          return stream;
        }),
      },
    });
    const config: PiFragmentConfig = {
      workflows: [interactiveChatWorkflow],
      onOperationCompleted,
    };

    await runScenario(
      defineScenario({
        name: "pi-harness-interactive-chat-route-integration",
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
                  name: "Route Integration",
                  metadata: { runtime: "default" },
                  input: { actor },
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
            read: async (ctx) =>
              clients.user.useSessionDetail.query({
                path: {
                  workflowName: interactiveChatWorkflow.name,
                  sessionId: ctx.vars.sessionId!,
                },
              }),
            assert: (detail) => {
              assert(detail && !Array.isArray(detail), "expected session detail response");
              expect(detail.agent.state.messages).toEqual([]);
              expect(detail).not.toHaveProperty("trace");
              expect(detail).not.toHaveProperty("turns");
              expect(detail).not.toHaveProperty("commandHistory");
              expect(detail).not.toHaveProperty("phase");
              expect(detail).not.toHaveProperty("turn");
              expect(detail).not.toHaveProperty("waitingFor");
            },
          }),
          workflow.read({
            read: async (ctx) =>
              clients.user.useCommandSession.mutateQuery({
                path: {
                  workflowName: interactiveChatWorkflow.name,
                  sessionId: ctx.vars.sessionId!,
                },
                body: { kind: "prompt", input: { text: "succeed" } },
              }),
          }),
          runners.agent.runUntilIdle({
            workflow: interactiveChatWorkflow.name,
            instanceId: (ctx) => ctx.vars.sessionId!,
            reason: "event",
          }),
          runners.agent.drainHooks(),
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
              expect(detail.agent.state.messages.map((message) => message.role)).toEqual([
                "user",
                "assistant",
              ]);
              expect(onOperationCompleted).toHaveBeenCalledTimes(1);
              expect(onOperationCompleted).toHaveBeenLastCalledWith(
                expect.objectContaining({
                  actor,
                  workflowName: interactiveChatWorkflow.name,
                  metadata: { runtime: "default" },
                  operation: "prompt",
                  modelCalls: [expect.objectContaining({ stopReason: "stop" })],
                }),
                expect.any(Object),
              );
            },
          }),
          workflow.read({
            read: async (ctx) =>
              clients.user.useCommandSession.mutateQuery({
                path: {
                  workflowName: interactiveChatWorkflow.name,
                  sessionId: ctx.vars.sessionId!,
                },
                body: { kind: "prompt", input: { text: "fail" } },
              }),
          }),
          runners.agent.runUntilIdle({
            workflow: interactiveChatWorkflow.name,
            instanceId: (ctx) => ctx.vars.sessionId!,
            reason: "event",
          }),
          runners.agent.drainHooks(),
          workflow.read({
            read: async (ctx) => ({
              status: await ctx.state.getStatus(interactiveChatWorkflow.name, ctx.vars.sessionId!),
              detail: await clients.user.useSessionDetail.query({
                path: {
                  workflowName: interactiveChatWorkflow.name,
                  sessionId: ctx.vars.sessionId!,
                },
              }),
            }),
            assert: ({ status, detail }) => {
              assert(detail && !Array.isArray(detail), "expected session detail response");
              expect(status).toMatchObject({
                status: "errored",
                error: { message: "Pi harness agent stream failed: provider failed" },
              });
              expect(onOperationCompleted).toHaveBeenCalledTimes(2);
              expect(onOperationCompleted).toHaveBeenLastCalledWith(
                expect.objectContaining({
                  actor,
                  workflowName: interactiveChatWorkflow.name,
                  metadata: { runtime: "default" },
                  operation: "prompt",
                  modelCalls: [
                    expect.objectContaining({ stopReason: "error", usage: failedUsage }),
                  ],
                  usage: failedUsage,
                }),
                expect.any(Object),
              );
            },
          }),
        ],
      }),
    );
  });

  test("rejects image commands that exceed the persisted workflow event size limit", async () => {
    const interactiveChatWorkflow = createInteractiveChatWorkflow({
      name: "interactive-chat-oversized-image-workflow",
      options: {
        model: mockModel,
        models: createModelsForStreamFn(mockModel, createTextStreamFn("unexpected response")),
      },
    });
    const config: PiFragmentConfig = { workflows: [interactiveChatWorkflow] };
    const oversizedImageData = "AAAA".repeat(MAX_PI_COMMAND_IMAGE_DATA_LENGTH / 4 + 1);

    await runScenario(
      defineScenario({
        name: "pi-harness-interactive-chat-oversized-image",
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
                body: { name: "Oversized Image Session", input: { profileName: "default" } },
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
              await expect(
                clients.user.useCommandSession.mutateQuery({
                  path: {
                    workflowName: interactiveChatWorkflow.name,
                    sessionId: ctx.vars.sessionId!,
                  },
                  body: {
                    kind: "prompt",
                    input: {
                      text: "oversized image",
                      images: [{ type: "image", data: oversizedImageData, mimeType: "image/png" }],
                    },
                  },
                }),
              ).rejects.toThrow("Validation failed");

              return await ctx.state.getHistory(interactiveChatWorkflow.name, ctx.vars.sessionId!);
            },
            assert: (history) => {
              expect(history.events).toEqual([]);
            },
          }),
        ],
      }),
    );
  });
});
