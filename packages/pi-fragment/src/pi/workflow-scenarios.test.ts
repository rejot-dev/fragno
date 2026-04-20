import { describe, expect, it } from "vitest";

import {
  createScenarioSteps,
  defineScenario,
  runScenario,
  type WorkflowScenarioStepRow,
} from "@fragno-dev/workflows/scenario";

import { buildDatabaseFragmentsTest } from "@fragno-dev/test";

import type { AgentMessage } from "@mariozechner/pi-agent-core";

import { piFragmentDefinition } from "./definition";
import { defineAgent } from "./dsl";
import { createPiFragment } from "./factory";
import {
  createFailingStreamFn,
  createStreamFn,
  createTestWorkflows,
  mockModel,
} from "./test-utils";
import { type PiAgentDefinition, type PiAgentLoopState, type PiWorkflowsService } from "./types";
import { PI_WORKFLOW_NAME } from "./workflow/workflow";

type ScenarioStatus = { status: string; output?: unknown; error?: { message?: string } };

const createAgents = (streamFn: PiAgentDefinition["streamFn"]) => ({
  default: defineAgent("default", {
    systemPrompt: "You are helpful.",
    model: mockModel,
    streamFn,
  }),
});

const unusedWorkflowsService = new Proxy(
  {},
  {
    get() {
      return () => {
        throw new Error("UNUSED_TEST_WORKFLOWS_SERVICE");
      };
    },
  },
) as PiWorkflowsService;

const buildScenarioHarness = () => ({
  adapter: { type: "kysely-sqlite" } as const,
  testBuilder: buildDatabaseFragmentsTest().withFragmentFactory(
    "pi",
    piFragmentDefinition,
    ({ adapter }) =>
      createPiFragment(
        { agents: {}, tools: {} },
        { databaseAdapter: adapter },
        { workflows: unusedWorkflowsService },
      ),
  ),
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
      harness: buildScenarioHarness(),
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

  it("restores current-run detail state from replayable workflow state", async () => {
    const agents = createAgents(createStreamFn("assistant:restore"));
    const workflows = createTestWorkflows({ agents, tools: {} });

    type ScenarioVars = {
      restoredState?: PiAgentLoopState;
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "pi-workflows-restore-current-run-state",
      workflows,
      harness: buildScenarioHarness(),
      steps: [
        scenarioSteps.initializeAndRunUntilIdle({
          workflow: "agentLoop",
          id: "session-restore-state",
          params: {
            sessionId: "session-restore-state",
            agentName: "default",
            systemPrompt: "You are helpful.",
            initialMessages: [],
          },
        }),
        scenarioSteps.eventAndRunUntilIdle({
          workflow: "agentLoop",
          instanceId: "session-restore-state",
          event: {
            type: "user_message",
            payload: { text: "restore me", done: false, steeringMode: "one-at-a-time" },
          },
        }),
        scenarioSteps.read({
          read: async (ctx) => {
            return await ctx.harness.fragment.inContext(function () {
              return this.handlerTx()
                .withServiceCalls(() => [
                  ctx.harness.fragment.services.restoreInstanceState(
                    PI_WORKFLOW_NAME,
                    "session-restore-state",
                  ),
                ])
                .transform(({ serviceResult: [result] }) => result)
                .execute();
            });
          },
          storeAs: "restoredState",
        }),
        scenarioSteps.assert((ctx) => {
          const restoredState = ctx.vars.restoredState;
          expect(restoredState).toBeTruthy();
          expect(restoredState?.turn).toBe(1);
          expect(restoredState?.phase).toBe("waiting-for-user");
          expect(restoredState?.waitingFor).toMatchObject({
            type: "user_message",
            turn: 1,
            stepKey: "waitForEvent:wait-user-1",
          });
          expect(restoredState?.events).toHaveLength(1);
          expect(restoredState?.events[0]?.payload).toMatchObject({ text: "restore me" });
          expect(restoredState?.trace.length).toBeGreaterThan(0);
          expect(restoredState?.summaries).toHaveLength(1);
          expect(restoredState?.summaries[0]?.summary).toContain("assistant:restore");
          expect(restoredState?.messages).toMatchObject([{ role: "user" }, { role: "assistant" }]);
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
      harness: buildScenarioHarness(),
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
});
