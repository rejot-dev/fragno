import { assert, describe, expect, test, vi } from "vitest";

import {
  defineScenario,
  runScenario,
  type WorkflowScenarioStepRow,
} from "@fragno-dev/workflows/scenario";
import { Type } from "typebox";
import { z } from "zod";

import { instantiate } from "@fragno-dev/core";

import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";

import { createPiFragmentClient } from "../client/vanilla";
import { piRoutesFactory } from "../routes";
import { piFragmentDefinition } from "./definition";
import { definePiTool, definePiWorkflow } from "./dsl";
import { createPiWorkflows } from "./factory";
import { createAssistantStreamScript, mockModel } from "./pi-test-utils";
import type { PiFragmentConfig } from "./types";
import { interactiveChatWorkflow } from "./workflows/interactive-chat-workflow";

const createAssistantMessage = (stopReason: AssistantMessage["stopReason"]): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text: stopReason }],
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
  stopReason,
  timestamp: Date.now(),
});

describe("Pi workflow scenarios", () => {
  test("stops a workflow agent step after a matching tool call", async () => {
    const classifyTool = definePiTool({
      name: "classify",
      label: "Classify",
      description: "Classify a user request.",
      parameters: Type.Object({ request: Type.String() }),
      async execute(_toolCallId, params) {
        return {
          content: [{ type: "text", text: `classified:${params.request}` }],
          details: { kind: "bug" as const, confidence: 0.91 },
        };
      },
    });
    const { streamFn } = createAssistantStreamScript()
      .toolCall("classify", { id: "call-1", args: { request: "broken" } })
      .build();
    const handoffOutputSchema = z.object({
      stopReason: z.literal("toolUse"),
      messageCount: z.number(),
      toolCall: z.object({
        toolName: z.literal("classify"),
        args: z.object({ request: z.string() }),
        details: z.object({ kind: z.literal("bug"), confidence: z.number() }),
        terminate: z.boolean(),
      }),
    });
    const handoffWorkflow = definePiWorkflow(
      { name: "pi-tool-handoff", schema: z.object({}), outputSchema: handoffOutputSchema },
      async (ctx) => {
        const result = await ctx.agent("default").prompt("classify-request", {
          input: { text: "classify this" },
          stopOnTools: [classifyTool.name],
        });
        if (result.stopReason !== "toolUse") {
          throw new Error(`Expected toolUse stop reason, received ${result.stopReason}.`);
        }
        const toolCall = result.toolCalls(classifyTool.name).latest();

        return handoffOutputSchema.parse({
          stopReason: result.stopReason,
          messageCount: result.messages.length,
          toolCall: {
            toolName: toolCall.toolName,
            args: toolCall.args,
            details: toolCall.details,
            terminate: toolCall.result.terminate === true,
          },
        });
      },
    );
    const config: PiFragmentConfig = {
      agents: {
        default: {
          name: "default",
          systemPrompt: "You are helpful.",
          model: mockModel,
          tools: ["classify"],
          streamFn,
        },
      },
      tools: { classify: classifyTool },
      workflows: [handoffWorkflow],
    };

    await runScenario(
      defineScenario({
        name: "pi-tool-handoff",
        workflows: createPiWorkflows({
          agents: config.agents,
          tools: config.tools,
          workflows: config.workflows,
        }),
        harness: {
          configureFragments: (harness) => ({
            pi: instantiate(piFragmentDefinition)
              .withConfig(config)
              .withRoutes([piRoutesFactory])
              .withServices({ workflows: harness.fragment.services }),
          }),
        },
        runners: ["worker"],
        steps: ({ workflow, runners }) => [
          runners.worker.initializeAndRunUntilIdle({
            workflow: handoffWorkflow.name,
            id: "session-tool-handoff",
            params: {},
          }),
          workflow.read({
            read: async (ctx) => ({
              status: await ctx.state.getStatus(handoffWorkflow.name, "session-tool-handoff"),
              steps: await ctx.state.getSteps(handoffWorkflow.name, "session-tool-handoff"),
            }),
            assert: ({ status, steps }) => {
              assert(status.status === "complete");
              expect(handoffOutputSchema.parse(status.output)).toEqual({
                stopReason: "toolUse",
                messageCount: 3,
                toolCall: {
                  toolName: "classify",
                  args: { request: "broken" },
                  details: { kind: "bug", confidence: 0.91 },
                  terminate: true,
                },
              });
              expect(status).toMatchObject({
                status: "complete",
                output: {
                  stopReason: "toolUse",
                  messageCount: 3,
                  toolCall: {
                    toolName: "classify",
                    args: { request: "broken" },
                    details: { kind: "bug", confidence: 0.91 },
                    terminate: true,
                  },
                },
              });
              expect(steps).toContainEqual(
                expect.objectContaining({
                  stepKey: "do:classify-request",
                  status: "completed",
                  result: expect.objectContaining({
                    stopReason: "toolUse",
                    toolCallResults: [
                      expect.objectContaining({
                        toolName: "classify",
                        args: { request: "broken" },
                        details: { kind: "bug", confidence: 0.91 },
                        result: expect.objectContaining({ terminate: true }),
                      }),
                    ],
                  }),
                }),
              );
            },
          }),
        ],
      }),
    );
  });

  test("aborts an in-flight agent stream", async () => {
    let markStreamStarted!: () => void;
    const streamStarted = new Promise<void>((resolve) => {
      markStreamStarted = resolve;
    });
    const abortObserved = vi.fn();

    const streamFn: StreamFn = (_model, _context, options) => {
      const stream = createAssistantMessageEventStream();
      markStreamStarted();

      const completeAsAborted = () => {
        abortObserved();
        const message = createAssistantMessage("aborted");
        stream.push({ type: "done", reason: "stop", message });
      };

      if (options?.signal?.aborted) {
        completeAsAborted();
      } else {
        options?.signal?.addEventListener("abort", completeAsAborted, { once: true });
      }

      return stream;
    };

    const config: PiFragmentConfig = {
      agents: {
        default: {
          name: "default",
          systemPrompt: "You are helpful.",
          model: mockModel,
          streamFn,
        },
      },
      tools: {},
      workflows: [interactiveChatWorkflow],
    };
    await runScenario(
      defineScenario({
        name: "pi-agent-abort",
        workflows: createPiWorkflows({
          agents: config.agents,
          tools: config.tools,
          workflows: config.workflows,
        }),
        vars: () => ({
          sessionId: undefined as string | undefined,
          steps: undefined as WorkflowScenarioStepRow[] | undefined,
        }),
        harness: {
          configureFragments: (harness) => ({
            pi: instantiate(piFragmentDefinition)
              .withConfig(config)
              .withRoutes([piRoutesFactory])
              .withServices({ workflows: harness.fragment.services }),
          }),
        },
        clients: ({ clientConfig }) => ({
          agent: createPiFragmentClient(clientConfig("pi", { runner: "agent" })),
          user: createPiFragmentClient(clientConfig("pi", { runner: "user" })),
        }),
        stores: ({ clients, store }) => ({
          agentSession: store((ctx) =>
            clients.agent.useSession({ path: { sessionId: ctx.vars.sessionId! } }),
          ),
          userSession: store((ctx) =>
            clients.user.useSession({ path: { sessionId: ctx.vars.sessionId! } }),
          ),
        }),
        runners: ["agent", "user"],
        steps: ({ workflow, runners, concurrent, clients, stores }) => [
          workflow.read({
            read: async () => {
              const session = await clients.user.useCreateSession().mutate({
                body: {
                  workflow: interactiveChatWorkflow.name,
                  name: "Scenario Session",
                  input: { agentName: "default" },
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
          stores.agentSession.waitFor(
            (state) => state.connectionStatus === "open" && state.agent !== null,
          ),
          stores.userSession.waitFor(
            (state) => state.connectionStatus === "open" && state.agent !== null,
          ),
          concurrent({
            agent: [
              stores.agentSession.read(async (session) => {
                await session.sendCommand({
                  kind: "prompt",
                  input: { text: "hello" },
                });
              }),
              runners.agent.runUntilIdle({
                workflow: interactiveChatWorkflow.name,
                instanceId: (ctx) => ctx.vars.sessionId!,
                reason: "event",
              }),
            ],
            user: [
              workflow.read({ read: () => streamStarted }),
              stores.userSession.read(async (session) => {
                await session.sendCommand({ kind: "abort", reason: "test" });
              }),
            ],
          }),
          workflow.read({
            read: (ctx) =>
              ctx.state.getSteps(interactiveChatWorkflow.name, ctx.vars.sessionId ?? ""),
            storeAs: "steps",
          }),
          stores.userSession.waitFor(
            (state) =>
              state.agent?.messages.some(
                (message) => message.role === "assistant" && message.stopReason === "aborted",
              ) ?? false,
            {
              assert: (sessionState) => {
                expect(sessionState.agent?.messages).toContainEqual(
                  expect.objectContaining({ role: "assistant", stopReason: "aborted" }),
                );
              },
            },
          ),
          workflow.assert((ctx) => {
            assert(ctx.vars.sessionId, "sessionId should be set");
            expect(abortObserved).toHaveBeenCalledTimes(1);
            expect(ctx.vars.steps).toContainEqual(
              expect.objectContaining({
                name: "command-0-prompt",
                status: "completed",
                result: expect.objectContaining({ stopReason: "aborted" }),
              }),
            );
          }),
        ],
      }),
    );
  });
});
