import { assert, describe, expect, expectTypeOf, test, vi } from "vitest";

import { defineScenario, runScenario } from "@fragno-dev/workflows/scenario";
import { defineWorkflow } from "@fragno-dev/workflows/workflow";
import { Type } from "typebox";
import { z } from "zod";

import { instantiate } from "@fragno-dev/core";

import type { AgentEvent, StreamFn } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Model,
  type ToolCall,
} from "@earendil-works/pi-ai";

import { createPiFragmentClients } from "../client/clients";
import { createPiFragmentClient } from "../client/vanilla";
import { piRoutesFactory } from "../routes";
import { piHarnessDefinition } from "./definition";
import { createPiWorkflows } from "./factory";
import { createAgentLoop, waitForPiCommand } from "./harness/commands";
import { NoOpExecutionEnv } from "./harness/execution-env";
import type { PiHarnessAgentOptions } from "./harness/run-pi-harness-step";
import { definePiTool } from "./tools";
import type { PiFragmentConfig } from "./types";
import { createInteractiveChatWorkflow } from "./workflows/interactive-chat-workflow";

type ScenarioHarnesses = Record<string, PiHarnessAgentOptions>;

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

const createPausedTextStreamFn = (text: string, waitBeforeEnd: Promise<unknown>) => () => {
  const stream = createAssistantMessageEventStream();
  const message = createAssistantMessage(text);

  void (async () => {
    stream.push({ type: "start", partial: message });
    stream.push({ type: "text_start", contentIndex: 0, partial: message });
    stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
    await waitBeforeEnd;
    stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
    stream.push({ type: "done", reason: "stop", message });
  })();

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
  { name: "pi-harness-command-echo", schema: z.object({ harnessName: z.string() }) },
  async (_event, step) => {
    const command = await waitForPiCommand(step);

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
                  input: { harnessName: "default" },
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
    const harnesses: ScenarioHarnesses = {
      default: {
        env: createEnv(),
        systemPrompt: "You are helpful.",
        model: mockModel,
        streamFn: (_model, context) => {
          observedSystemPrompts.push(context.systemPrompt ?? "");
          return createTextStreamFn("hello from harness")();
        },
      },
    };
    const resolveHarness = vi.fn(() => ({
      harnessName: "default",
      systemPrompt: "You are resolved for this session.",
    }));
    const interactiveChatWorkflow = createInteractiveChatWorkflow({ harnesses, resolveHarness });
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
                  input: { harnessName: "default" },
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
              expect(resolveHarness).toHaveBeenCalled();
              expect(observedSystemPrompts).toEqual(["You are resolved for this session."]);
              expect(steps).toContainEqual(
                expect.objectContaining({
                  name: "resolve-harnesses",
                  status: "completed",
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

  test("restores an in-flight harness prompt step after runner restart without duplicating the prompt", async () => {
    let releaseInFlightAttempt!: () => void;
    const inFlightAttemptReleased = new Promise<void>((resolve) => {
      releaseInFlightAttempt = resolve;
    });
    const streamFn = vi.fn(() => {
      const stream = createAssistantMessageEventStream();
      const message = createAssistantMessage("stop");

      void (async () => {
        await inFlightAttemptReleased;
        stream.push({ type: "start", partial: message });
        stream.push({ type: "text_start", contentIndex: 0, partial: message });
        stream.push({ type: "text_delta", contentIndex: 0, delta: "stop", partial: message });
        stream.push({ type: "text_end", contentIndex: 0, content: "stop", partial: message });
        stream.push({ type: "done", reason: "stop", message });
      })();

      return stream;
    });
    const harnesses: ScenarioHarnesses = {
      default: {
        env: createEnv(),
        systemPrompt: "You are helpful.",
        model: mockModel,
        streamFn,
      },
    };
    const restoreWorkflow = defineWorkflow(
      { name: "pi-harness-restore-prompt-in-flight", schema: z.object({}) },
      async (event, step) => {
        const agentLoop = createAgentLoop(step, {
          workflowName: "pi-harness-restore-prompt-in-flight",
          sessionId: event.instanceId,
          agentName: "default",
          ...harnesses["default"]!,
        });

        await agentLoop.runStep("ask", { kind: "prompt", args: ["hello"] });
        const messages = agentLoop
          .getState()
          .entries.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));

        return {
          roles: messages.map((message) => message.role),
          text: messages
            .flatMap((message) =>
              "content" in message && Array.isArray(message.content)
                ? message.content.flatMap((content) =>
                    content.type === "text" ? [content.text] : [],
                  )
                : [],
            )
            .join(" "),
        };
      },
    );
    const config: PiFragmentConfig = { workflows: [restoreWorkflow] };

    await runScenario(
      defineScenario({
        name: "pi-harness-restore-prompt-in-flight",
        workflows: createPiWorkflows({ workflows: config.workflows }),
        harness: {
          configureFragments: (harness) => ({
            pi: instantiate(piHarnessDefinition)
              .withConfig(config)
              .withRoutes([piRoutesFactory])
              .withServices({ workflows: harness.fragment.services }),
          }),
        },
        runners: ["worker", "killer"],
        steps: ({ workflow, runners, concurrent }) => [
          workflow.create({ workflow: restoreWorkflow.name, id: "restore-prompt-session" }),
          concurrent({
            worker: [
              runners.worker.tick({
                workflow: restoreWorkflow.name,
                instanceId: "restore-prompt-session",
                reason: "create",
              }),
            ],
            killer: [
              runners.killer.waitForEmission({
                workflow: restoreWorkflow.name,
                instanceId: "restore-prompt-session",
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
                  return event.type === "message_end" && event.message.role === "user";
                },
              }),
              runners.killer.restart(),
              workflow.read({
                read: () => {
                  const timeout = setTimeout(releaseInFlightAttempt, 20);
                  timeout.unref?.();
                },
              }),
              runners.killer.tick({
                workflow: restoreWorkflow.name,
                instanceId: "restore-prompt-session",
                reason: "create",
              }),
            ],
          }),
          workflow.read({
            read: async (ctx) => ({
              status: await ctx.state.getStatus(restoreWorkflow.name, "restore-prompt-session"),
              steps: await ctx.state.getSteps(restoreWorkflow.name, "restore-prompt-session"),
            }),
            assert: ({ status, steps }) => {
              expect(status).toMatchObject({
                status: "complete",
                output: { roles: ["user", "assistant"], text: "hello stop" },
              });
              expect(steps).toContainEqual(
                expect.objectContaining({
                  stepKey: "do:ask",
                  status: "completed",
                }),
              );
            },
          }),
        ],
      }),
    );
  });

  test("replays a completed harness step after runner restart without calling the provider again", async () => {
    const streamFn = vi.fn(createTextStreamFn("replayed after restart"));
    const harnesses: ScenarioHarnesses = {
      default: {
        env: createEnv(),
        systemPrompt: "You are helpful.",
        model: mockModel,
        streamFn,
      },
    };
    const replayWorkflowSchema = z.object({ harnessName: z.string() });
    const replayWorkflow = defineWorkflow(
      { name: "pi-harness-replay-completed-step", schema: replayWorkflowSchema },
      async (event, step) => {
        const params = replayWorkflowSchema.parse(event.payload ?? {});
        const harness = harnesses[params.harnessName];
        if (!harness) {
          throw new Error(`Harness ${params.harnessName} not found.`);
        }
        const agentLoop = createAgentLoop(step, {
          workflowName: "pi-harness-replay-completed-step",
          sessionId: event.instanceId,
          agentName: params.harnessName,
          ...harness,
        });

        await agentLoop.runStep("ask", { kind: "prompt", args: ["hello before restart"] });
        await step.waitForEvent("resume", { type: "resume" });

        return agentLoop.summary();
      },
    );
    const config: PiFragmentConfig = { workflows: [replayWorkflow] };

    await runScenario(
      defineScenario({
        name: "pi-harness-replay-completed-step",
        workflows: createPiWorkflows({ workflows: config.workflows }),
        vars: () => ({ sessionId: "replay-completed-session" }),
        harness: {
          configureFragments: (harness) => ({
            pi: instantiate(piHarnessDefinition)
              .withConfig(config)
              .withRoutes([piRoutesFactory])
              .withServices({ workflows: harness.fragment.services }),
          }),
        },
        runners: ["worker"],
        steps: ({ workflow, runners }) => [
          workflow.create({
            workflow: replayWorkflow.name,
            id: (ctx) => ctx.vars.sessionId!,
            params: { harnessName: "default" },
          }),
          runners.worker.runUntilIdle({
            workflow: replayWorkflow.name,
            instanceId: (ctx) => ctx.vars.sessionId!,
            reason: "create",
          }),
          workflow.read({
            read: async (ctx) => ({
              status: await ctx.state.getStatus(replayWorkflow.name, ctx.vars.sessionId!),
              steps: await ctx.state.getSteps(replayWorkflow.name, ctx.vars.sessionId!),
            }),
            assert: ({ status, steps }) => {
              assert(status.status === "waiting");
              expect(streamFn).toHaveBeenCalledTimes(1);
              expect(steps).toContainEqual(
                expect.objectContaining({
                  stepKey: "do:ask",
                  status: "completed",
                  result: expect.objectContaining({ operation: "prompt" }),
                }),
              );
              expect(steps).toContainEqual(
                expect.objectContaining({
                  stepKey: "waitForEvent:resume",
                  status: "waiting",
                }),
              );
            },
          }),
          runners.worker.restart(),
          workflow.event({
            workflow: replayWorkflow.name,
            instanceId: (ctx) => ctx.vars.sessionId!,
            event: { type: "resume", payload: {} },
          }),
          runners.worker.runUntilIdle({
            workflow: replayWorkflow.name,
            instanceId: (ctx) => ctx.vars.sessionId!,
            reason: "event",
          }),
          workflow.read({
            read: async (ctx) => ({
              status: await ctx.state.getStatus(replayWorkflow.name, ctx.vars.sessionId!),
              steps: await ctx.state.getSteps(replayWorkflow.name, ctx.vars.sessionId!),
            }),
            assert: ({ status, steps }) => {
              assert(status.status === "complete");
              expect(streamFn).toHaveBeenCalledTimes(1);
              expect(status.output).toMatchObject({ entryCount: 2 });
              expect(steps).toContainEqual(
                expect.objectContaining({
                  stepKey: "do:ask",
                  status: "completed",
                  attempts: 1,
                }),
              );
            },
          }),
        ],
      }),
    );
  });

  test("streams assistant text through workflow emissions before the harness step commits", async () => {
    let releaseStream!: () => void;
    const streamCanFinish = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    const harnesses: ScenarioHarnesses = {
      default: {
        env: createEnv(),
        systemPrompt: "You are helpful.",
        model: mockModel,
        streamFn: createPausedTextStreamFn("streamed before commit", streamCanFinish),
      },
    };
    const interactiveChatWorkflow = createInteractiveChatWorkflow({
      harnesses,
      name: "interactive-chat-streaming-workflow",
    });
    const config: PiFragmentConfig = {
      workflows: [interactiveChatWorkflow],
    };

    await runScenario(
      defineScenario({
        name: "pi-harness-interactive-chat-streaming",
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
          rawUser: createPiFragmentClients(clientConfig("pi", { runner: "user" })),
          storeUser: createPiFragmentClient(clientConfig("pi", { runner: "user" })),
        }),
        stores: ({ clients, store }) => ({
          userSession: store((ctx) =>
            clients.storeUser.useSession({
              path: { workflowName: interactiveChatWorkflow.name, sessionId: ctx.vars.sessionId! },
            }),
          ),
        }),
        runners: ["agent", "user"],
        steps: ({ workflow, runners, concurrent, clients, stores }) => [
          workflow.read({
            read: async () => {
              const session = await clients.rawUser.useCreateSession.mutateQuery({
                path: { workflowName: interactiveChatWorkflow.name },
                body: {
                  name: "Scenario Session",
                  input: { harnessName: "default" },
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
          stores.userSession.waitFor(
            (state) => state.connectionStatus === "open" && state.agent !== null,
          ),
          concurrent({
            agent: [
              stores.userSession.read(async (session) => {
                await session.sendCommand({ kind: "prompt", input: { text: "start streaming" } });
              }),
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
                  return (
                    event.type === "message_update" &&
                    event.message.role === "assistant" &&
                    event.message.content.some(
                      (content) =>
                        content.type === "text" && content.text === "streamed before commit",
                    )
                  );
                },
              }),
              stores.userSession.read(async (session) => {
                await vi.waitFor(() => {
                  expect(session.messages.get()).toContainEqual(
                    expect.objectContaining({
                      role: "assistant",
                      content: [{ type: "text", text: "streamed before commit" }],
                    }),
                  );
                });
                releaseStream();
              }),
            ],
          }),
          workflow.read({
            read: async (ctx) =>
              clients.rawUser.useSessionDetail.query({
                path: {
                  workflowName: interactiveChatWorkflow.name,
                  sessionId: ctx.vars.sessionId!,
                },
              }),
            assert: (detail) => {
              assert(detail && !Array.isArray(detail), "expected session detail response");
              expect(detail.agent.state.messages).toMatchObject([
                { role: "user" },
                { role: "assistant", stopReason: "stop" },
              ]);
              expect(detail.agent.state.messages[1]).toMatchObject({
                role: "assistant",
                content: [{ type: "text", text: "streamed before commit" }],
              });
            },
          }),
        ],
      }),
    );
  });

  test("aborts an in-flight AgentHarness prompt", async () => {
    const abortObserved = vi.fn();
    const harnesses: ScenarioHarnesses = {
      default: {
        env: createEnv(),
        systemPrompt: "You are helpful.",
        model: mockModel,
        streamFn: createAbortableStreamFn(abortObserved),
      },
    };
    const interactiveChatWorkflow = createInteractiveChatWorkflow({
      harnesses,
      name: "interactive-chat-abort-workflow",
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
                body: { name: "Abort Session", input: { harnessName: "default" } },
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
    const harnesses: ScenarioHarnesses = {
      default: {
        env: createEnv(),
        systemPrompt: "You are helpful.",
        model: mockModel,
        streamFn: createToolCallStreamFn({
          type: "toolCall",
          id: "call-1",
          name: "classify",
          arguments: { request: "broken" },
        }),
      },
    };
    const tools = [classifyTool] as const;
    const interactiveChatWorkflow = createInteractiveChatWorkflow({
      harnesses: { default: { ...harnesses["default"]!, tools } },
      name: "interactive-chat-tool-workflow",
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
                body: { name: "Tool Session", input: { harnessName: "default" } },
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
            },
          }),
        ],
      }),
    );
  });

  test("applies per-command active tool policy to registered tools", async () => {
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
    const tools = [searchTool, writeTool] as const;
    const streamFn: StreamFn = (_model, context) => {
      observedToolNames.push((context.tools ?? []).map((tool) => tool.name));
      return createTextStreamFn("used only the active tool")();
    };
    const activeToolsWorkflow = defineWorkflow(
      { name: "pi-harness-active-tools-policy", schema: z.object({}) },
      async (event, step) => {
        const agentLoop = createAgentLoop(step, {
          workflowName: "pi-harness-active-tools-policy",
          sessionId: event.instanceId,
          agentName: "default",
          env: createEnv(),
          systemPrompt: "Use only exposed tools.",
          model: mockModel,
          streamFn,
          tools,
        });

        const result = await agentLoop.waitForCommandAndRunStep({
          activeToolNames: ["search"],
        });

        if (result.kind !== "agentRun") {
          throw new Error("EXPECTED_AGENT_RUN");
        }

        return agentLoop.summary();
      },
    );
    const config: PiFragmentConfig = { workflows: [activeToolsWorkflow] };

    await runScenario(
      defineScenario({
        name: "pi-harness-active-tools-policy",
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
                path: { workflowName: activeToolsWorkflow.name },
                body: { name: "Active Tools Session", input: {} },
              });
              assert(session && !Array.isArray(session), "expected session response");
              return session.id;
            },
            storeAs: "sessionId",
          }),
          runners.agent.runUntilIdle({
            workflow: activeToolsWorkflow.name,
            instanceId: (ctx) => ctx.vars.sessionId!,
            reason: "create",
          }),
          workflow.read({
            read: async (ctx) =>
              clients.user.useCommandSession.mutateQuery({
                path: { workflowName: activeToolsWorkflow.name, sessionId: ctx.vars.sessionId! },
                body: { kind: "prompt", input: { text: "search only" } },
              }),
          }),
          runners.agent.runUntilIdle({
            workflow: activeToolsWorkflow.name,
            instanceId: (ctx) => ctx.vars.sessionId!,
            reason: "event",
          }),
          workflow.read({
            read: async (ctx) =>
              clients.user.useSessionDetail.query({
                path: { workflowName: activeToolsWorkflow.name, sessionId: ctx.vars.sessionId! },
              }),
            assert: (detail) => {
              assert(detail && !Array.isArray(detail), "expected session detail response");
              expect(observedToolNames).toEqual([["search"]]);
              assert(detail.workflow.status === "complete");
              expect(detail.agent.state.messages).toContainEqual(
                expect.objectContaining({ role: "assistant", stopReason: "stop" }),
              );
            },
          }),
        ],
      }),
    );
  });

  test("uses already-loaded skills and prompt templates from harness resources", async () => {
    const observedPrompts: string[] = [];
    const streamFn: StreamFn = (_model, context) => {
      const prompt = context.messages.at(-1)?.content;
      observedPrompts.push(
        typeof prompt === "string"
          ? prompt
          : (prompt ?? []).map((content) => (content.type === "text" ? content.text : "")).join(""),
      );
      return createTextStreamFn(`resource prompt ${observedPrompts.length}`)();
    };
    const resourcesWorkflow = defineWorkflow(
      { name: "pi-harness-resources", schema: z.object({}) },
      async (event, step) => {
        const agentLoop = createAgentLoop(step, {
          workflowName: "pi-harness-resources",
          sessionId: event.instanceId,
          agentName: "default",
          env: createEnv(),
          systemPrompt: "Use loaded resources.",
          model: mockModel,
          streamFn,
          resources: {
            skills: [
              {
                name: "fragno",
                description: "Use for Fragno work.",
                content: "Always preserve durable workflow state.",
                filePath: "/repo/.agents/skills/fragno/SKILL.md",
              },
            ],
            promptTemplates: [
              {
                name: "review",
                description: "Review a change.",
                content: "Review $1 for durable Pi harness behavior.",
              },
            ],
          },
        });

        await agentLoop.runStep("invoke-skill", {
          kind: "skill",
          args: ["fragno", "Apply this to pi-harness."],
        });
        await agentLoop.runStep("invoke-template", {
          kind: "promptFromTemplate",
          args: ["review", ["teal-recorder"]],
        });

        return agentLoop.summary();
      },
    );
    const config: PiFragmentConfig = { workflows: [resourcesWorkflow] };

    await runScenario(
      defineScenario({
        name: "pi-harness-resources",
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
                path: { workflowName: resourcesWorkflow.name },
                body: { name: "Resources Session", input: {} },
              });
              assert(session && !Array.isArray(session), "expected session response");
              return session.id;
            },
            storeAs: "sessionId",
          }),
          runners.agent.runUntilIdle({
            workflow: resourcesWorkflow.name,
            instanceId: (ctx) => ctx.vars.sessionId!,
            reason: "create",
          }),
          workflow.read({
            read: async (ctx) =>
              clients.user.useSessionDetail.query({
                path: { workflowName: resourcesWorkflow.name, sessionId: ctx.vars.sessionId! },
              }),
            assert: (detail) => {
              assert(detail && !Array.isArray(detail), "expected session detail response");
              expect(observedPrompts[0]).toContain('<skill name="fragno"');
              expect(observedPrompts[0]).toContain("Always preserve durable workflow state.");
              expect(observedPrompts[0]).toContain("Apply this to pi-harness.");
              assert(
                observedPrompts[1] === "Review teal-recorder for durable Pi harness behavior.",
              );
              expect(detail.agent.state.messages).toMatchObject([
                { role: "user" },
                { role: "assistant", stopReason: "stop" },
                { role: "user" },
                { role: "assistant", stopReason: "stop" },
              ]);
            },
          }),
        ],
      }),
    );
  });

  test("runs an autonomous agentic workflow that hands off at a classification tool", async () => {
    let providerCalls = 0;
    const fakeSafetyApi = vi.fn(async (input: { text: string; offensive: boolean }) => ({
      action: input.offensive ? "escalated" : "allowed",
      ticketId: input.offensive ? "safety-123" : null,
    }));
    const classifySafetyTool = definePiTool({
      name: "classifySafety",
      label: "Classify safety",
      description: "Classify whether text is offensive.",
      parameters: Type.Object({ text: Type.String() }),
      resultSchema: Type.Object({ offensive: Type.Boolean() }),
      async execute(_toolCallId, params) {
        return {
          content: [
            {
              type: "text",
              text: params.text.includes("idiot") ? "offensive" : "not offensive",
            },
          ],
          details: { offensive: params.text.includes("idiot") },
        };
      },
    });
    const skippedClassificationStream = createTextStreamFn("This looks offensive to me.");
    const classifyStream = createToolCallStreamFn({
      type: "toolCall",
      id: "classify-call-1",
      name: "classifySafety",
      arguments: { text: "you are an idiot" },
    });
    const finalStream = createTextStreamFn(
      "Created safety ticket safety-123 and drafted a moderator summary.",
    );
    const streamFn: StreamFn = (model, context, options) => {
      providerCalls += 1;
      if (providerCalls === 1) {
        return skippedClassificationStream();
      }
      return providerCalls === 2 ? classifyStream(model, context, options) : finalStream();
    };
    const harnesses: ScenarioHarnesses = {
      default: {
        env: createEnv(),
        systemPrompt: "You are a safety operations agent.",
        model: mockModel,
        streamFn,
      },
    };
    const tools = [classifySafetyTool] as const;
    const workflowSchema = z.object({ harnessName: z.string(), text: z.string() });
    const autonomousSafetyWorkflow = defineWorkflow(
      { name: "pi-harness-autonomous-safety-agent", schema: workflowSchema },
      async (event, step) => {
        const params = workflowSchema.parse(event.payload ?? {});
        const harness = harnesses[params.harnessName];
        if (!harness) {
          throw new Error(`Harness ${params.harnessName} not found.`);
        }
        const agentLoop = createAgentLoop(step, {
          workflowName: "pi-harness-autonomous-safety-agent",
          sessionId: event.instanceId,
          agentName: params.harnessName,
          ...harness,
          tools,
        });
        let offensive: boolean | undefined;
        for (let attempt = 0; offensive === undefined && attempt < 3; attempt += 1) {
          const message = await agentLoop.runStep(`classify-safety-${attempt}`, {
            kind: "prompt",
            args: [
              attempt === 0
                ? `Classify this text: ${params.text}`
                : `You must call classifySafety for this text before deciding: ${params.text}`,
            ],
            stopOnTools: ["classifySafety"],
          });
          if (message?.role === "toolResult" && message.toolName === "classifySafety") {
            expectTypeOf(message.details).toEqualTypeOf<{ offensive: boolean }>();
            offensive = message.details.offensive;
          }
        }
        if (offensive === undefined) {
          throw new Error("MISSING_CLASSIFICATION_RESULT_AFTER_REPROMPT");
        }
        const apiResult = await step.do("external-safety-api", async () =>
          fakeSafetyApi({ text: params.text, offensive }),
        );
        await agentLoop.runStep("summarize-safety-action", {
          kind: "prompt",
          args: [
            `External safety API returned ${apiResult.action} with ticket ${apiResult.ticketId}. Draft the operator summary.`,
          ],
        });

        return {
          action: apiResult.action,
          ticketId: apiResult.ticketId,
          leafId: agentLoop.summary().leafId,
        };
      },
    );
    const config: PiFragmentConfig = {
      workflows: [autonomousSafetyWorkflow],
    };

    await runScenario(
      defineScenario({
        name: "pi-harness-autonomous-safety-agent",
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
                path: { workflowName: autonomousSafetyWorkflow.name },
                body: {
                  name: "Autonomous Safety Session",
                  input: { harnessName: "default", text: "you are an idiot" },
                },
              });
              assert(session && !Array.isArray(session), "expected session response");
              return session.id;
            },
            storeAs: "sessionId",
          }),
          runners.agent.runUntilIdle({
            workflow: autonomousSafetyWorkflow.name,
            instanceId: (ctx) => ctx.vars.sessionId!,
            reason: "create",
          }),
          workflow.read({
            read: async (ctx) => ({
              detail: await clients.user.useSessionDetail.query({
                path: {
                  workflowName: autonomousSafetyWorkflow.name,
                  sessionId: ctx.vars.sessionId!,
                },
              }),
              status: await ctx.state.getStatus(autonomousSafetyWorkflow.name, ctx.vars.sessionId!),
            }),
            assert: ({ detail, status }) => {
              assert(detail && !Array.isArray(detail), "expected session detail response");
              assert(status.status === "complete");
              expect(status.output).toMatchObject({ action: "escalated", ticketId: "safety-123" });
              expect(fakeSafetyApi).toHaveBeenCalledWith({
                text: "you are an idiot",
                offensive: true,
              });
              assert(providerCalls === 3);
              expect(detail.agent.state.messages).toMatchObject([
                { role: "user" },
                { role: "assistant", stopReason: "stop" },
                { role: "user" },
                { role: "assistant", stopReason: "toolUse" },
                { role: "toolResult", toolName: "classifySafety" },
                { role: "user" },
                { role: "assistant", stopReason: "stop" },
              ]);
              expect(detail.agent.state.messages[4]).toMatchObject({
                role: "toolResult",
                content: [{ type: "text", text: "offensive" }],
                details: { offensive: true },
              });
              expect(detail.agent.state.messages[6]).toMatchObject({
                role: "assistant",
                content: [
                  {
                    type: "text",
                    text: "Created safety ticket safety-123 and drafted a moderator summary.",
                  },
                ],
              });
            },
          }),
        ],
      }),
    );
  });

  test("uses stopOnTools to terminate after a matching tool result", async () => {
    const classifyTool = definePiTool({
      name: "classify",
      label: "Classify",
      description: "Classify a request.",
      parameters: Type.Object({ request: Type.String() }),
      async execute(_toolCallId, params) {
        return {
          content: [{ type: "text", text: `classified:${params.request}` }],
          details: { stoppedBy: "workflow-option" as const },
        };
      },
    });
    const streamFn = vi.fn(
      createToolCallStreamFn({
        type: "toolCall",
        id: "call-1",
        name: "classify",
        arguments: { request: "handoff" },
      }),
    );
    const harnesses: ScenarioHarnesses = {
      default: {
        env: createEnv(),
        systemPrompt: "You are helpful.",
        model: mockModel,
        streamFn,
      },
    };
    const tools = [classifyTool] as const;
    const stopOnToolsWorkflow = defineWorkflow(
      { name: "pi-harness-stop-on-tools", schema: z.object({ harnessName: z.string() }) },
      async (event, step) => {
        const params = z.object({ harnessName: z.string() }).parse(event.payload ?? {});
        const harness = harnesses[params.harnessName];
        if (!harness) {
          throw new Error(`Harness ${params.harnessName} not found.`);
        }
        const commandLoop = createAgentLoop(step, {
          workflowName: "pi-harness-stop-on-tools",
          sessionId: event.instanceId,
          agentName: params.harnessName,
          ...harness,
          tools,
          commandTimeout: "1 hour",
        });
        const result = await commandLoop.waitForCommandAndRunStep({ stopOnTools: ["classify"] });
        if (result.kind !== "agentRun") {
          return { skipped: true };
        }

        return commandLoop.summary();
      },
    );
    const config: PiFragmentConfig = { workflows: [stopOnToolsWorkflow] };

    await runScenario(
      defineScenario({
        name: "pi-harness-stop-on-tools",
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
                path: { workflowName: stopOnToolsWorkflow.name },
                body: { name: "Stop Tool Session", input: { harnessName: "default" } },
              });
              assert(session && !Array.isArray(session), "expected session response");
              return session.id;
            },
            storeAs: "sessionId",
          }),
          runners.agent.runUntilIdle({
            workflow: stopOnToolsWorkflow.name,
            instanceId: (ctx) => ctx.vars.sessionId!,
            reason: "create",
          }),
          workflow.read({
            read: async (ctx) => {
              assert(ctx.vars.sessionId, "session id should be set");
              return await clients.user.useCommandSession.mutateQuery({
                path: { workflowName: stopOnToolsWorkflow.name, sessionId: ctx.vars.sessionId },
                body: { kind: "prompt", input: { text: "classify this" } },
              });
            },
          }),
          runners.agent.runUntilIdle({
            workflow: stopOnToolsWorkflow.name,
            instanceId: (ctx) => ctx.vars.sessionId!,
            reason: "event",
          }),
          workflow.read({
            read: async (ctx) =>
              clients.user.useSessionDetail.query({
                path: {
                  workflowName: stopOnToolsWorkflow.name,
                  sessionId: ctx.vars.sessionId!,
                },
              }),
            assert: (detail) => {
              assert(detail && !Array.isArray(detail), "expected session detail response");
              expect(streamFn).toHaveBeenCalledTimes(1);
              assert(detail.workflow.status === "complete");
              expect(detail.agent.state.messages).toMatchObject([
                { role: "user" },
                { role: "assistant", stopReason: "toolUse" },
                { role: "toolResult", toolCallId: "call-1", toolName: "classify" },
              ]);
              expect(detail.agent.state.messages[2]).toMatchObject({
                role: "toolResult",
                content: [{ type: "text", text: "classified:handoff" }],
                details: { stoppedBy: "workflow-option" },
              });
            },
          }),
        ],
      }),
    );
  });

  test("streams tool-call partial JSON to the client before the tool completes", async () => {
    let releaseToolCall!: () => void;
    const toolCallCanFinish = new Promise<void>((resolve) => {
      releaseToolCall = resolve;
    });
    const classifyTool = definePiTool({
      name: "classify",
      label: "Classify",
      description: "Classify a request.",
      parameters: Type.Object({ request: Type.String() }),
      async execute(_toolCallId, params) {
        return {
          content: [{ type: "text", text: `classified:${params.request}` }],
          details: { request: params.request },
          terminate: true,
        };
      },
    });
    const partialArgs = JSON.stringify({ request: "streamed broken" });
    const harnesses: ScenarioHarnesses = {
      default: {
        env: createEnv(),
        systemPrompt: "You are helpful.",
        model: mockModel,
        streamFn: createToolCallStreamFn(
          {
            type: "toolCall",
            id: "call-1",
            name: "classify",
            arguments: { request: "streamed broken" },
          },
          {
            deltas: [partialArgs.slice(0, 12), partialArgs.slice(12)],
            waitBeforeEnd: toolCallCanFinish,
          },
        ),
      },
    };
    const tools = [classifyTool] as const;
    const interactiveChatWorkflow = createInteractiveChatWorkflow({
      harnesses: { default: { ...harnesses["default"]!, tools } },
      name: "interactive-chat-tool-partial-workflow",
    });
    const config: PiFragmentConfig = { workflows: [interactiveChatWorkflow] };

    await runScenario(
      defineScenario({
        name: "pi-harness-interactive-chat-tool-partial",
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
          rawUser: createPiFragmentClients(clientConfig("pi", { runner: "user" })),
          storeUser: createPiFragmentClient(clientConfig("pi", { runner: "user" })),
        }),
        stores: ({ clients, store }) => ({
          userSession: store((ctx) =>
            clients.storeUser.useSession({
              path: { workflowName: interactiveChatWorkflow.name, sessionId: ctx.vars.sessionId! },
            }),
          ),
        }),
        runners: ["agent", "user"],
        steps: ({ workflow, runners, concurrent, clients, stores }) => [
          workflow.read({
            read: async () => {
              const session = await clients.rawUser.useCreateSession.mutateQuery({
                path: { workflowName: interactiveChatWorkflow.name },
                body: { name: "Tool Partial Session", input: { harnessName: "default" } },
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
          stores.userSession.waitFor(
            (state) => state.connectionStatus === "open" && state.agent !== null,
          ),
          concurrent({
            agent: [
              stores.userSession.read(async (session) => {
                await session.sendCommand({ kind: "prompt", input: { text: "classify this" } });
              }),
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
                  return (
                    event.type === "message_update" &&
                    event.message.role === "assistant" &&
                    event.message.content.some(
                      (content) =>
                        content.type === "toolCall" &&
                        "partialJson" in content &&
                        content.partialJson === partialArgs,
                    )
                  );
                },
              }),
              stores.userSession.read(async (session) => {
                await vi.waitFor(() => {
                  expect(session.draftToolCalls.get()).toMatchObject([
                    {
                      toolCallId: "call-1",
                      toolName: "classify",
                      argumentsText: partialArgs,
                      argumentsValue: { request: "streamed broken" },
                      status: "streaming",
                    },
                  ]);
                });
                releaseToolCall();
              }),
            ],
          }),
          workflow.read({
            read: async (ctx) =>
              clients.rawUser.useSessionDetail.query({
                path: {
                  workflowName: interactiveChatWorkflow.name,
                  sessionId: ctx.vars.sessionId!,
                },
              }),
            assert: (detail) => {
              assert(detail && !Array.isArray(detail), "expected session detail response");
              expect(detail.agent.state.messages).toContainEqual(
                expect.objectContaining({
                  role: "toolResult",
                  content: [{ type: "text", text: "classified:streamed broken" }],
                }),
              );
            },
          }),
        ],
      }),
    );
  });
});
