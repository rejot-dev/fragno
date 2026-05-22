import { assert, describe, expect, test } from "vitest";

import { defineScenario, runScenario } from "@fragno-dev/workflows/scenario";

import { instantiate } from "@fragno-dev/core";

import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";

import { piRoutesFactory } from "../../routes";
import { piFragmentDefinition } from "../definition";
import { createPiWorkflows, type PiAgentRunner } from "../factory";
import { mockModel } from "../pi-test-utils";
import type { PiFragmentConfig } from "../types";
import { interactiveChatWorkflow } from "../workflows/interactive-chat-workflow";

const createConfig = (): PiFragmentConfig => ({
  agents: {
    default: {
      name: "default",
      systemPrompt: "You are helpful.",
      model: mockModel,
    },
  },
  tools: {},
  workflows: [interactiveChatWorkflow],
});

const assistantMessage: AgentMessage = {
  role: "assistant",
  content: [{ type: "text", text: "I searched." }],
  api: "openai-responses",
  provider: "openai",
  model: "test-model",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  timestamp: Date.now(),
  stopReason: "stop",
};

const toolCallEvents: AgentEvent[] = [
  { type: "agent_start" },
  { type: "tool_execution_start", toolCallId: "call-1", toolName: "search", args: { q: "fragno" } },
  {
    type: "tool_execution_end",
    toolCallId: "call-1",
    toolName: "search",
    result: {
      content: [{ type: "text", text: "found" }],
      details: { url: "https://fragno.dev" },
    },
    isError: false,
  },
  { type: "agent_end", messages: [assistantMessage] },
];

describe("agent loop tool call results", () => {
  test("persists tool call results on agent run steps", async () => {
    const config = createConfig();
    const agentRunner: PiAgentRunner = async (_operation, runtime) => ({
      stopReason: "stop",
      messages: [...runtime.turn.messages, assistantMessage],
      events: toolCallEvents,
      errorMessage: null,
    });

    await runScenario(
      defineScenario({
        name: "pi-agent-tool-call-results",
        workflows: createPiWorkflows({
          agents: config.agents,
          tools: config.tools,
          agentRunner,
          workflows: config.workflows,
        }),
        vars: () => ({
          sessionId: undefined as string | undefined,
        }),
        harness: {
          configureFragments: (harness) => ({
            pi: instantiate(piFragmentDefinition)
              .withConfig(config)
              .withRoutes([piRoutesFactory])
              .withServices({ workflows: harness.fragment.services }),
          }),
        },
        runners: ["agent", "user"],
        steps: ({ workflow, runners }) => [
          workflow.read({
            read: async (ctx) => {
              const response = await ctx.harness.fragments.pi.callRoute("POST", "/sessions", {
                body: {
                  workflow: interactiveChatWorkflow.name,
                  name: "Tool Call Session",
                  input: { agentName: "default" },
                },
              });
              expect(response.type).toBe("json");
              assert(response.type === "json", "expected json response");
              assert(!Array.isArray(response.data), "expected session response");
              return response.data.id;
            },
            storeAs: "sessionId",
          }),
          runners.agent.eventAndRunUntilIdle({
            workflow: interactiveChatWorkflow.name,
            instanceId: (ctx) => ctx.vars.sessionId!,
            event: {
              type: "command",
              payload: { commandId: "command-1", kind: "prompt", input: { text: "hello" } },
            },
          }),
          workflow.read({
            read: async (ctx) => {
              const steps = await ctx.state.getSteps(
                interactiveChatWorkflow.name,
                ctx.vars.sessionId ?? "",
              );
              const agentStep = steps.find((step) => step.stepKey === "do:command-0-prompt");
              expect(agentStep?.result).toMatchObject({
                type: "agent-run",
                toolCallResults: [
                  {
                    toolCallId: "call-1",
                    toolName: "search",
                    args: { q: "fragno" },
                    details: { url: "https://fragno.dev" },
                    isError: false,
                  },
                ],
              });
            },
          }),
        ],
      }),
    );
  });
});
