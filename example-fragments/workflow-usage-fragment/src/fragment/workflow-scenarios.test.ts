import { defineFragment, instantiate } from "@fragno-dev/core";
import { withDatabase } from "@fragno-dev/db";
import { describe, expect, test } from "vitest";
import {
  createScenarioSteps,
  defineScenario,
  runScenario,
  type WorkflowScenarioStepRow,
} from "@fragno-dev/workflows/scenario";
import type { WorkflowUsageAgentDefinition } from "./dsl";
import { workflowUsageSchema } from "./schema";
import { dslWorkflow } from "./workflow";

const usageDbFragment = defineFragment("workflow-usage-fragment")
  .extend(withDatabase(workflowUsageSchema))
  .build();

const inputCalcAgent: WorkflowUsageAgentDefinition = {
  label: "Input Calc Agent",
  systemPrompt: "Accepts two inputs and sums them.",
  dsl: {
    steps: [
      { type: "input", key: "x", assign: "x", label: "get x" },
      { type: "input", key: "y", assign: "y", label: "get y" },
      { type: "calc", expression: "$x + $y", assign: "sum", label: "calculate sum" },
    ],
  },
};

describe("DSL Workflow - Scenario Tests", () => {
  test("completes workflow with input and calculation DSL steps", async () => {
    const workflows = { DSL: dslWorkflow };

    type ScenarioVars = {
      initialStatus?: { status: string };
      finalStatus?: { status: string; output?: unknown };
      steps?: WorkflowScenarioStepRow[];
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "dsl-input-calc-scenario",
      workflows,
      harness: {
        configureBuilder: (builder) => builder.withFragment("usage", instantiate(usageDbFragment)),
      },
      steps: [
        scenarioSteps.initializeAndRunUntilIdle({
          workflow: "DSL",
          id: "dsl-scenario-1",
          params: {
            sessionId: "scenario-session-1",
            agentName: inputCalcAgent.label ?? "scenario-agent",
            systemPrompt: inputCalcAgent.systemPrompt,
            metadata: inputCalcAgent.metadata,
            dsl: inputCalcAgent.dsl,
          },
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("DSL", "dsl-scenario-1"),
          storeAs: "initialStatus",
        }),
        scenarioSteps.eventAndRunUntilIdle({
          workflow: "DSL",
          instanceId: "dsl-scenario-1",
          event: {
            type: "user_message",
            payload: { done: true, x: 10, y: 20 },
          },
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("DSL", "dsl-scenario-1"),
          storeAs: "finalStatus",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getSteps("DSL", "dsl-scenario-1"),
          storeAs: "steps",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.initialStatus?.status).toBe("waiting");
          expect(ctx.vars.finalStatus?.status).toBe("complete");

          const output = ctx.vars.finalStatus?.output as {
            sessionId?: string;
            turns?: number;
            dslState?: Record<string, number>;
          };

          expect(output?.sessionId).toBe("scenario-session-1");
          expect(output?.turns).toBe(1);
          expect(output?.dslState).toEqual({
            x: 10,
            y: 20,
            sum: 30,
          });

          expect(ctx.vars.steps).toHaveLength(7);
          const calcStep = ctx.vars.steps?.find((s) => s.name === "calculate-sum");
          expect(calcStep?.type).toBe("do");
          expect(calcStep?.status).toBe("completed");
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("multi-turn: second turn uses fresh input values, not stale replayed ones", async () => {
    const workflows = { DSL: dslWorkflow };

    type ScenarioVars = {
      statusAfterTurn0?: { status: string };
      finalStatus?: { status: string; output?: unknown };
      steps?: WorkflowScenarioStepRow[];
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "multi-turn-fresh-values",
      workflows,
      harness: {
        configureBuilder: (builder) => builder.withFragment("usage", instantiate(usageDbFragment)),
      },
      steps: [
        scenarioSteps.initializeAndRunUntilIdle({
          workflow: "DSL",
          id: "multi-turn-1",
          params: {
            sessionId: "mt-session",
            agentName: inputCalcAgent.label ?? "mt-agent",
            systemPrompt: inputCalcAgent.systemPrompt,
            dsl: inputCalcAgent.dsl,
          },
        }),
        scenarioSteps.eventAndRunUntilIdle({
          workflow: "DSL",
          instanceId: "multi-turn-1",
          event: {
            type: "user_message",
            payload: { x: 10, y: 20 },
          },
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("DSL", "multi-turn-1"),
          storeAs: "statusAfterTurn0",
        }),
        scenarioSteps.eventAndRunUntilIdle({
          workflow: "DSL",
          instanceId: "multi-turn-1",
          event: {
            type: "user_message",
            payload: { done: true, x: 100, y: 200 },
          },
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("DSL", "multi-turn-1"),
          storeAs: "finalStatus",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.statusAfterTurn0?.status).toBe("waiting");
          expect(ctx.vars.finalStatus?.status).toBe("complete");

          const output = ctx.vars.finalStatus?.output as {
            turns?: number;
            dslState?: Record<string, number>;
          };

          expect(output?.turns).toBe(2);
          expect(output?.dslState).toEqual({
            x: 100,
            y: 200,
            sum: 300,
          });
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("done: false should not terminate the workflow", async () => {
    const noDslAgent: WorkflowUsageAgentDefinition = {
      label: "No DSL Agent",
      systemPrompt: "Agent with no DSL steps.",
    };

    const workflows = { DSL: dslWorkflow };

    type ScenarioVars = {
      statusAfterFalse?: { status: string };
      finalStatus?: { status: string; output?: unknown };
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "done-false-should-not-terminate",
      workflows,
      harness: {
        configureBuilder: (builder) => builder.withFragment("usage", instantiate(usageDbFragment)),
      },
      steps: [
        scenarioSteps.initializeAndRunUntilIdle({
          workflow: "DSL",
          id: "done-false-1",
          params: {
            sessionId: "df-session",
            agentName: noDslAgent.label ?? "df-agent",
            systemPrompt: noDslAgent.systemPrompt,
          },
        }),
        scenarioSteps.eventAndRunUntilIdle({
          workflow: "DSL",
          instanceId: "done-false-1",
          event: {
            type: "user_message",
            payload: { done: false },
          },
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("DSL", "done-false-1"),
          storeAs: "statusAfterFalse",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.statusAfterFalse?.status).toBe("waiting");
        }),
        scenarioSteps.eventAndRunUntilIdle({
          workflow: "DSL",
          instanceId: "done-false-1",
          event: {
            type: "user_message",
            payload: { done: true },
          },
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("DSL", "done-false-1"),
          storeAs: "finalStatus",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.finalStatus?.status).toBe("complete");
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("no DSL: plain event-only workflow completes correctly", async () => {
    const workflows = { DSL: dslWorkflow };

    type ScenarioVars = {
      status?: { status: string; output?: unknown };
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "no-dsl-plain-events",
      workflows,
      harness: {
        configureBuilder: (builder) => builder.withFragment("usage", instantiate(usageDbFragment)),
      },
      steps: [
        scenarioSteps.initializeAndRunUntilIdle({
          workflow: "DSL",
          id: "no-dsl-1",
          params: {
            sessionId: "no-dsl-session",
            agentName: "plain-agent",
          },
        }),
        scenarioSteps.eventAndRunUntilIdle({
          workflow: "DSL",
          instanceId: "no-dsl-1",
          event: { type: "user_message", payload: { msg: "hello" } },
        }),
        scenarioSteps.eventAndRunUntilIdle({
          workflow: "DSL",
          instanceId: "no-dsl-1",
          event: { type: "user_message", payload: { msg: "world" } },
        }),
        scenarioSteps.eventAndRunUntilIdle({
          workflow: "DSL",
          instanceId: "no-dsl-1",
          event: { type: "user_message", payload: { done: true } },
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("DSL", "no-dsl-1"),
          storeAs: "status",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.status?.status).toBe("complete");
          const output = ctx.vars.status?.output as { turns?: number };
          expect(output?.turns).toBe(3);
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("missing input key is skipped and calc referencing it errors", async () => {
    const missingKeyAgent: WorkflowUsageAgentDefinition = {
      label: "Missing Key Agent",
      systemPrompt: "Reads x then calcs with it.",
      dsl: {
        steps: [
          { type: "input", key: "x", assign: "x", label: "get x" },
          { type: "calc", expression: "$x * 2", assign: "doubled", label: "double x" },
        ],
      },
    };

    const workflows = { DSL: dslWorkflow };

    type ScenarioVars = {
      status?: { status: string };
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "missing-input-then-calc-errors",
      workflows,
      harness: {
        configureBuilder: (builder) => builder.withFragment("usage", instantiate(usageDbFragment)),
      },
      steps: [
        scenarioSteps.initializeAndRunUntilIdle({
          workflow: "DSL",
          id: "missing-key-1",
          params: {
            sessionId: "mk-session",
            agentName: missingKeyAgent.label ?? "mk-agent",
            systemPrompt: missingKeyAgent.systemPrompt,
            dsl: missingKeyAgent.dsl,
          },
        }),
        scenarioSteps.eventAndRunUntilIdle({
          workflow: "DSL",
          instanceId: "missing-key-1",
          event: {
            type: "user_message",
            payload: { done: true, notX: 5 },
          },
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("DSL", "missing-key-1"),
          storeAs: "status",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.status?.status).toBe("errored");
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("input with string numeric values are coerced correctly", async () => {
    const workflows = { DSL: dslWorkflow };

    type ScenarioVars = {
      status?: { status: string; output?: unknown };
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "string-numeric-coercion",
      workflows,
      harness: {
        configureBuilder: (builder) => builder.withFragment("usage", instantiate(usageDbFragment)),
      },
      steps: [
        scenarioSteps.initializeAndRunUntilIdle({
          workflow: "DSL",
          id: "string-num-1",
          params: {
            sessionId: "sn-session",
            agentName: "string-agent",
            dsl: inputCalcAgent.dsl,
          },
        }),
        scenarioSteps.eventAndRunUntilIdle({
          workflow: "DSL",
          instanceId: "string-num-1",
          event: {
            type: "user_message",
            payload: { done: true, x: "7", y: "3" },
          },
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("DSL", "string-num-1"),
          storeAs: "status",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.status?.status).toBe("complete");
          const output = ctx.vars.status?.output as { dslState?: Record<string, number> };
          expect(output?.dslState).toEqual({ x: 7, y: 3, sum: 10 });
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("input with empty string coerces to 0", async () => {
    const singleInputAgent: WorkflowUsageAgentDefinition = {
      label: "Single Input Agent",
      systemPrompt: "Reads a single value.",
      dsl: {
        steps: [{ type: "input", key: "val", assign: "val", label: "get val" }],
      },
    };

    const workflows = { DSL: dslWorkflow };

    type ScenarioVars = {
      status?: { status: string; output?: unknown };
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "empty-string-is-zero",
      workflows,
      harness: {
        configureBuilder: (builder) => builder.withFragment("usage", instantiate(usageDbFragment)),
      },
      steps: [
        scenarioSteps.initializeAndRunUntilIdle({
          workflow: "DSL",
          id: "empty-str-1",
          params: {
            sessionId: "es-session",
            agentName: singleInputAgent.label ?? "es-agent",
            dsl: singleInputAgent.dsl,
          },
        }),
        scenarioSteps.eventAndRunUntilIdle({
          workflow: "DSL",
          instanceId: "empty-str-1",
          event: {
            type: "user_message",
            payload: { done: true, val: "" },
          },
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("DSL", "empty-str-1"),
          storeAs: "status",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.status?.status).toBe("complete");
          const output = ctx.vars.status?.output as { dslState?: Record<string, number> };
          expect(output?.dslState?.["val"]).toBe(0);
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("input without explicit assign defaults to key name", async () => {
    const noAssignAgent: WorkflowUsageAgentDefinition = {
      label: "No Assign Agent",
      systemPrompt: "Input without assign field.",
      dsl: {
        steps: [
          { type: "input", key: "score" },
          { type: "calc", expression: "$score * 10", assign: "scaled", label: "scale score" },
        ],
      },
    };

    const workflows = { DSL: dslWorkflow };

    type ScenarioVars = {
      status?: { status: string; output?: unknown };
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "input-defaults-to-key-name",
      workflows,
      harness: {
        configureBuilder: (builder) => builder.withFragment("usage", instantiate(usageDbFragment)),
      },
      steps: [
        scenarioSteps.initializeAndRunUntilIdle({
          workflow: "DSL",
          id: "no-assign-1",
          params: {
            sessionId: "na-session",
            agentName: noAssignAgent.label ?? "na-agent",
            dsl: noAssignAgent.dsl,
          },
        }),
        scenarioSteps.eventAndRunUntilIdle({
          workflow: "DSL",
          instanceId: "no-assign-1",
          event: {
            type: "user_message",
            payload: { done: true, score: 42 },
          },
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("DSL", "no-assign-1"),
          storeAs: "status",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.status?.status).toBe("complete");
          const output = ctx.vars.status?.output as { dslState?: Record<string, number> };
          expect(output?.dslState).toEqual({ score: 42, scaled: 420 });
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("random step produces value and assigns to state", async () => {
    const randomAgent: WorkflowUsageAgentDefinition = {
      label: "Random Agent",
      systemPrompt: "Generates a random integer.",
      dsl: {
        steps: [
          { type: "random", min: 1, max: 100, round: "round", assign: "roll", label: "roll dice" },
        ],
      },
    };

    const workflows = { DSL: dslWorkflow };

    type ScenarioVars = {
      status?: { status: string; output?: unknown };
      steps?: WorkflowScenarioStepRow[];
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "random-step-assigns",
      workflows,
      harness: {
        configureBuilder: (builder) => builder.withFragment("usage", instantiate(usageDbFragment)),
      },
      steps: [
        scenarioSteps.initializeAndRunUntilIdle({
          workflow: "DSL",
          id: "random-1",
          params: {
            sessionId: "rand-session",
            agentName: randomAgent.label ?? "rand-agent",
            dsl: randomAgent.dsl,
          },
        }),
        scenarioSteps.eventAndRunUntilIdle({
          workflow: "DSL",
          instanceId: "random-1",
          event: { type: "user_message", payload: { done: true } },
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("DSL", "random-1"),
          storeAs: "status",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getSteps("DSL", "random-1"),
          storeAs: "steps",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.status?.status).toBe("complete");
          const output = ctx.vars.status?.output as { dslState?: Record<string, number> };
          const roll = output?.dslState?.["roll"];
          expect(roll).toBeTypeOf("number");
          expect(roll).toBeGreaterThanOrEqual(1);
          expect(roll).toBeLessThanOrEqual(100);
          expect(Number.isInteger(roll)).toBe(true);

          const rollStep = ctx.vars.steps?.find((s) => s.name === "roll-dice");
          expect(rollStep?.type).toBe("do");
          expect(rollStep?.status).toBe("completed");
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("calc chain: multiple calcs referencing each other", async () => {
    const chainAgent: WorkflowUsageAgentDefinition = {
      label: "Chain Agent",
      systemPrompt: "Chains calculations.",
      dsl: {
        steps: [
          { type: "input", key: "base", assign: "base", label: "get base" },
          { type: "calc", expression: "$base * 2", assign: "doubled", label: "double" },
          { type: "calc", expression: "$doubled + $base", assign: "tripled", label: "triple" },
          { type: "calc", expression: "$tripled * $tripled", assign: "squared", label: "square" },
        ],
      },
    };

    const workflows = { DSL: dslWorkflow };

    type ScenarioVars = {
      status?: { status: string; output?: unknown };
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "calc-chain",
      workflows,
      harness: {
        configureBuilder: (builder) => builder.withFragment("usage", instantiate(usageDbFragment)),
      },
      steps: [
        scenarioSteps.initializeAndRunUntilIdle({
          workflow: "DSL",
          id: "chain-1",
          params: {
            sessionId: "chain-session",
            agentName: chainAgent.label ?? "chain-agent",
            dsl: chainAgent.dsl,
          },
        }),
        scenarioSteps.eventAndRunUntilIdle({
          workflow: "DSL",
          instanceId: "chain-1",
          event: {
            type: "user_message",
            payload: { done: true, base: 5 },
          },
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("DSL", "chain-1"),
          storeAs: "status",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.status?.status).toBe("complete");
          const output = ctx.vars.status?.output as { dslState?: Record<string, number> };
          expect(output?.dslState).toEqual({
            base: 5,
            doubled: 10,
            tripled: 15,
            squared: 225,
          });
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("primitive payload is treated as empty object for input steps", async () => {
    const workflows = { DSL: dslWorkflow };

    type ScenarioVars = {
      status?: { status: string; output?: unknown };
      steps?: WorkflowScenarioStepRow[];
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "primitive-payload",
      workflows,
      harness: {
        configureBuilder: (builder) => builder.withFragment("usage", instantiate(usageDbFragment)),
      },
      steps: [
        scenarioSteps.initializeAndRunUntilIdle({
          workflow: "DSL",
          id: "prim-1",
          params: {
            sessionId: "prim-session",
            agentName: "prim-agent",
            dsl: {
              steps: [{ type: "input", key: "x", assign: "x", label: "get x" }],
            },
          },
        }),
        scenarioSteps.eventAndRunUntilIdle({
          workflow: "DSL",
          instanceId: "prim-1",
          event: { type: "user_message", payload: "just a string" as unknown },
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getSteps("DSL", "prim-1"),
          storeAs: "steps",
        }),
        scenarioSteps.assert((ctx) => {
          const inputStep = ctx.vars.steps?.find((s) => s.name === "get-x");
          expect(inputStep?.status).toBe("completed");
          const result = inputStep?.result as { skipped?: boolean };
          expect(result?.skipped).toBe(true);
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("wait step advances with time", async () => {
    const waitAgent: WorkflowUsageAgentDefinition = {
      label: "Wait Agent",
      systemPrompt: "Agent that waits before computing.",
      dsl: {
        steps: [
          { type: "wait", duration: "5s", label: "pause" },
          { type: "calc", expression: "1 + 1", assign: "result", label: "compute" },
        ],
      },
    };

    const workflows = { DSL: dslWorkflow };

    type ScenarioVars = {
      statusBeforeAdvance?: { status: string };
      statusAfterAdvance?: { status: string; output?: unknown };
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "wait-step-time-advance",
      workflows,
      harness: {
        configureBuilder: (builder) => builder.withFragment("usage", instantiate(usageDbFragment)),
      },
      steps: [
        scenarioSteps.initializeAndRunUntilIdle({
          workflow: "DSL",
          id: "wait-1",
          params: {
            sessionId: "wait-session",
            agentName: waitAgent.label ?? "wait-agent",
            dsl: waitAgent.dsl,
          },
        }),
        scenarioSteps.eventAndRunUntilIdle({
          workflow: "DSL",
          instanceId: "wait-1",
          event: { type: "user_message", payload: { done: true } },
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("DSL", "wait-1"),
          storeAs: "statusBeforeAdvance",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.statusBeforeAdvance?.status).toBe("waiting");
        }),
        scenarioSteps.advanceTimeAndRunUntilIdle({
          workflow: "DSL",
          instanceId: "wait-1",
          advanceBy: "6s",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("DSL", "wait-1"),
          storeAs: "statusAfterAdvance",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.statusAfterAdvance?.status).toBe("complete");
          const output = ctx.vars.statusAfterAdvance?.output as {
            dslState?: Record<string, number>;
          };
          expect(output?.dslState?.["result"]).toBe(2);
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("onSessionCompleted hook fires with full DSL state", async () => {
    const workflows = { DSL: dslWorkflow };

    type ScenarioVars = {
      hooks?: { hookName: string; payload: unknown }[];
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "on-session-completed-hook",
      workflows,
      harness: {
        configureBuilder: (builder) => builder.withFragment("usage", instantiate(usageDbFragment)),
      },
      steps: [
        scenarioSteps.initializeAndRunUntilIdle({
          workflow: "DSL",
          id: "hook-test-1",
          params: {
            sessionId: "hook-session",
            agentName: "hook-agent",
            dsl: inputCalcAgent.dsl,
          },
        }),
        scenarioSteps.eventAndRunUntilIdle({
          workflow: "DSL",
          instanceId: "hook-test-1",
          event: {
            type: "user_message",
            payload: { done: true, x: 3, y: 7 },
          },
        }),
        scenarioSteps.read({
          read: (ctx) =>
            ctx.state.internal.getHooks({
              namespace: "workflow_usage_fragment",
              hookName: "onSessionCompleted",
            }),
          storeAs: "hooks",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.hooks).toHaveLength(1);
          const hook = ctx.vars.hooks![0];
          expect(hook.hookName).toBe("onSessionCompleted");

          const payload = hook.payload as {
            sessionId: string;
            agentName: string;
            turns: number;
            dslState: Record<string, number>;
          };

          expect(payload.sessionId).toBe("hook-session");
          expect(payload.agentName).toBe("hook-agent");
          expect(payload.turns).toBe(1);
          expect(payload.dslState).toEqual({ x: 3, y: 7, sum: 10 });
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("two concurrent workflow instances track state independently", async () => {
    const workflows = { DSL: dslWorkflow };

    type ScenarioVars = {
      statusA?: { status: string; output?: unknown };
      statusB?: { status: string; output?: unknown };
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "concurrent-instances",
      workflows,
      harness: {
        configureBuilder: (builder) => builder.withFragment("usage", instantiate(usageDbFragment)),
      },
      steps: [
        scenarioSteps.initializeAndRunUntilIdle({
          workflow: "DSL",
          id: "concurrent-a",
          params: {
            sessionId: "session-a",
            agentName: "agent-a",
            dsl: inputCalcAgent.dsl,
          },
        }),
        scenarioSteps.initializeAndRunUntilIdle({
          workflow: "DSL",
          id: "concurrent-b",
          params: {
            sessionId: "session-b",
            agentName: "agent-b",
            dsl: inputCalcAgent.dsl,
          },
        }),
        scenarioSteps.eventAndRunUntilIdle({
          workflow: "DSL",
          instanceId: "concurrent-a",
          event: {
            type: "user_message",
            payload: { done: true, x: 1, y: 2 },
          },
        }),
        scenarioSteps.eventAndRunUntilIdle({
          workflow: "DSL",
          instanceId: "concurrent-b",
          event: {
            type: "user_message",
            payload: { done: true, x: 100, y: 200 },
          },
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("DSL", "concurrent-a"),
          storeAs: "statusA",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("DSL", "concurrent-b"),
          storeAs: "statusB",
        }),
        scenarioSteps.assert((ctx) => {
          const outputA = ctx.vars.statusA?.output as { dslState?: Record<string, number> };
          const outputB = ctx.vars.statusB?.output as { dslState?: Record<string, number> };

          expect(ctx.vars.statusA?.status).toBe("complete");
          expect(ctx.vars.statusB?.status).toBe("complete");

          expect(outputA?.dslState).toEqual({ x: 1, y: 2, sum: 3 });
          expect(outputB?.dslState).toEqual({ x: 100, y: 200, sum: 300 });
        }),
      ],
    });

    await runScenario(scenario);
  });
});
