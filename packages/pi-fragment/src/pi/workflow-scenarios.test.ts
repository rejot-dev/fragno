import { describe, expect, it } from "vitest";
import {
  createScenarioSteps,
  defineScenario,
  runScenario,
  type WorkflowScenarioStepRow,
} from "@fragno-dev/workflows/scenario";
import type { AgentMessage } from "@mariozechner/pi-agent-core";

import {
  createFailingStreamFn,
  createStreamFn,
  createTestWorkflows,
  mockModel,
} from "./test-utils";
import { defineAgent } from "./dsl";
import type { PiAgentDefinition } from "./types";

type ScenarioStatus = { status: string; output?: unknown };

const createAgents = (streamFn: PiAgentDefinition["streamFn"]) => ({
  default: defineAgent("default", {
    systemPrompt: "You are helpful.",
    model: mockModel,
    streamFn,
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
          };
          expect(assistantResult?.assistant).toMatchObject({ role: "assistant" });
          expect(Array.isArray(assistantResult?.trace)).toBe(true);
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
});
