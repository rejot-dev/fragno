import { describe, expect, test } from "vitest";

import { BufferedPumpRegistry } from "@fragno-dev/db/buffered-pump";
import { column, idColumn, schema } from "@fragno-dev/db/schema";

import {
  defineFragment,
  instantiate,
  type AnyFragnoInstantiatedFragment,
  type InstantiatedFragmentFromDefinition,
} from "@fragno-dev/core";
import { withDatabase } from "@fragno-dev/db";

import type { WorkflowStepLivePump } from "./runner/step-live-pump";
import {
  createScenarioSteps,
  defineScenario,
  runScenario,
  type WorkflowScenarioEventRow,
  type WorkflowScenarioHookRow,
  type WorkflowScenarioInstanceRow,
  type WorkflowScenarioStepRow,
} from "./scenario";
import { workflowsSchema } from "./schema";
import { createWorkflowsTestRuntime } from "./test";
import { defineWorkflow, WaitForEventTimeoutError } from "./workflow";

type RouteResponse = {
  type: string;
  data?: unknown;
  error?: { message: string; code: string };
};

const assertJsonResponse = <T>(response: RouteResponse) => {
  expect(response.type).toBe("json");
  if (response.type !== "json") {
    const errorDetails =
      response.type === "error"
        ? ` (${response.error?.code ?? "UNKNOWN"}: ${response.error?.message ?? "Unknown error"})`
        : "";
    throw new Error(`Expected json response, received ${response.type}${errorDetails}`);
  }
  return response.data as T;
};

const assertOkResponse = (response: RouteResponse) => {
  const data = assertJsonResponse<{ ok: true }>(response);
  expect(data.ok).toBe(true);
};

describe("Workflows Runner (Scenario DSL)", () => {
  test("runs a simple workflow to completion", async () => {
    const SimpleWorkflow = defineWorkflow({ name: "simple-workflow" }, async () => {
      return { ok: true };
    });

    const workflows = { SIMPLE: SimpleWorkflow };

    type ScenarioVars = {
      status?: { status: string; output?: unknown };
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "simple-workflow-complete",
      workflows,
      steps: [
        scenarioSteps.initializeAndRunUntilIdle({ workflow: "SIMPLE", id: "simple-1" }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("SIMPLE", "simple-1"),
          storeAs: "status",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.status?.status).toBe("complete");
          expect(ctx.vars.status?.output).toEqual({ ok: true });
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("records a completed step", async () => {
    const StepWorkflow = defineWorkflow({ name: "step-workflow" }, async (_event, step) => {
      const value = await step.do("compute", () => 42);
      return { value };
    });

    const workflows = { STEP: StepWorkflow };

    type ScenarioVars = {
      status?: { status: string; output?: { value: number } };
      steps?: WorkflowScenarioStepRow[];
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "completed-step",
      workflows,
      steps: [
        scenarioSteps.initializeAndRunUntilIdle({ workflow: "STEP", id: "step-1" }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("STEP", "step-1"),
          storeAs: "status",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getSteps("STEP", "step-1"),
          storeAs: "steps",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.status?.status).toBe("complete");
          expect(ctx.vars.status?.output).toEqual({ value: 42 });
          expect(ctx.vars.steps).toHaveLength(1);
          expect(ctx.vars.steps?.[0]).toMatchObject({
            name: "compute",
            type: "do",
            status: "completed",
            stepKey: "do:compute",
          });
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("runs multiple steps and consumes a buffered event", async () => {
    const EventWorkflow = defineWorkflow({ name: "eventful-workflow" }, async (_event, step) => {
      const seed = await step.do("seed", () => 3);
      const ready = await step.waitForEvent<{ value: number }>("ready", { type: "ready" });
      const sum = await step.do("sum", () => seed + ready.payload.value);
      return { seed, sum, eventValue: ready.payload.value };
    });

    const workflows = { EVENTFUL: EventWorkflow };

    type ScenarioVars = {
      status?: { status: string; output?: unknown };
      steps?: WorkflowScenarioStepRow[];
      events?: WorkflowScenarioEventRow[];
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "eventful-workflow",
      workflows,
      steps: [
        scenarioSteps.initializeAndRunUntilIdle({ workflow: "EVENTFUL", id: "eventful-1" }),
        scenarioSteps.eventAndRunUntilIdle({
          workflow: "EVENTFUL",
          instanceId: "eventful-1",
          event: { type: "ready", payload: { value: 9 } },
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("EVENTFUL", "eventful-1"),
          storeAs: "status",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getSteps("EVENTFUL", "eventful-1"),
          storeAs: "steps",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getEvents("EVENTFUL", "eventful-1"),
          storeAs: "events",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.status?.status).toBe("complete");
          expect(ctx.vars.status?.output).toEqual({ seed: 3, sum: 12, eventValue: 9 });
          expect(ctx.vars.steps).toHaveLength(3);
          expect(ctx.vars.steps?.map((step) => step.stepKey).sort()).toEqual([
            "do:seed",
            "do:sum",
            "waitForEvent:ready",
          ]);
          expect(ctx.vars.events).toHaveLength(1);
          expect(ctx.vars.events?.[0]).toMatchObject({
            type: "ready",
            consumedByStepKey: "waitForEvent:ready",
          });
          expect(ctx.vars.events?.[0].deliveredAt).toBeInstanceOf(Date);
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("runs parallel steps and records both results", async () => {
    const ParallelWorkflow = defineWorkflow({ name: "parallel-workflow" }, async (_event, step) => {
      const [alpha, beta] = await Promise.all([
        step.do("alpha", async () => "A"),
        step.do("beta", async () => "B"),
      ]);
      return { alpha, beta };
    });

    const workflows = { PARALLEL: ParallelWorkflow };

    type ScenarioVars = {
      status?: { status: string; output?: { alpha: string; beta: string } };
      steps?: WorkflowScenarioStepRow[];
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "parallel-steps",
      workflows,
      steps: [
        scenarioSteps.initializeAndRunUntilIdle({ workflow: "PARALLEL", id: "parallel-1" }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("PARALLEL", "parallel-1"),
          storeAs: "status",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getSteps("PARALLEL", "parallel-1"),
          storeAs: "steps",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.status?.status).toBe("complete");
          expect(ctx.vars.status?.output).toEqual({ alpha: "A", beta: "B" });
          expect(ctx.vars.steps).toHaveLength(2);
          expect(ctx.vars.steps?.map((step) => step.stepKey).sort()).toEqual([
            "do:alpha",
            "do:beta",
          ]);
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("supports nested Promise.race with stable nested identity after a fast winner", async () => {
    const RaceWorkflow = defineWorkflow({ name: "race-workflow" }, async (_event, step) => {
      const raceReturn = await step.do("Promise step", async () => {
        return await Promise.race([
          step.do("Promise first race", async () => {
            await step.sleep("Promise first delay", 1000);
            return "first";
          }),
          step.do("Promise second race", async () => {
            return "second";
          }),
        ]);
      });

      const cached = await step.do("After race", async () => raceReturn);
      return { raceReturn, cached };
    });

    const workflows = { RACE: RaceWorkflow };

    type ScenarioVars = {
      status?: { status: string; output?: { raceReturn: string; cached: string } };
      steps?: WorkflowScenarioStepRow[];
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "promise-race-step",
      workflows,
      steps: [
        scenarioSteps.initializeAndRunUntilIdle({ workflow: "RACE", id: "race-1" }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("RACE", "race-1"),
          storeAs: "status",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getSteps("RACE", "race-1"),
          storeAs: "steps",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.status?.status).toBe("complete");
          expect(ctx.vars.status?.output).toEqual({ raceReturn: "second", cached: "second" });
          expect(ctx.vars.steps).toHaveLength(5);
          expect(ctx.vars.steps).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                stepKey: "do:Promise step",
                parentStepKey: null,
                depth: 0,
                status: "completed",
                result: "second",
              }),
              expect.objectContaining({
                stepKey: "do:Promise step>do:Promise first race",
                parentStepKey: "do:Promise step",
                depth: 1,
                status: "waiting",
              }),
              expect.objectContaining({
                stepKey: "do:Promise step>do:Promise second race",
                parentStepKey: "do:Promise step",
                depth: 1,
                status: "completed",
                result: "second",
              }),
              expect.objectContaining({
                stepKey: "do:Promise step>do:Promise first race>sleep:Promise first delay",
                parentStepKey: "do:Promise step>do:Promise first race",
                depth: 2,
                status: "waiting",
              }),
              expect.objectContaining({
                stepKey: "do:After race",
                parentStepKey: null,
                depth: 0,
                status: "completed",
                result: "second",
              }),
            ]),
          );
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("supports nested Promise.race between a slow step and an event wait", async () => {
    const RaceEventWorkflow = defineWorkflow(
      { name: "race-event-workflow" },
      async (_event, step) => {
        const raceReturn = await step.do("Promise race", async () => {
          return await Promise.race([
            step.do("slow branch", async () => {
              await step.sleep("slow delay", 1000);
              return "slow";
            }),
            step.waitForEvent("event branch", { type: "ready" }).then(() => "event"),
          ]);
        });

        const cached = await step.do("After race", async () => raceReturn);
        return { raceReturn, cached };
      },
    );

    const workflows = { RACE_EVENT: RaceEventWorkflow };

    type ScenarioVars = {
      waitingStatus?: { status: string };
      finalStatus?: { status: string; output?: { raceReturn: string; cached: string } };
      steps?: WorkflowScenarioStepRow[];
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "promise-race-slow-step-event-wait",
      workflows,
      steps: [
        scenarioSteps.initializeAndRunUntilIdle({ workflow: "RACE_EVENT", id: "race-event-1" }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("RACE_EVENT", "race-event-1"),
          storeAs: "waitingStatus",
        }),
        scenarioSteps.eventAndRunUntilIdle({
          workflow: "RACE_EVENT",
          instanceId: "race-event-1",
          event: { type: "ready" },
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("RACE_EVENT", "race-event-1"),
          storeAs: "finalStatus",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getSteps("RACE_EVENT", "race-event-1"),
          storeAs: "steps",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.waitingStatus?.status).toBe("waiting");
          expect(ctx.vars.finalStatus).toMatchObject({
            status: "complete",
            output: { raceReturn: "event", cached: "event" },
          });
          expect(ctx.vars.steps).toHaveLength(5);
          expect(ctx.vars.steps).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                stepKey: "do:Promise race",
                parentStepKey: null,
                depth: 0,
                status: "completed",
                result: "event",
              }),
              expect.objectContaining({
                stepKey: "do:Promise race>do:slow branch",
                parentStepKey: "do:Promise race",
                depth: 1,
                status: "waiting",
              }),
              expect.objectContaining({
                stepKey: "do:Promise race>waitForEvent:event branch",
                parentStepKey: "do:Promise race",
                depth: 1,
                status: "completed",
              }),
              expect.objectContaining({
                stepKey: "do:Promise race>do:slow branch>sleep:slow delay",
                parentStepKey: "do:Promise race>do:slow branch",
                depth: 2,
                status: "waiting",
              }),
              expect.objectContaining({
                stepKey: "do:After race",
                parentStepKey: null,
                depth: 0,
                status: "completed",
                result: "event",
              }),
            ]),
          );
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("supports nested Promise.any inside an outer step", async () => {
    const AnyWorkflow = defineWorkflow({ name: "any-workflow" }, async (_event, step) => {
      const anyReturn = await step.do("Promise any", async () => {
        return await Promise.any([
          step.do("Promise any first", async () => {
            await step.sleep("Promise any first delay", 1000);
            return "first";
          }),
          step.do("Promise any second", async () => {
            return "second";
          }),
        ]);
      });

      return { anyReturn };
    });

    const workflows = { ANY: AnyWorkflow };

    type ScenarioVars = {
      status?: { status: string; output?: { anyReturn: string } };
      steps?: WorkflowScenarioStepRow[];
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "promise-any-step",
      workflows,
      steps: [
        scenarioSteps.initializeAndRunUntilIdle({ workflow: "ANY", id: "any-1" }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("ANY", "any-1"),
          storeAs: "status",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getSteps("ANY", "any-1"),
          storeAs: "steps",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.status?.status).toBe("complete");
          expect(ctx.vars.status?.output).toEqual({ anyReturn: "second" });
          expect(ctx.vars.steps?.map((step) => step.stepKey)).toEqual(
            expect.arrayContaining([
              "do:Promise any",
              "do:Promise any>do:Promise any first",
              "do:Promise any>do:Promise any second",
              "do:Promise any>do:Promise any first>sleep:Promise any first delay",
            ]),
          );
          expect(ctx.vars.steps).toHaveLength(4);
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("can resume a waiting workflow after killing the runner", async () => {
    const RestartWorkflow = defineWorkflow(
      { name: "scenario-kill-runner" },
      async (_event, step) => {
        await step.waitForEvent("ready", { type: "ready" });
        return await step.do("finish", async () => "done");
      },
    );

    const workflows = { RESTART: RestartWorkflow };

    type ScenarioVars = {
      waitingStatus?: { status: string };
      finalStatus?: { status: string; output?: string };
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "scenario-kill-runner",
      workflows,
      steps: [
        scenarioSteps.initializeAndRunUntilIdle({ workflow: "RESTART", id: "restart-1" }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("RESTART", "restart-1"),
          storeAs: "waitingStatus",
        }),
        scenarioSteps.killAndRestartRunner(),
        scenarioSteps.eventAndRunUntilIdle({
          workflow: "RESTART",
          instanceId: "restart-1",
          event: { type: "ready" },
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("RESTART", "restart-1"),
          storeAs: "finalStatus",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.waitingStatus?.status).toBe("waiting");
          expect(ctx.vars.finalStatus).toMatchObject({ status: "complete", output: "done" });
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("event runner wins a nested Promise.race against a normal promise sleep", async () => {
    const runtime = createWorkflowsTestRuntime();

    const RaceRunnerWorkflow = defineWorkflow(
      { name: "scenario-race-event-second-runner-wins" },
      async (_event, step) => {
        const raceReturn = await step.do("Promise race", async () => {
          return await Promise.race([
            step.do("promise sleep branch", async () => {
              runtime.controls.resolve("sleep:started");
              await new Promise((resolve) => setTimeout(resolve, 20));
              return "sleep";
            }),
            step.waitForEvent("event branch", { type: "ready" }).then(() => "event"),
          ]);
        });

        const cached = await step.do("After race", async () => raceReturn);
        return { raceReturn, cached };
      },
    );

    const workflows = { RACE: RaceRunnerWorkflow };

    type ScenarioVars = {
      createTick?: number;
      eventTick?: number;
      status?: { status: string; output?: { raceReturn: string; cached: string } };
      steps?: WorkflowScenarioStepRow[];
      events?: WorkflowScenarioEventRow[];
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "scenario-race-event-second-runner-wins",
      workflows,
      harness: { runtime },
      steps: [
        scenarioSteps.create({ workflow: "RACE", id: "race-runner-1" }),
        scenarioSteps.withRunners({
          create: [
            scenarioSteps.tick({
              workflow: "RACE",
              instanceId: "race-runner-1",
              reason: "create",
              storeAs: "createTick",
            }),
          ],
          event: [
            scenarioSteps.waitForControl({ key: "sleep:started" }),
            scenarioSteps.event({
              workflow: "RACE",
              instanceId: "race-runner-1",
              event: { type: "ready" },
            }),
            scenarioSteps.tick({
              workflow: "RACE",
              instanceId: "race-runner-1",
              reason: "event",
              storeAs: "eventTick",
            }),
          ],
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("RACE", "race-runner-1"),
          storeAs: "status",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getSteps("RACE", "race-runner-1"),
          storeAs: "steps",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getEvents("RACE", "race-runner-1"),
          storeAs: "events",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.createTick).toBe(1);
          expect(ctx.vars.eventTick).toBe(1);
          expect(ctx.vars.status).toMatchObject({
            status: "complete",
            output: { raceReturn: "event", cached: "event" },
          });
          expect(ctx.vars.steps).toMatchObject([
            {
              stepKey: "do:Promise race",
              parentStepKey: null,
              depth: 0,
              status: "completed",
              result: "event",
            },
            {
              stepKey: "do:Promise race>do:promise sleep branch",
              parentStepKey: "do:Promise race",
              depth: 1,
              status: "waiting",
            },
            {
              stepKey: "do:Promise race>waitForEvent:event branch",
              parentStepKey: "do:Promise race",
              depth: 1,
              status: "completed",
            },
            {
              stepKey: "do:After race",
              parentStepKey: null,
              depth: 0,
              status: "completed",
              result: "event",
            },
          ]);
          expect(ctx.vars.events).toHaveLength(1);
          expect(ctx.vars.events?.[0]).toMatchObject({
            type: "ready",
            consumedByStepKey: "do:Promise race>waitForEvent:event branch",
          });
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("event sent before waitForEvent is persisted is buffered and enqueues a later tick", async () => {
    const runtime = createWorkflowsTestRuntime();

    const EventBeforeWaitWorkflow = defineWorkflow(
      { name: "scenario-event-before-wait-persisted" },
      async (_event, step) => {
        await step.do("slow promise", async () => {
          runtime.controls.resolve("slow:started");
          await new Promise((resolve) => setTimeout(resolve, 20));
        });

        await step.waitForEvent("ready", { type: "ready" });
        return "done";
      },
    );

    const workflows = { EARLY_EVENT: EventBeforeWaitWorkflow };

    type ScenarioVars = {
      eventStatus?: { status: string; output?: string };
      createTick?: number;
      statusAfterCreate?: { status: string; output?: string };
      eventsAfterCreate?: WorkflowScenarioEventRow[];
      hooksAfterCreate?: WorkflowScenarioHookRow[];
      finalRun?: { processed: number; ticks: number };
      finalStatus?: { status: string; output?: string };
      events?: WorkflowScenarioEventRow[];
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "scenario-event-before-wait-persisted-enqueues",
      workflows,
      harness: { runtime },
      steps: [
        scenarioSteps.create({ workflow: "EARLY_EVENT", id: "early-event-1" }),
        scenarioSteps.withRunners({
          create: [
            scenarioSteps.tick({
              workflow: "EARLY_EVENT",
              instanceId: "early-event-1",
              reason: "create",
              storeAs: "createTick",
            }),
            scenarioSteps.resolveControl({ key: "create:tick:done" }),
          ],
          event: [
            scenarioSteps.waitForControl({ key: "slow:started" }),
            scenarioSteps.event({
              workflow: "EARLY_EVENT",
              instanceId: "early-event-1",
              event: { type: "ready" },
              storeAs: "eventStatus",
            }),
            scenarioSteps.waitForControl({ key: "create:tick:done" }),
            scenarioSteps.read({
              read: (ctx) => ctx.state.getStatus("EARLY_EVENT", "early-event-1"),
              storeAs: "statusAfterCreate",
            }),
            scenarioSteps.read({
              read: (ctx) => ctx.state.getEvents("EARLY_EVENT", "early-event-1"),
              storeAs: "eventsAfterCreate",
            }),
            scenarioSteps.read({
              read: (ctx) =>
                ctx.state.internal.getHooks({
                  hookName: "onWorkflowEnqueued",
                  workflowName: "scenario-event-before-wait-persisted",
                  instanceId: "early-event-1",
                }),
              storeAs: "hooksAfterCreate",
            }),
            scenarioSteps.runUntilIdle({
              workflow: "EARLY_EVENT",
              instanceId: "early-event-1",
              reason: "event",
              storeAs: "finalRun",
            }),
          ],
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("EARLY_EVENT", "early-event-1"),
          storeAs: "finalStatus",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getEvents("EARLY_EVENT", "early-event-1"),
          storeAs: "events",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.eventStatus?.status).toBe("active");
          expect(ctx.vars.createTick).toBe(1);
          expect(ctx.vars.statusAfterCreate?.status).toBe("waiting");
          expect(ctx.vars.eventsAfterCreate).toHaveLength(1);
          expect(ctx.vars.eventsAfterCreate?.[0]).toMatchObject({
            type: "ready",
            consumedByStepKey: null,
            deliveredAt: null,
          });
          expect(ctx.vars.hooksAfterCreate).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                hookName: "onWorkflowEnqueued",
                status: "pending",
                payload: expect.objectContaining({ reason: "event" }),
              }),
            ]),
          );
          expect(ctx.vars.finalRun).toEqual({ processed: 1, ticks: 2 });
          expect(ctx.vars.finalStatus).toMatchObject({ status: "complete", output: "done" });
          expect(ctx.vars.events?.[0]).toMatchObject({
            type: "ready",
            consumedByStepKey: "waitForEvent:ready",
          });
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("stale in-flight runner loses when another runner commits first", async () => {
    const runtime = createWorkflowsTestRuntime();
    let invocationCount = 0;

    const OccWorkflow = defineWorkflow(
      { name: "scenario-stale-runner-occ" },
      async (_event, step) => {
        const value = await step.do("racy work", async () => {
          invocationCount += 1;
          if (invocationCount === 1) {
            runtime.controls.resolve("first:started");
            await runtime.controls.wait("first:release");
          }
          return "committed";
        });
        return { value };
      },
    );

    const workflows = { OCC: OccWorkflow };

    type ScenarioVars = {
      firstTick?: number;
      secondTick?: number;
      status?: { status: string; output?: { value: string } };
      steps?: WorkflowScenarioStepRow[];
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "scenario-stale-runner-occ",
      workflows,
      harness: { runtime },
      steps: [
        scenarioSteps.create({ workflow: "OCC", id: "occ-1" }),
        scenarioSteps.withRunners({
          first: [
            scenarioSteps.tick({
              workflow: "OCC",
              instanceId: "occ-1",
              reason: "create",
              storeAs: "firstTick",
            }),
          ],
          second: [
            scenarioSteps.waitForControl({ key: "first:started" }),
            scenarioSteps.tick({
              workflow: "OCC",
              instanceId: "occ-1",
              reason: "create",
              storeAs: "secondTick",
            }),
            scenarioSteps.resolveControl({ key: "first:release" }),
          ],
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("OCC", "occ-1"),
          storeAs: "status",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getSteps("OCC", "occ-1"),
          storeAs: "steps",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.firstTick).toBe(0);
          expect(ctx.vars.secondTick).toBe(1);
          expect(ctx.vars.status).toMatchObject({
            status: "complete",
            output: { value: "committed" },
          });
          expect(ctx.vars.steps).toHaveLength(1);
          expect(ctx.vars.steps?.[0]).toMatchObject({
            stepKey: "do:racy work",
            status: "completed",
            result: "committed",
          });
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("supports independent runners in scenario blocks", async () => {
    const RunnerWorkflow = defineWorkflow(
      { name: "scenario-independent-runners" },
      async (_event, step) => {
        await step.waitForEvent("ready", { type: "ready" });
        return "done";
      },
    );

    const workflows = { RUNNER: RunnerWorkflow };

    type ScenarioVars = {
      killedRunnerTick?: number;
      eventRunnerRun?: { processed: number; ticks: number };
      status?: { status: string; output?: string };
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "scenario-independent-runners",
      workflows,
      steps: [
        scenarioSteps.initializeAndRunUntilIdle({ workflow: "RUNNER", id: "runner-1" }),
        scenarioSteps.withRunners({
          killed: [
            scenarioSteps.killRunner(),
            scenarioSteps.tick({
              workflow: "RUNNER",
              instanceId: "runner-1",
              reason: "event",
              storeAs: "killedRunnerTick",
            }),
          ],
          active: [
            scenarioSteps.eventAndRunUntilIdle({
              workflow: "RUNNER",
              instanceId: "runner-1",
              event: { type: "ready" },
              runStoreAs: "eventRunnerRun",
            }),
          ],
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("RUNNER", "runner-1"),
          storeAs: "status",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.killedRunnerTick).toBe(0);
          expect(ctx.vars.eventRunnerRun?.processed).toBeGreaterThan(0);
          expect(ctx.vars.status).toMatchObject({ status: "complete", output: "done" });
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("can resume a sleeping workflow after killing the runner", async () => {
    const SleepWorkflow = defineWorkflow({ name: "scenario-kill-sleep" }, async (_event, step) => {
      await step.sleep("pause", 1000);
      return "awake";
    });

    const workflows = { SLEEP: SleepWorkflow };

    type ScenarioVars = {
      status?: { status: string; output?: string };
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "scenario-kill-sleep",
      workflows,
      steps: [
        scenarioSteps.initializeAndRunUntilIdle({ workflow: "SLEEP", id: "sleep-kill-1" }),
        scenarioSteps.killAndRestartRunner(),
        scenarioSteps.advanceTimeAndRunUntilIdle({
          workflow: "SLEEP",
          instanceId: "sleep-kill-1",
          advanceBy: 1000,
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("SLEEP", "sleep-kill-1"),
          storeAs: "status",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.status).toMatchObject({ status: "complete", output: "awake" });
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("does not run workflows while the runner is dead", async () => {
    const DeadRunnerWorkflow = defineWorkflow(
      { name: "scenario-dead-runner" },
      async (_event, step) => {
        await step.waitForEvent("ready", { type: "ready" });
        return "done";
      },
    );

    const workflows = { DEAD: DeadRunnerWorkflow };

    type ScenarioVars = {
      deadRun?: { processed: number; ticks: number };
      statusWhileDead?: { status: string; output?: string };
      statusAfterRestart?: { status: string; output?: string };
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "scenario-dead-runner",
      workflows,
      steps: [
        scenarioSteps.initializeAndRunUntilIdle({ workflow: "DEAD", id: "dead-1" }),
        scenarioSteps.killRunner(),
        scenarioSteps.event({
          workflow: "DEAD",
          instanceId: "dead-1",
          event: { type: "ready" },
        }),
        scenarioSteps.runUntilIdle({
          workflow: "DEAD",
          instanceId: "dead-1",
          reason: "event",
          storeAs: "deadRun",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("DEAD", "dead-1"),
          storeAs: "statusWhileDead",
        }),
        scenarioSteps.restartRunner(),
        scenarioSteps.runUntilIdle({
          workflow: "DEAD",
          instanceId: "dead-1",
          reason: "event",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("DEAD", "dead-1"),
          storeAs: "statusAfterRestart",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.deadRun).toEqual({ processed: 0, ticks: 1 });
          expect(ctx.vars.statusWhileDead?.status).toBe("waiting");
          expect(ctx.vars.statusAfterRestart).toMatchObject({ status: "complete", output: "done" });
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("step emissions remain queryable while nested wait is suspended and clear after completion", async () => {
    const EmittingWaitWorkflow = defineWorkflow(
      { name: "scenario-step-emission-wait" },
      async (_event, step) => {
        await step.do("approval", async (tx) => {
          tx.emit({ phase: "waiting", approved: false });

          await step.waitForEvent("ready", { type: "ready" });

          tx.emit({ phase: "complete", approved: true });
        });
        return "done";
      },
    );

    const workflows = { EMIT_WAIT: EmittingWaitWorkflow };
    type ScenarioVars = {
      messages?: unknown[];
      emissionsAfterSuspend?: unknown[];
      emissionsAfterComplete?: unknown[];
      status?: { status: string; output?: string };
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "scenario-step-emission-wait",
      workflows,
      steps: [
        scenarioSteps.captureEmissions({
          workflow: "EMIT_WAIT",
          instanceId: "emit-wait-1",
          storeAs: "messages",
        }),
        scenarioSteps.initializeAndRunUntilIdle({ workflow: "EMIT_WAIT", id: "emit-wait-1" }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getEmissions("EMIT_WAIT", "emit-wait-1"),
          storeAs: "emissionsAfterSuspend",
        }),
        scenarioSteps.eventAndRunUntilIdle({
          workflow: "EMIT_WAIT",
          instanceId: "emit-wait-1",
          event: { type: "ready" },
        }),
        scenarioSteps.drainHooks(),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getEmissions("EMIT_WAIT", "emit-wait-1"),
          storeAs: "emissionsAfterComplete",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("EMIT_WAIT", "emit-wait-1"),
          storeAs: "status",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.messages).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                workflowName: "scenario-step-emission-wait",
                instanceId: "emit-wait-1",
                stepKey: "do:approval",
                payload: { phase: "waiting", approved: false },
              }),
              expect.objectContaining({
                stepKey: "do:approval",
                payload: { phase: "complete", approved: true },
              }),
            ]),
          );
          expect(ctx.vars.emissionsAfterSuspend).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ actor: "system", stepKey: "do:approval" }),
              expect.objectContaining({
                actor: "user",
                stepKey: "do:approval",
                payload: { phase: "waiting", approved: false },
              }),
            ]),
          );
          expect(ctx.vars.emissionsAfterComplete).toEqual([]);
          expect(ctx.vars.status).toMatchObject({ status: "complete", output: "done" });
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("same step can run concurrently and persist duplicate emissions in separate epochs", async () => {
    const runtime = createWorkflowsTestRuntime();
    let invocationCount = 0;
    const producedEmissions: Array<{ attempt: number; phase: string }> = [];

    const ConcurrentEmissionWorkflow = defineWorkflow(
      { name: "scenario-concurrent-step-emissions" },
      async (_event, step) => {
        const value = await step.do("racy emitter", async (tx) => {
          invocationCount += 1;
          const attempt = invocationCount;
          if (attempt === 1) {
            runtime.controls.resolve("first:started");
            await runtime.controls.wait("first:release");
          } else {
            runtime.controls.resolve("second:started");
          }

          producedEmissions.push({ attempt, phase: "started" });
          tx.emit({ attempt, phase: "started" });
          producedEmissions.push({ attempt, phase: "finished" });
          tx.emit({ attempt, phase: "finished" });
          return `attempt-${attempt}`;
        });

        return { value };
      },
    );

    const workflows = { CONCURRENT_EMIT: ConcurrentEmissionWorkflow };
    type ScenarioVars = {
      ticks?: [number, number];
      emissionsWhileBothStarted?: unknown[];
      emissionsAfterRace?: unknown[];
      status?: { status: string; output?: { value: string } };
      steps?: WorkflowScenarioStepRow[];
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "scenario-concurrent-step-emissions",
      workflows,
      harness: { runtime },
      steps: [
        scenarioSteps.create({ workflow: "CONCURRENT_EMIT", id: "concurrent-emit-1" }),
        scenarioSteps.read({
          storeAs: "ticks",
          read: async (ctx) => {
            const workflowName = "scenario-concurrent-step-emissions";
            const rows = (
              await ctx.harness.db
                .createUnitOfWork("concurrent-emission-instance")
                .forSchema(workflowsSchema)
                .find("workflow_instance", (b) =>
                  b.whereIndex("idx_workflow_instance_workflowName_id", (eb) =>
                    eb.and(
                      eb("workflowName", "=", workflowName),
                      eb("id", "=", "concurrent-emit-1"),
                    ),
                  ),
                )
                .executeRetrieve()
            )[0];
            const instance = rows[0];
            expect(instance).toBeDefined();
            const payload = {
              workflowName,
              instanceId: instance.id.toString(),
              instanceRef: instance.id.toString(),
              reason: "create",
            } as const;
            const first = ctx.harness.createRunner().tick(payload);
            await runtime.controls.wait("first:started");

            const second = ctx.harness.createRunner().tick(payload);
            await new Promise((resolve) => setTimeout(resolve, 10));
            ctx.vars.emissionsWhileBothStarted = await ctx.state.getEmissions(
              "CONCURRENT_EMIT",
              "concurrent-emit-1",
            );

            runtime.controls.resolve("first:release");
            return await Promise.all([first, second]);
          },
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getEmissions("CONCURRENT_EMIT", "concurrent-emit-1"),
          storeAs: "emissionsAfterRace",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("CONCURRENT_EMIT", "concurrent-emit-1"),
          storeAs: "status",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getSteps("CONCURRENT_EMIT", "concurrent-emit-1"),
          storeAs: "steps",
        }),
        scenarioSteps.assert((ctx) => {
          expect(invocationCount).toBe(2);
          expect(ctx.vars.ticks).toEqual([0, 1]);
          expect(ctx.vars.emissionsWhileBothStarted).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                actor: "user",
                stepKey: "do:racy emitter",
                payload: { attempt: 2, phase: "started" },
              }),
              expect.objectContaining({
                actor: "user",
                stepKey: "do:racy emitter",
                payload: { attempt: 2, phase: "finished" },
              }),
            ]),
          );
          expect(ctx.vars.emissionsAfterRace).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ actor: "system", stepKey: "do:racy emitter" }),
              expect.objectContaining({
                actor: "user",
                stepKey: "do:racy emitter",
                payload: { attempt: 1, phase: "started" },
              }),
              expect.objectContaining({
                actor: "user",
                stepKey: "do:racy emitter",
                payload: { attempt: 1, phase: "finished" },
              }),
            ]),
          );
          expect(producedEmissions).toEqual(
            expect.arrayContaining([
              { attempt: 1, phase: "started" },
              { attempt: 1, phase: "finished" },
              { attempt: 2, phase: "started" },
              { attempt: 2, phase: "finished" },
            ]),
          );
          const outEmissions = (ctx.vars.emissionsAfterRace ?? []).filter(
            (emission) => (emission as { actor?: string }).actor === "user",
          );
          const epochsByAttempt = new Map<number, Set<string>>();
          for (const emission of outEmissions) {
            const { epoch, payload } = emission as { epoch: string; payload: { attempt: number } };
            const epochs = epochsByAttempt.get(payload.attempt) ?? new Set<string>();
            epochs.add(epoch);
            epochsByAttempt.set(payload.attempt, epochs);
          }

          expect(epochsByAttempt.get(1)?.size).toBe(1);
          expect(epochsByAttempt.get(2)?.size).toBe(1);
          expect(epochsByAttempt.get(1)).not.toEqual(epochsByAttempt.get(2));
          expect(ctx.vars.status).toMatchObject({
            status: "complete",
            output: { value: "attempt-2" },
          });
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("completed step replay does not republish step emissions", async () => {
    let publishExecutions = 0;

    const StepReplayWorkflow = defineWorkflow(
      { name: "scenario-step-emission-replay" },
      async (_event, step) => {
        await step.do("publish once", async (tx) => {
          publishExecutions += 1;
          tx.emit({ phase: "inside-step" });
        });

        await step.waitForEvent("ready", { type: "ready" });
        return "done";
      },
    );

    const workflows = { STEP_REPLAY: StepReplayWorkflow };
    type ScenarioVars = {
      messages?: unknown[];
      emissionsAfterFirstRun?: unknown[];
      emissionsAfterRestart?: unknown[];
      status?: { status: string; output?: string };
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "scenario-step-emission-replay",
      workflows,
      steps: [
        scenarioSteps.captureEmissions({
          workflow: "STEP_REPLAY",
          instanceId: "step-replay-1",
          storeAs: "messages",
        }),
        scenarioSteps.initializeAndRunUntilIdle({ workflow: "STEP_REPLAY", id: "step-replay-1" }),
        scenarioSteps.drainHooks(),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getEmissions("STEP_REPLAY", "step-replay-1"),
          storeAs: "emissionsAfterFirstRun",
        }),
        scenarioSteps.killAndRestartRunner(),
        scenarioSteps.eventAndRunUntilIdle({
          workflow: "STEP_REPLAY",
          instanceId: "step-replay-1",
          event: { type: "ready" },
        }),
        scenarioSteps.drainHooks(),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getEmissions("STEP_REPLAY", "step-replay-1"),
          storeAs: "emissionsAfterRestart",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("STEP_REPLAY", "step-replay-1"),
          storeAs: "status",
        }),
        scenarioSteps.assert((ctx) => {
          expect(publishExecutions).toBe(1);
          expect(ctx.vars.messages).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                stepKey: "do:publish once",
                payload: { phase: "inside-step" },
              }),
            ]),
          );
          expect(ctx.vars.emissionsAfterFirstRun).toEqual([]);
          expect(ctx.vars.emissionsAfterRestart).toEqual([]);
          expect(ctx.vars.status).toMatchObject({ status: "complete", output: "done" });
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("step emissions clear after callback error", async () => {
    const ErrorWorkflow = defineWorkflow(
      { name: "scenario-step-emission-error" },
      async (_event, step) => {
        await step.do("fail", async (tx) => {
          tx.emit({ phase: "failing" });
          throw new Error("boom");
        });
      },
    );

    const workflows = { ERROR: ErrorWorkflow };
    type ScenarioVars = {
      messages?: unknown[];
      emissionsAfterError?: unknown[];
      status?: { status: string; error?: { name: string; message: string } };
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "scenario-step-emission-error",
      workflows,
      steps: [
        scenarioSteps.captureEmissions({
          workflow: "ERROR",
          instanceId: "error-1",
          storeAs: "messages",
        }),
        scenarioSteps.initializeAndRunUntilIdle({ workflow: "ERROR", id: "error-1" }),
        scenarioSteps.drainHooks(),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getEmissions("ERROR", "error-1"),
          storeAs: "emissionsAfterError",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("ERROR", "error-1"),
          storeAs: "status",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.messages).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                stepKey: "do:fail",
                payload: { phase: "failing" },
              }),
            ]),
          );
          expect(ctx.vars.emissionsAfterError).toEqual([]);
          expect(ctx.vars.status).toMatchObject({
            status: "errored",
            error: { name: "Error", message: "boom" },
          });
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("step emissions clear after retry suspension", async () => {
    const RetryWorkflow = defineWorkflow(
      { name: "scenario-step-emission-retry" },
      async (_event, step) => {
        await step.do("retry later", { retries: { limit: 1, delay: "1 hour" } }, async (tx) => {
          tx.emit({ phase: "retrying" });
          throw new Error("temporary");
        });
        return "done";
      },
    );

    const workflows = { RETRY: RetryWorkflow };
    type ScenarioVars = {
      messages?: unknown[];
      emissionsAfterRetrySuspend?: unknown[];
      status?: { status: string };
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "scenario-step-emission-retry",
      workflows,
      steps: [
        scenarioSteps.captureEmissions({
          workflow: "RETRY",
          instanceId: "retry-1",
          storeAs: "messages",
        }),
        scenarioSteps.initializeAndRunUntilIdle({ workflow: "RETRY", id: "retry-1" }),
        scenarioSteps.drainHooks(),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getEmissions("RETRY", "retry-1"),
          storeAs: "emissionsAfterRetrySuspend",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("RETRY", "retry-1"),
          storeAs: "status",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.messages).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                stepKey: "do:retry later",
                payload: { phase: "retrying" },
              }),
            ]),
          );
          expect(ctx.vars.emissionsAfterRetrySuspend).toEqual([]);
          expect(ctx.vars.status?.status).toBe("waiting");
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("can drive reusable runtime controls from the scenario DSL", async () => {
    const runtime = createWorkflowsTestRuntime();

    const ControlWorkflow = defineWorkflow({ name: "control-workflow" }, async (_event, step) => {
      await step.waitForEvent("ready", { type: "ready" });
      const value = await step.do("await control", async () => {
        return await runtime.controls.wait<boolean>("control:ready");
      });
      return { value };
    });

    const workflows = { CONTROL: ControlWorkflow };

    type ScenarioVars = {
      status?: { status: string; output?: { value: boolean } };
      control?: { key: string; status: string; pendingCount: number; value?: unknown };
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "scenario-controls",
      workflows,
      harness: { runtime },
      steps: [
        scenarioSteps.initializeAndRunUntilIdle({ workflow: "CONTROL", id: "control-1" }),
        scenarioSteps.read({
          read: (ctx) => ctx.runtime.controls.get("control:ready"),
          storeAs: "control",
        }),
        scenarioSteps.resolveControl({ key: "control:ready", value: false }),
        scenarioSteps.eventAndRunUntilIdle({
          workflow: "CONTROL",
          instanceId: "control-1",
          event: { type: "ready" },
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("CONTROL", "control-1"),
          storeAs: "status",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.control).toMatchObject({
            key: "control:ready",
            status: "pending",
            pendingCount: 0,
          });
          expect(ctx.vars.status).toMatchObject({
            status: "complete",
            output: { value: false },
          });
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("simulates a fetch inside a step", async () => {
    const FetchWorkflow = defineWorkflow({ name: "fetch-workflow" }, async (_event, step) => {
      const response = await step.do("fetch", async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return { status: 200, json: { ok: true, source: "fake" } };
      });
      return response;
    });

    const workflows = { FETCH: FetchWorkflow };

    type ScenarioVars = {
      status?: {
        status: string;
        output?: { status: number; json: { ok: boolean; source: string } };
      };
      steps?: WorkflowScenarioStepRow[];
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "fetch-step",
      workflows,
      steps: [
        scenarioSteps.initializeAndRunUntilIdle({ workflow: "FETCH", id: "fetch-1" }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("FETCH", "fetch-1"),
          storeAs: "status",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getSteps("FETCH", "fetch-1"),
          storeAs: "steps",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.status?.status).toBe("complete");
          expect(ctx.vars.status?.output).toEqual({
            status: 200,
            json: { ok: true, source: "fake" },
          });
          expect(ctx.vars.steps).toHaveLength(1);
          expect(ctx.vars.steps?.[0]).toMatchObject({
            name: "fetch",
            type: "do",
            status: "completed",
            stepKey: "do:fetch",
          });
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("waits for an event before completing", async () => {
    const WaitWorkflow = defineWorkflow({ name: "wait-workflow" }, async (_event, step) => {
      const ready = await step.waitForEvent<{ ok: boolean }>("ready", { type: "ready" });
      return { ok: ready.payload.ok };
    });

    const workflows = { WAIT: WaitWorkflow };

    type ScenarioVars = {
      waitingStatus?: { status: string };
      finalStatus?: { status: string; output?: { ok: boolean } };
      steps?: WorkflowScenarioStepRow[];
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "wait-for-event",
      workflows,
      steps: [
        scenarioSteps.initializeAndRunUntilIdle({ workflow: "WAIT", id: "wait-1" }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("WAIT", "wait-1"),
          storeAs: "waitingStatus",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getSteps("WAIT", "wait-1"),
          storeAs: "steps",
        }),
        scenarioSteps.eventAndRunUntilIdle({
          workflow: "WAIT",
          instanceId: "wait-1",
          event: { type: "ready", payload: { ok: true } },
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("WAIT", "wait-1"),
          storeAs: "finalStatus",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.waitingStatus?.status).toBe("waiting");
          expect(ctx.vars.steps?.[0]).toMatchObject({
            stepKey: "waitForEvent:ready",
            status: "waiting",
          });
          expect(ctx.vars.finalStatus?.status).toBe("complete");
          expect(ctx.vars.finalStatus?.output).toEqual({ ok: true });
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("suspends on sleep and marks wake time", async () => {
    const SleepWorkflow = defineWorkflow({ name: "sleep-workflow" }, async (_event, step) => {
      await step.sleep("nap", "10 minutes");
      return { done: true };
    });

    const workflows = { SLEEP: SleepWorkflow };

    type ScenarioVars = {
      status?: { status: string };
      steps?: WorkflowScenarioStepRow[];
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "sleep-waiting",
      workflows,
      steps: [
        scenarioSteps.initializeAndRunUntilIdle({ workflow: "SLEEP", id: "sleep-1" }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("SLEEP", "sleep-1"),
          storeAs: "status",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getSteps("SLEEP", "sleep-1"),
          storeAs: "steps",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.status?.status).toBe("waiting");
          expect(ctx.vars.steps?.[0]).toMatchObject({
            stepKey: "sleep:nap",
            status: "waiting",
          });
          expect(ctx.vars.steps?.[0].wakeAt).toBeInstanceOf(Date);
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("completes sleep on explicit wake tick", async () => {
    const SleepWorkflow = defineWorkflow({ name: "sleep-wake-workflow" }, async (_event, step) => {
      await step.sleep("nap", "10 minutes");
      return { done: true };
    });

    const workflows = { SLEEP_WAKE: SleepWorkflow };

    type ScenarioVars = {
      waiting?: { status: string };
      final?: { status: string; output?: { done: boolean } };
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "sleep-wake",
      workflows,
      steps: [
        scenarioSteps.initializeAndRunUntilIdle({ workflow: "SLEEP_WAKE", id: "sleep-wake-1" }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("SLEEP_WAKE", "sleep-wake-1"),
          storeAs: "waiting",
        }),
        scenarioSteps.advanceTimeAndRunUntilIdle({
          workflow: "SLEEP_WAKE",
          instanceId: "sleep-wake-1",
          advanceBy: "10 minutes",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("SLEEP_WAKE", "sleep-wake-1"),
          storeAs: "final",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.waiting?.status).toBe("waiting");
          expect(ctx.vars.final?.status).toBe("complete");
          expect(ctx.vars.final?.output).toEqual({ done: true });
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("wake tick does not skip a new sleep in the same run", async () => {
    const SequentialSleepWorkflow = defineWorkflow(
      { name: "sequential-sleep-workflow" },
      async (_event, step) => {
        await step.sleep("first", "10 minutes");
        await step.sleep("second", "10 minutes");
        return { done: true };
      },
    );

    const workflows = { SEQUENTIAL_SLEEP: SequentialSleepWorkflow };

    type ScenarioVars = {
      waitingSteps?: WorkflowScenarioStepRow[];
      firstWakeAt?: Date;
      afterWakeStatus?: { status: string; output?: { done: boolean } };
      afterWakeSteps?: WorkflowScenarioStepRow[];
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "sequential-sleep-wake",
      workflows,
      steps: [
        scenarioSteps.create({ workflow: "SEQUENTIAL_SLEEP", id: "sequential-sleep-1" }),
        scenarioSteps.tick({
          workflow: "SEQUENTIAL_SLEEP",
          instanceId: "sequential-sleep-1",
          reason: "create",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getSteps("SEQUENTIAL_SLEEP", "sequential-sleep-1"),
          storeAs: "waitingSteps",
        }),
        scenarioSteps.read({
          read: (ctx) =>
            ctx.vars.waitingSteps?.find((step) => step.stepKey === "sleep:first")?.wakeAt ?? null,
          storeAs: "firstWakeAt",
        }),
        scenarioSteps.tick({
          workflow: "SEQUENTIAL_SLEEP",
          instanceId: "sequential-sleep-1",
          reason: "wake",
          timestamp: (ctx) => {
            const wakeAt = ctx.vars.firstWakeAt;
            if (!wakeAt) {
              throw new Error("MISSING_FIRST_WAKE_AT");
            }
            return wakeAt;
          },
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("SEQUENTIAL_SLEEP", "sequential-sleep-1"),
          storeAs: "afterWakeStatus",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getSteps("SEQUENTIAL_SLEEP", "sequential-sleep-1"),
          storeAs: "afterWakeSteps",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.firstWakeAt).toBeInstanceOf(Date);
          expect(ctx.vars.afterWakeStatus?.status).toBe("waiting");

          const steps = ctx.vars.afterWakeSteps ?? [];
          const firstStep = steps.find((step) => step.stepKey === "sleep:first");
          const secondStep = steps.find((step) => step.stepKey === "sleep:second");

          expect(firstStep).toMatchObject({ status: "completed" });
          expect(secondStep).toMatchObject({ status: "waiting" });
          expect(secondStep?.wakeAt).toBeInstanceOf(Date);
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("does not complete sleep on early wake tick", async () => {
    const SleepWorkflow = defineWorkflow({ name: "sleep-early-workflow" }, async (_event, step) => {
      await step.sleep("nap", "10 minutes");
      return { done: true };
    });

    const workflows = { SLEEP_EARLY: SleepWorkflow };

    type ScenarioVars = {
      waiting?: { status: string };
      waitingSteps?: WorkflowScenarioStepRow[];
      wakeAt?: Date;
      afterWake?: { status: string };
      afterSteps?: WorkflowScenarioStepRow[];
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "sleep-early-wake",
      workflows,
      steps: [
        scenarioSteps.create({ workflow: "SLEEP_EARLY", id: "sleep-early-1" }),
        scenarioSteps.tick({
          workflow: "SLEEP_EARLY",
          instanceId: "sleep-early-1",
          reason: "create",
        }),
        // After the first tick the workflow is waiting with a persisted wakeAt.
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("SLEEP_EARLY", "sleep-early-1"),
          storeAs: "waiting",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getSteps("SLEEP_EARLY", "sleep-early-1"),
          storeAs: "waitingSteps",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.vars.waitingSteps?.[0].wakeAt ?? null,
          storeAs: "wakeAt",
        }),
        // Simulate an early wake hook (or duplicate hook) firing before wakeAt.
        // The runner should suspend again and keep the step waiting.
        scenarioSteps.tick({
          workflow: "SLEEP_EARLY",
          instanceId: "sleep-early-1",
          reason: "wake",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("SLEEP_EARLY", "sleep-early-1"),
          storeAs: "afterWake",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getSteps("SLEEP_EARLY", "sleep-early-1"),
          storeAs: "afterSteps",
        }),
        scenarioSteps.assert((ctx) => {
          // If this assertion fails, we are completing sleep early based on the hook
          // timestamp instead of the persisted wakeAt.
          expect(ctx.vars.waiting?.status).toBe("waiting");
          expect(ctx.vars.waitingSteps?.[0].wakeAt).toBeInstanceOf(Date);
          expect(ctx.vars.afterWake?.status).toBe("waiting");
          expect(ctx.vars.afterSteps?.[0]).toMatchObject({
            stepKey: "sleep:nap",
            status: "waiting",
          });
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("does not enqueue duplicate wake hooks when replaying before wakeAt", async () => {
    const SleepWorkflow = defineWorkflow(
      { name: "sleep-replay-workflow" },
      async (_event, step) => {
        await step.sleep("nap", "10 minutes");
        return { done: true };
      },
    );

    const workflows = { SLEEP_REPLAY: SleepWorkflow };

    type ScenarioVars = {
      waitingSteps?: WorkflowScenarioStepRow[];
      wakeAt?: Date;
      firstWakeHooks?: WorkflowScenarioHookRow[];
      secondWakeHooks?: WorkflowScenarioHookRow[];
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "sleep-replay-no-reschedule",
      workflows,
      steps: [
        scenarioSteps.create({ workflow: "SLEEP_REPLAY", id: "sleep-replay-1" }),
        scenarioSteps.tick({
          workflow: "SLEEP_REPLAY",
          instanceId: "sleep-replay-1",
          reason: "create",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getSteps("SLEEP_REPLAY", "sleep-replay-1"),
          storeAs: "waitingSteps",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.vars.waitingSteps?.[0].wakeAt ?? null,
          storeAs: "wakeAt",
        }),
        scenarioSteps.read({
          read: async (ctx) => {
            const hooks = await ctx.state.internal.getHooks({
              hookName: "onWorkflowEnqueued",
              status: "pending",
              workflowName: "sleep-replay-workflow",
              instanceId: "sleep-replay-1",
            });
            return hooks.filter((hook) => {
              const payload = hook.payload as { reason?: string };
              return payload.reason === "wake";
            });
          },
          storeAs: "firstWakeHooks",
        }),
        // Replay the run before wakeAt. We should NOT enqueue another wake hook.
        scenarioSteps.tick({
          workflow: "SLEEP_REPLAY",
          instanceId: "sleep-replay-1",
          reason: "create",
        }),
        scenarioSteps.read({
          read: async (ctx) => {
            const hooks = await ctx.state.internal.getHooks({
              hookName: "onWorkflowEnqueued",
              status: "pending",
              workflowName: "sleep-replay-workflow",
              instanceId: "sleep-replay-1",
            });
            return hooks.filter((hook) => {
              const payload = hook.payload as { reason?: string };
              return payload.reason === "wake";
            });
          },
          storeAs: "secondWakeHooks",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.waitingSteps?.[0].wakeAt).toBeInstanceOf(Date);
          expect(ctx.vars.firstWakeHooks).toHaveLength(1);
          expect(ctx.vars.secondWakeHooks).toHaveLength(1);
          expect(ctx.vars.secondWakeHooks?.[0].nextRetryAt?.getTime()).toBe(
            ctx.vars.firstWakeHooks?.[0].nextRetryAt?.getTime(),
          );
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("suspends on sleepUntil and completes on wake", async () => {
    let wakeAt: Date | null = null;

    const SleepUntilWorkflow = defineWorkflow(
      { name: "sleep-until-workflow" },
      async (_event, step) => {
        if (!wakeAt) {
          throw new Error("MISSING_WAKE_AT");
        }
        await step.sleepUntil("alarm", wakeAt);
        return { done: true };
      },
    );

    const workflows = { SLEEP_UNTIL: SleepUntilWorkflow };

    type ScenarioVars = {
      wakeAt?: Date;
      waiting?: { status: string };
      final?: { status: string; output?: { done: boolean } };
      steps?: WorkflowScenarioStepRow[];
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "sleep-until",
      workflows,
      steps: [
        scenarioSteps.read({
          read: (ctx) => {
            wakeAt = new Date(ctx.clock.now().getTime() + 5 * 60 * 1000);
            return wakeAt;
          },
          storeAs: "wakeAt",
        }),
        scenarioSteps.initializeAndRunUntilIdle({ workflow: "SLEEP_UNTIL", id: "sleep-until-1" }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("SLEEP_UNTIL", "sleep-until-1"),
          storeAs: "waiting",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getSteps("SLEEP_UNTIL", "sleep-until-1"),
          storeAs: "steps",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.waiting?.status).toBe("waiting");
          expect(ctx.vars.steps?.[0]).toMatchObject({
            stepKey: "sleep:alarm",
            status: "waiting",
          });
          expect(ctx.vars.steps?.[0].wakeAt?.getTime()).toBe(ctx.vars.wakeAt?.getTime());
        }),
        scenarioSteps.advanceTimeAndRunUntilIdle({
          workflow: "SLEEP_UNTIL",
          instanceId: "sleep-until-1",
          setTo: (ctx) => ctx.vars.wakeAt as Date,
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("SLEEP_UNTIL", "sleep-until-1"),
          storeAs: "final",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.final?.status).toBe("complete");
          expect(ctx.vars.final?.output).toEqual({ done: true });
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("does not timeout waitForEvent on early wake tick", async () => {
    const TimeoutWorkflow = defineWorkflow(
      { name: "early-event-timeout-workflow" },
      async (_event, step) => {
        await step.waitForEvent("ready", { type: "ready", timeout: "5 minutes" });
        return { ok: true };
      },
    );

    const workflows = { TIMEOUT_EARLY: TimeoutWorkflow };

    type ScenarioVars = {
      waiting?: { status: string };
      waitingSteps?: WorkflowScenarioStepRow[];
      wakeAt?: Date;
      afterWake?: { status: string; error?: { message?: string } };
      afterSteps?: WorkflowScenarioStepRow[];
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "wait-timeout-early",
      workflows,
      steps: [
        scenarioSteps.create({ workflow: "TIMEOUT_EARLY", id: "timeout-early-1" }),
        scenarioSteps.tick({
          workflow: "TIMEOUT_EARLY",
          instanceId: "timeout-early-1",
          reason: "create",
        }),
        // First tick should put the workflow into waiting state with a wakeAt timeout.
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("TIMEOUT_EARLY", "timeout-early-1"),
          storeAs: "waiting",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getSteps("TIMEOUT_EARLY", "timeout-early-1"),
          storeAs: "waitingSteps",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.vars.waitingSteps?.[0].wakeAt ?? null,
          storeAs: "wakeAt",
        }),
        // Simulate a wake hook arriving early (before the timeout deadline).
        // The runner should keep waiting instead of timing out early.
        scenarioSteps.tick({
          workflow: "TIMEOUT_EARLY",
          instanceId: "timeout-early-1",
          reason: "wake",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("TIMEOUT_EARLY", "timeout-early-1"),
          storeAs: "afterWake",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getSteps("TIMEOUT_EARLY", "timeout-early-1"),
          storeAs: "afterSteps",
        }),
        scenarioSteps.assert((ctx) => {
          // If this fails, we are using the hook timestamp as "now" and timing out
          // without checking the persisted wakeAt deadline.
          expect(ctx.vars.waiting?.status).toBe("waiting");
          expect(ctx.vars.waitingSteps?.[0]).toMatchObject({
            stepKey: "waitForEvent:ready",
            status: "waiting",
            waitEventType: "ready",
          });
          expect(ctx.vars.waitingSteps?.[0].wakeAt).toBeInstanceOf(Date);
          expect(ctx.vars.afterWake?.status).toBe("waiting");
          expect(ctx.vars.afterSteps?.[0]).toMatchObject({
            stepKey: "waitForEvent:ready",
            status: "waiting",
            waitEventType: "ready",
          });
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("waitForEvent times out on wake tick", async () => {
    const TimeoutWorkflow = defineWorkflow(
      { name: "event-timeout-workflow" },
      async (_event, step) => {
        await step.waitForEvent("ready", { type: "ready", timeout: "5 minutes" });
        return { ok: true };
      },
    );

    const workflows = { TIMEOUT: TimeoutWorkflow };

    type ScenarioVars = {
      waiting?: { status: string };
      final?: { status: string; error?: { message?: string } };
      waitingSteps?: WorkflowScenarioStepRow[];
      finalSteps?: WorkflowScenarioStepRow[];
      wakeAt?: Date;
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "wait-timeout",
      workflows,
      steps: [
        scenarioSteps.initializeAndRunUntilIdle({ workflow: "TIMEOUT", id: "timeout-1" }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("TIMEOUT", "timeout-1"),
          storeAs: "waiting",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getSteps("TIMEOUT", "timeout-1"),
          storeAs: "waitingSteps",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.vars.waitingSteps?.[0].wakeAt ?? null,
          storeAs: "wakeAt",
        }),
        scenarioSteps.advanceTimeAndRunUntilIdle({
          workflow: "TIMEOUT",
          instanceId: "timeout-1",
          setTo: (ctx) => new Date((ctx.vars.wakeAt as Date).getTime() + 1),
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("TIMEOUT", "timeout-1"),
          storeAs: "final",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getSteps("TIMEOUT", "timeout-1"),
          storeAs: "finalSteps",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.waiting?.status).toBe("waiting");
          expect(ctx.vars.waitingSteps?.[0]).toMatchObject({
            stepKey: "waitForEvent:ready",
            status: "waiting",
            waitEventType: "ready",
          });
          expect(ctx.vars.waitingSteps?.[0].wakeAt).toBeInstanceOf(Date);
          expect(ctx.vars.final?.status).toBe("errored");
          expect(ctx.vars.final?.error?.message).toBe("WAIT_FOR_EVENT_TIMEOUT");
          expect(ctx.vars.finalSteps?.[0]).toMatchObject({
            stepKey: "waitForEvent:ready",
            status: "errored",
            errorMessage: "WAIT_FOR_EVENT_TIMEOUT",
          });
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("waitForEvent timeout can be caught to complete the workflow gracefully", async () => {
    const GracefulTimeoutWorkflow = defineWorkflow(
      { name: "graceful-timeout-workflow" },
      async (_event, step) => {
        try {
          await step.waitForEvent("ready", { type: "ready", timeout: "5 minutes" });
          return { ok: true, timedOut: false };
        } catch (err) {
          if (err instanceof WaitForEventTimeoutError) {
            return { ok: true, timedOut: true };
          }
          throw err;
        }
      },
    );

    const workflows = { GRACEFUL: GracefulTimeoutWorkflow };

    type ScenarioVars = {
      waiting?: { status: string };
      waitingSteps?: WorkflowScenarioStepRow[];
      wakeAt?: Date;
      final?: { status: string; output?: { ok: boolean; timedOut: boolean } };
      finalSteps?: WorkflowScenarioStepRow[];
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "wait-timeout-graceful",
      workflows,
      steps: [
        scenarioSteps.initializeAndRunUntilIdle({ workflow: "GRACEFUL", id: "graceful-1" }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("GRACEFUL", "graceful-1"),
          storeAs: "waiting",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getSteps("GRACEFUL", "graceful-1"),
          storeAs: "waitingSteps",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.vars.waitingSteps?.[0].wakeAt ?? null,
          storeAs: "wakeAt",
        }),
        scenarioSteps.advanceTimeAndRunUntilIdle({
          workflow: "GRACEFUL",
          instanceId: "graceful-1",
          setTo: (ctx) => new Date((ctx.vars.wakeAt as Date).getTime() + 1),
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("GRACEFUL", "graceful-1"),
          storeAs: "final",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getSteps("GRACEFUL", "graceful-1"),
          storeAs: "finalSteps",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.waiting?.status).toBe("waiting");
          expect(ctx.vars.final?.status).toBe("complete");
          expect(ctx.vars.final?.output).toEqual({ ok: true, timedOut: true });
          expect(ctx.vars.finalSteps?.[0]).toMatchObject({
            stepKey: "waitForEvent:ready",
            status: "errored",
            errorMessage: "WAIT_FOR_EVENT_TIMEOUT",
          });
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("caught timeout uses tx.mutate (not onTerminalError) for post-timeout writes", async () => {
    const timeoutMutationSchema = schema("timeout_mutation_test", (s) =>
      s.addTable("session_status", (t) =>
        t
          .addColumn("id", idColumn())
          .addColumn("status", column("string"))
          .addColumn(
            "createdAt",
            column("timestamp").defaultTo((b) => b.now()),
          )
          .createIndex("idx_status", ["status"]),
      ),
    );

    const timeoutMutationFragmentDefinition = defineFragment("timeout-mutation-fragment")
      .extend(withDatabase(timeoutMutationSchema))
      .build();

    const TimeoutMutationWorkflow = defineWorkflow(
      { name: "timeout-mutation-workflow" },
      async (_event, step) => {
        await step.do("init", (tx) => {
          tx.mutate((ctx) => {
            ctx.forSchema(timeoutMutationSchema).create("session_status", { status: "waiting" });
          });
          return "initialized";
        });

        try {
          await step.waitForEvent("approval", { type: "approval", timeout: "5 minutes" });
          await step.do("mark-approved", (tx) => {
            tx.mutate((ctx) => {
              ctx.forSchema(timeoutMutationSchema).create("session_status", { status: "approved" });
            });
            return "approved";
          });
          return { finalStatus: "approved" };
        } catch (err) {
          if (err instanceof WaitForEventTimeoutError) {
            await step.do("mark-timed-out", (tx) => {
              tx.onTerminalError.mutate((ctx) => {
                ctx
                  .forSchema(timeoutMutationSchema)
                  .create("session_status", { status: "error-cleanup" });
              });
              tx.mutate((ctx) => {
                ctx.forSchema(timeoutMutationSchema).create("session_status", { status: "done" });
              });
              return "timed-out";
            });
            return { finalStatus: "timed-out" };
          }
          throw err;
        }
      },
    );

    const workflows = { TIMEOUT_MUTATE: TimeoutMutationWorkflow };

    type ScenarioVars = {
      waitingSteps?: WorkflowScenarioStepRow[];
      wakeAt?: Date;
      final?: { status: string; output?: { finalStatus: string } };
      finalSteps?: WorkflowScenarioStepRow[];
      rows?: Array<{ status: string }>;
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "timeout-mutation",
      workflows,
      harness: {
        configureBuilder: (builder) =>
          builder.withFragment("timeoutMutation", instantiate(timeoutMutationFragmentDefinition)),
      },
      steps: [
        scenarioSteps.initializeAndRunUntilIdle({
          workflow: "TIMEOUT_MUTATE",
          id: "tm-1",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getSteps("TIMEOUT_MUTATE", "tm-1"),
          storeAs: "waitingSteps",
        }),
        scenarioSteps.read({
          read: (ctx) =>
            ctx.vars.waitingSteps?.find((s) => s.stepKey === "waitForEvent:approval")?.wakeAt ??
            null,
          storeAs: "wakeAt",
        }),
        scenarioSteps.advanceTimeAndRunUntilIdle({
          workflow: "TIMEOUT_MUTATE",
          instanceId: "tm-1",
          setTo: (ctx) => new Date((ctx.vars.wakeAt as Date).getTime() + 1),
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("TIMEOUT_MUTATE", "tm-1"),
          storeAs: "final",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getSteps("TIMEOUT_MUTATE", "tm-1"),
          storeAs: "finalSteps",
        }),
        scenarioSteps.read({
          read: async (ctx) => {
            return (
              await ctx.harness.fragments["timeoutMutation"].db
                .createUnitOfWork("read")
                .forSchema(timeoutMutationSchema)
                .find("session_status", (b) => b.whereIndex("primary"))
                .executeRetrieve()
            )[0];
          },
          storeAs: "rows",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.final?.status).toBe("complete");
          expect(ctx.vars.final?.output).toEqual({ finalStatus: "timed-out" });

          // The "mark-timed-out" step completed successfully (no terminal error),
          // so tx.mutate runs and tx.onTerminalError.mutate does NOT.
          const statuses = (ctx.vars.rows ?? []).map((r) => r.status).sort();
          expect(statuses).toEqual(["done", "waiting"]);
          expect(statuses).not.toContain("error-cleanup");
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("waitForEvent completes before timeout when event is delivered", async () => {
    const TimeoutWorkflow = defineWorkflow(
      { name: "event-before-timeout-workflow" },
      async (_event, step) => {
        const ready = await step.waitForEvent<{ ok: boolean }>("ready", {
          type: "ready",
          timeout: "5 minutes",
        });
        return { ok: ready.payload.ok };
      },
    );

    const workflows = { TIMEOUT_EVENT: TimeoutWorkflow };

    type ScenarioVars = {
      waitingSteps?: WorkflowScenarioStepRow[];
      wakeAt?: Date;
      status?: { status: string; output?: { ok: boolean } };
      steps?: WorkflowScenarioStepRow[];
      events?: WorkflowScenarioEventRow[];
      lateTicks?: { processed: number; ticks: number };
      afterAdvanceStatus?: { status: string; output?: { ok: boolean } };
      afterAdvanceSteps?: WorkflowScenarioStepRow[];
      afterAdvanceEvents?: WorkflowScenarioEventRow[];
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "wait-timeout-event",
      workflows,
      steps: [
        scenarioSteps.create({ workflow: "TIMEOUT_EVENT", id: "timeout-event-1" }),
        scenarioSteps.tick({
          workflow: "TIMEOUT_EVENT",
          instanceId: "timeout-event-1",
          reason: "create",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getSteps("TIMEOUT_EVENT", "timeout-event-1"),
          storeAs: "waitingSteps",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.vars.waitingSteps?.[0].wakeAt ?? null,
          storeAs: "wakeAt",
        }),
        scenarioSteps.eventAndRunUntilIdle({
          workflow: "TIMEOUT_EVENT",
          instanceId: "timeout-event-1",
          event: { type: "ready", payload: { ok: true } },
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("TIMEOUT_EVENT", "timeout-event-1"),
          storeAs: "status",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getSteps("TIMEOUT_EVENT", "timeout-event-1"),
          storeAs: "steps",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getEvents("TIMEOUT_EVENT", "timeout-event-1"),
          storeAs: "events",
        }),
        scenarioSteps.advanceTimeAndRunUntilIdle({
          workflow: "TIMEOUT_EVENT",
          instanceId: "timeout-event-1",
          setTo: (ctx) => {
            const wakeAt = ctx.vars.wakeAt;
            if (!wakeAt) {
              throw new Error("MISSING_WAKE_AT");
            }
            return new Date(wakeAt.getTime() + 10 * 60 * 1000);
          },
          storeAs: "lateTicks",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("TIMEOUT_EVENT", "timeout-event-1"),
          storeAs: "afterAdvanceStatus",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getSteps("TIMEOUT_EVENT", "timeout-event-1"),
          storeAs: "afterAdvanceSteps",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getEvents("TIMEOUT_EVENT", "timeout-event-1"),
          storeAs: "afterAdvanceEvents",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.status?.status).toBe("complete");
          expect(ctx.vars.status?.output).toEqual({ ok: true });

          expect(ctx.vars.steps?.[0]).toMatchObject({
            stepKey: "waitForEvent:ready",
            status: "completed",
          });

          expect(ctx.vars.events).toHaveLength(1);
          expect(ctx.vars.events?.[0]).toMatchObject({
            type: "ready",
            consumedByStepKey: "waitForEvent:ready",
          });

          expect(ctx.vars.lateTicks?.processed).toBe(0);
          expect(ctx.vars.lateTicks?.ticks).toBe(1);
          expect(ctx.vars.afterAdvanceStatus?.status).toBe("complete");
          expect(ctx.vars.afterAdvanceStatus?.output).toEqual({ ok: true });
          expect(ctx.vars.afterAdvanceSteps?.[0]).toMatchObject({
            stepKey: "waitForEvent:ready",
            status: "completed",
          });
          expect(ctx.vars.afterAdvanceEvents).toHaveLength(1);
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("getHistory returns ordered step and event data", async () => {
    const HistoryWorkflow = defineWorkflow({ name: "history-workflow" }, async (_event, step) => {
      const seed = await step.do("seed", () => 3);
      const ready = await step.waitForEvent<{ ok: boolean }>("ready", { type: "ready" });
      const result = await step.do("result", () => (ready.payload.ok ? seed + 1 : seed));
      return { result };
    });

    const workflows = { HISTORY: HistoryWorkflow };

    type ScenarioVars = {
      status?: { status: string };
      history?: {
        steps: Array<{ stepKey: string; createdAt: Date | string }>;
        events: WorkflowScenarioEventRow[];
      };
      historyByRun?: { steps: unknown[]; events: unknown[] };
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "history-ordering",
      workflows,
      steps: [
        scenarioSteps.create({ workflow: "HISTORY", id: "history-1" }),
        scenarioSteps.tick({ workflow: "HISTORY", instanceId: "history-1", reason: "create" }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("HISTORY", "history-1"),
          storeAs: "status",
        }),
        scenarioSteps.event({
          workflow: "HISTORY",
          instanceId: "history-1",
          event: { type: "ready", payload: { ok: true } },
        }),
        scenarioSteps.tick({ workflow: "HISTORY", instanceId: "history-1", reason: "event" }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("HISTORY", "history-1"),
          storeAs: "status",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getHistory("HISTORY", "history-1", { order: "desc" }),
          storeAs: "history",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getHistory("HISTORY", "history-1", { order: "desc" }),
          storeAs: "historyByRun",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.status?.status).toBe("complete");

          const history = ctx.vars.history;

          const stepKeys = history?.steps.map((step) => step.stepKey).sort() ?? [];
          expect(stepKeys).toEqual(["do:result", "do:seed", "waitForEvent:ready"]);

          const stepTimestamps =
            history?.steps.map((step) => new Date(step.createdAt as Date | string).getTime()) ?? [];
          expect([...stepTimestamps].sort((a, b) => b - a)).toEqual(stepTimestamps);

          expect(history?.events).toHaveLength(1);
          expect(history?.events[0]).toMatchObject({
            type: "ready",
            payload: { ok: true },
            consumedByStepKey: "waitForEvent:ready",
          });
          const deliveredAt = history?.events[0].deliveredAt;
          expect(deliveredAt).toBeTruthy();
          expect(new Date(deliveredAt as Date | string).toString()).not.toBe("Invalid Date");
          expect(ctx.vars.historyByRun?.steps).toHaveLength(3);
          expect(ctx.vars.historyByRun?.events).toHaveLength(1);
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("consumes multiple events of the same type in order", async () => {
    const EventOrderWorkflow = defineWorkflow(
      { name: "event-order-workflow" },
      async (_event, step) => {
        const first = await step.waitForEvent<{ value: number }>("first", { type: "ready" });
        const second = await step.waitForEvent<{ value: number }>("second", { type: "ready" });
        return { first: first.payload.value, second: second.payload.value };
      },
    );

    const workflows = { EVENT_ORDER: EventOrderWorkflow };

    type ScenarioVars = {
      status?: { status: string; output?: { first: number; second: number } };
      events?: Array<{ id: unknown; payload: unknown; consumedByStepKey: string | null }>;
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "event-order",
      workflows,
      steps: [
        scenarioSteps.create({ workflow: "EVENT_ORDER", id: "event-order-1" }),
        scenarioSteps.tick({
          workflow: "EVENT_ORDER",
          instanceId: "event-order-1",
          reason: "create",
        }),
        scenarioSteps.event({
          workflow: "EVENT_ORDER",
          instanceId: "event-order-1",
          event: { type: "ready", payload: { value: 1 } },
          timestamp: new Date(1000),
        }),
        scenarioSteps.event({
          workflow: "EVENT_ORDER",
          instanceId: "event-order-1",
          event: { type: "ready", payload: { value: 2 } },
          timestamp: new Date(1001),
        }),
        scenarioSteps.tick({
          workflow: "EVENT_ORDER",
          instanceId: "event-order-1",
          reason: "event",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("EVENT_ORDER", "event-order-1"),
          storeAs: "status",
        }),
        scenarioSteps.read({
          read: async (ctx) => {
            return (
              await ctx.harness.db
                .createUnitOfWork("read")
                .forSchema(workflowsSchema)
                .find("workflow_event", (b) => b.whereIndex("primary"))
                .executeRetrieve()
            )[0];
          },
          storeAs: "events",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.status?.status).toBe("complete");
          const events = ctx.vars.events ?? [];
          expect(events).toHaveLength(2);

          const [firstEvent, secondEvent] = events;

          expect(ctx.vars.status?.output).toEqual({
            first: (firstEvent.payload as { value: number }).value,
            second: (secondEvent.payload as { value: number }).value,
          });
          expect(firstEvent).toMatchObject({
            consumedByStepKey: "waitForEvent:first",
          });
          expect(secondEvent).toMatchObject({
            consumedByStepKey: "waitForEvent:second",
          });
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("treats event hooks as run ticks", async () => {
    const EventReasonWorkflow = defineWorkflow(
      { name: "event-reason-workflow" },
      async (_event, step) => {
        const ready = await step.waitForEvent<{ ok: boolean }>("ready", { type: "ready" });
        return { ok: ready.payload.ok };
      },
    );

    const workflows = { EVENT_REASON: EventReasonWorkflow };

    type ScenarioVars = {
      statusAfterCreate?: { status: string };
      statusAfterEventTick?: { status: string };
      steps?: WorkflowScenarioStepRow[];
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "event-reason-ticks",
      workflows,
      steps: [
        scenarioSteps.create({ workflow: "EVENT_REASON", id: "event-reason-1" }),
        scenarioSteps.tick({
          workflow: "EVENT_REASON",
          instanceId: "event-reason-1",
          reason: "create",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("EVENT_REASON", "event-reason-1"),
          storeAs: "statusAfterCreate",
        }),
        scenarioSteps.tick({
          workflow: "EVENT_REASON",
          instanceId: "event-reason-1",
          reason: "event",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("EVENT_REASON", "event-reason-1"),
          storeAs: "statusAfterEventTick",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getSteps("EVENT_REASON", "event-reason-1"),
          storeAs: "steps",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.statusAfterCreate?.status).toBe("waiting");
          expect(ctx.vars.statusAfterEventTick?.status).toBe("waiting");
          expect(ctx.vars.steps?.[0]).toMatchObject({
            stepKey: "waitForEvent:ready",
            status: "waiting",
            waitEventType: "ready",
          });
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("treats resume hooks as run ticks", async () => {
    const ResumeReasonWorkflow = defineWorkflow(
      { name: "resume-reason-workflow" },
      async (_event, step) => {
        const ready = await step.waitForEvent<{ ok: boolean }>("ready", { type: "ready" });
        return { ok: ready.payload.ok };
      },
    );

    const workflows = { RESUME_REASON: ResumeReasonWorkflow };

    type ScenarioVars = {
      pauseResponse?: RouteResponse;
      resumeResponse?: RouteResponse;
      pausedStatus?: { status: string };
      activeStatus?: { status: string };
      finalStatus?: { status: string };
      steps?: WorkflowScenarioStepRow[];
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "resume-reason-ticks",
      workflows,
      steps: [
        scenarioSteps.create({ workflow: "RESUME_REASON", id: "resume-reason-1" }),
        scenarioSteps.tick({
          workflow: "RESUME_REASON",
          instanceId: "resume-reason-1",
          reason: "create",
        }),
        scenarioSteps.pause({
          workflow: "RESUME_REASON",
          instanceId: "resume-reason-1",
          storeAs: "pauseResponse",
        }),
        scenarioSteps.tick({
          workflow: "RESUME_REASON",
          instanceId: "resume-reason-1",
          reason: "event",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("RESUME_REASON", "resume-reason-1"),
          storeAs: "pausedStatus",
        }),
        scenarioSteps.resume({
          workflow: "RESUME_REASON",
          instanceId: "resume-reason-1",
          storeAs: "resumeResponse",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("RESUME_REASON", "resume-reason-1"),
          storeAs: "activeStatus",
        }),
        scenarioSteps.tick({
          workflow: "RESUME_REASON",
          instanceId: "resume-reason-1",
          reason: "resume",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("RESUME_REASON", "resume-reason-1"),
          storeAs: "finalStatus",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getSteps("RESUME_REASON", "resume-reason-1"),
          storeAs: "steps",
        }),
        scenarioSteps.assert((ctx) => {
          assertOkResponse(ctx.vars.pauseResponse as RouteResponse);
          assertOkResponse(ctx.vars.resumeResponse as RouteResponse);

          expect(ctx.vars.pausedStatus?.status).toBe("paused");
          expect(ctx.vars.activeStatus?.status).toBe("active");
          expect(ctx.vars.finalStatus?.status).toBe("waiting");
          expect(ctx.vars.steps?.[0]).toMatchObject({
            stepKey: "waitForEvent:ready",
            status: "waiting",
            waitEventType: "ready",
          });
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("keeps paused workflows from consuming events until resume", async () => {
    const PauseEventWorkflow = defineWorkflow(
      { name: "pause-event-workflow" },
      async (_event, step) => {
        const ready = await step.waitForEvent<{ ok: boolean }>("ready", { type: "ready" });
        return { ok: ready.payload.ok };
      },
    );

    const workflows = { PAUSE_EVENT: PauseEventWorkflow };

    type ScenarioVars = {
      pauseResponse?: RouteResponse;
      resumeResponse?: RouteResponse;
      pausedStatus?: { status: string };
      activeStatus?: { status: string };
      finalStatus?: { status: string; output?: { ok: boolean } };
      eventsBefore?: WorkflowScenarioEventRow[];
      eventsAfter?: WorkflowScenarioEventRow[];
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "pause-event-consumption",
      workflows,
      steps: [
        scenarioSteps.create({ workflow: "PAUSE_EVENT", id: "pause-event-1" }),
        scenarioSteps.tick({
          workflow: "PAUSE_EVENT",
          instanceId: "pause-event-1",
          reason: "create",
        }),
        scenarioSteps.pause({
          workflow: "PAUSE_EVENT",
          instanceId: "pause-event-1",
          storeAs: "pauseResponse",
        }),
        scenarioSteps.tick({
          workflow: "PAUSE_EVENT",
          instanceId: "pause-event-1",
          reason: "event",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("PAUSE_EVENT", "pause-event-1"),
          storeAs: "pausedStatus",
        }),
        scenarioSteps.event({
          workflow: "PAUSE_EVENT",
          instanceId: "pause-event-1",
          event: { type: "ready", payload: { ok: true } },
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("PAUSE_EVENT", "pause-event-1"),
          storeAs: "pausedStatus",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getEvents("PAUSE_EVENT", "pause-event-1"),
          storeAs: "eventsBefore",
        }),
        scenarioSteps.resume({
          workflow: "PAUSE_EVENT",
          instanceId: "pause-event-1",
          storeAs: "resumeResponse",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("PAUSE_EVENT", "pause-event-1"),
          storeAs: "activeStatus",
        }),
        scenarioSteps.tick({
          workflow: "PAUSE_EVENT",
          instanceId: "pause-event-1",
          reason: "resume",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("PAUSE_EVENT", "pause-event-1"),
          storeAs: "finalStatus",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getEvents("PAUSE_EVENT", "pause-event-1"),
          storeAs: "eventsAfter",
        }),
        scenarioSteps.assert((ctx) => {
          assertOkResponse(ctx.vars.pauseResponse as RouteResponse);
          assertOkResponse(ctx.vars.resumeResponse as RouteResponse);
          expect(ctx.vars.pausedStatus?.status).toBe("paused");
          expect(ctx.vars.activeStatus?.status).toBe("active");
          expect(ctx.vars.finalStatus?.status).toBe("complete");
          expect(ctx.vars.finalStatus?.output).toEqual({ ok: true });

          const readyBefore = (ctx.vars.eventsBefore ?? []).find((event) => event.type === "ready");
          expect(readyBefore).toMatchObject({
            type: "ready",
            consumedByStepKey: null,
            deliveredAt: null,
          });

          const readyAfter = (ctx.vars.eventsAfter ?? []).find((event) => event.type === "ready");
          expect(readyAfter).toMatchObject({
            type: "ready",
            consumedByStepKey: "waitForEvent:ready",
          });
          expect(readyAfter?.deliveredAt).toBeInstanceOf(Date);
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("applies WorkflowStepTx mutations", async () => {
    const mutationsSchema = schema("mutations_test", (s) =>
      s.addTable("mutation_record", (t) =>
        t
          .addColumn("id", idColumn())
          .addColumn("note", column("string"))
          .addColumn(
            "createdAt",
            column("timestamp").defaultTo((b) => b.now()),
          )
          .createIndex("idx_note", ["note"]),
      ),
    );

    const mutationsFragmentDefinition = defineFragment("mutations-fragment")
      .extend(withDatabase(mutationsSchema))
      .build();

    const MutateWorkflow = defineWorkflow({ name: "mutate-workflow" }, async (event, step) => {
      const note = `fromTx-${event.instanceId}`;
      const result = await step.do("mutate", (tx) => {
        tx.mutate((ctx) => {
          ctx.forSchema(mutationsSchema).create("mutation_record", { note });
        });
        return "mutated";
      });
      return { result };
    });

    const workflows = { MUTATE: MutateWorkflow };

    type ScenarioVars = {
      status?: { status: string; output?: { result: string } };
      mutationRows?: Array<{ note: string }>;
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "step-tx-mutations",
      workflows,
      harness: {
        configureBuilder: (builder) =>
          builder.withFragment("mutations", instantiate(mutationsFragmentDefinition)),
      },
      steps: [
        scenarioSteps.initializeAndRunUntilIdle({ workflow: "MUTATE", id: "mutate-1" }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("MUTATE", "mutate-1"),
          storeAs: "status",
        }),
        scenarioSteps.read({
          read: async (ctx) => {
            return (
              await ctx.harness.fragments["mutations"].db
                .createUnitOfWork("read")
                .forSchema(mutationsSchema)
                .find("mutation_record", (b) => b.whereIndex("primary"))
                .executeRetrieve()
            )[0];
          },
          storeAs: "mutationRows",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.status?.status).toBe("complete");
          expect(ctx.vars.status?.output).toEqual({ result: "mutated" });
          expect(ctx.vars.mutationRows).toHaveLength(1);
          expect(ctx.vars.mutationRows?.[0]).toMatchObject({ note: "fromTx-mutate-1" });
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("rejects non-mutate serviceCalls in WorkflowStepTx", async () => {
    const serviceCallsSchema = schema("service_calls_test", (s) =>
      s.addTable("service_record", (t) =>
        t
          .addColumn("id", idColumn())
          .addColumn("note", column("string"))
          .addColumn(
            "createdAt",
            column("timestamp").defaultTo((b) => b.now()),
          )
          .createIndex("idx_note", ["note"]),
      ),
    );

    const serviceCallsFragmentDefinition = defineFragment("service-calls-fragment")
      .extend(withDatabase(serviceCallsSchema))
      .providesBaseService(({ defineService }) =>
        defineService({
          listRecords: function () {
            return this.serviceTx(serviceCallsSchema)
              .retrieve((uow) => uow.find("service_record", (b) => b.whereIndex("primary")))
              .build();
          },
        }),
      )
      .build();

    let serviceCallFragment: InstantiatedFragmentFromDefinition<
      typeof serviceCallsFragmentDefinition
    >;

    const ServiceCallWorkflow = defineWorkflow(
      { name: "service-call-workflow" },
      async (_event, step) => {
        await step.do("call", (tx) => {
          tx.serviceCalls(() => [serviceCallFragment.services.listRecords()]);
          return "active";
        });
        return { ok: true };
      },
    );

    const workflows = { SERVICE_CALL: ServiceCallWorkflow };

    type ScenarioVars = {
      status?: { status: string; error?: { message?: string } };
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "step-tx-service-calls",
      workflows,
      harness: {
        configureBuilder: (builder) =>
          builder.withFragmentFactory(
            "serviceCalls",
            serviceCallsFragmentDefinition,
            ({ adapter }) => {
              const fragment = instantiate(serviceCallsFragmentDefinition)
                .withOptions({ databaseAdapter: adapter })
                .build();
              serviceCallFragment = fragment;
              return fragment;
            },
          ),
      },
      steps: [
        scenarioSteps.initializeAndRunUntilIdle({ workflow: "SERVICE_CALL", id: "service-call-1" }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("SERVICE_CALL", "service-call-1"),
          storeAs: "status",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.status?.status).toBe("errored");
          expect(ctx.vars.status?.error?.message).toBe("WORKFLOW_STEP_TX_RETRIEVE_NOT_SUPPORTED");
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("retries a failed step and succeeds", async () => {
    let attempts = 0;
    const RetryWorkflow = defineWorkflow({ name: "retry-workflow" }, async (_event, step) => {
      const result = await step.do(
        "unstable",
        { retries: { limit: 1, delay: 0, backoff: "constant" } },
        () => {
          attempts += 1;
          if (attempts === 1) {
            throw new Error("RETRY_ME");
          }
          return "ok";
        },
      );
      return { result };
    });

    const workflows = { RETRY: RetryWorkflow };

    type ScenarioVars = {
      status?: { status: string; output?: { result: string } };
      steps?: WorkflowScenarioStepRow[];
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "retry-success",
      workflows,
      steps: [
        scenarioSteps.initializeAndRunUntilIdle({ workflow: "RETRY", id: "retry-1" }),
        scenarioSteps.retryAndRunUntilIdle({ workflow: "RETRY", instanceId: "retry-1" }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("RETRY", "retry-1"),
          storeAs: "status",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getSteps("RETRY", "retry-1"),
          storeAs: "steps",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.status?.status).toBe("complete");
          expect(ctx.vars.status?.output).toEqual({ result: "ok" });
          expect(ctx.vars.steps?.[0]).toMatchObject({
            stepKey: "do:unstable",
            status: "completed",
            attempts: 2,
          });
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("does not retry before nextRetryAt", async () => {
    let attempts = 0;
    const RetryWorkflow = defineWorkflow({ name: "retry-early-workflow" }, async (_event, step) => {
      const result = await step.do(
        "unstable",
        { retries: { limit: 1, delay: "5 minutes", backoff: "constant" } },
        () => {
          attempts += 1;
          if (attempts === 1) {
            throw new Error("RETRY_ME");
          }
          return "ok";
        },
      );
      return { result };
    });

    const workflows = { RETRY_EARLY: RetryWorkflow };

    type ScenarioVars = {
      waiting?: { status: string };
      waitingSteps?: WorkflowScenarioStepRow[];
      nextRetryAt?: Date;
      afterRetry?: { status: string; output?: { result: string } };
      afterSteps?: WorkflowScenarioStepRow[];
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "retry-early",
      workflows,
      steps: [
        scenarioSteps.create({ workflow: "RETRY_EARLY", id: "retry-early-1" }),
        scenarioSteps.tick({
          workflow: "RETRY_EARLY",
          instanceId: "retry-early-1",
          reason: "create",
        }),
        // First tick should record a failed attempt and a nextRetryAt timestamp.
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("RETRY_EARLY", "retry-early-1"),
          storeAs: "waiting",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getSteps("RETRY_EARLY", "retry-early-1"),
          storeAs: "waitingSteps",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.vars.waitingSteps?.[0].nextRetryAt ?? null,
          storeAs: "nextRetryAt",
        }),
        // Simulate an early retry hook before nextRetryAt.
        // The runner should suspend again and not execute the retry yet.
        scenarioSteps.tick({
          workflow: "RETRY_EARLY",
          instanceId: "retry-early-1",
          reason: "retry",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("RETRY_EARLY", "retry-early-1"),
          storeAs: "afterRetry",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getSteps("RETRY_EARLY", "retry-early-1"),
          storeAs: "afterSteps",
        }),
        scenarioSteps.assert((ctx) => {
          // If this fails, we are retrying early based on the hook timestamp instead
          // of honoring the persisted nextRetryAt.
          expect(ctx.vars.waiting?.status).toBe("waiting");
          expect(ctx.vars.waitingSteps?.[0]).toMatchObject({
            stepKey: "do:unstable",
            status: "waiting",
            attempts: 1,
          });
          expect(ctx.vars.waitingSteps?.[0].nextRetryAt).toBeInstanceOf(Date);
          expect(ctx.vars.afterRetry?.status).toBe("waiting");
          expect(ctx.vars.afterSteps?.[0]).toMatchObject({
            stepKey: "do:unstable",
            status: "waiting",
            attempts: 1,
          });
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("marks workflow errored when step throws", async () => {
    const ErrorWorkflow = defineWorkflow({ name: "error-workflow" }, async (_event, step) => {
      await step.do("boom", () => {
        throw new Error("BOOM");
      });
      return { ok: true };
    });

    const workflows = { ERROR: ErrorWorkflow };

    type ScenarioVars = {
      status?: { status: string };
      steps?: WorkflowScenarioStepRow[];
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "errored-step",
      workflows,
      steps: [
        scenarioSteps.initializeAndRunUntilIdle({ workflow: "ERROR", id: "error-1" }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("ERROR", "error-1"),
          storeAs: "status",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getSteps("ERROR", "error-1"),
          storeAs: "steps",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.status?.status).toBe("errored");
          expect(ctx.vars.steps?.[0]).toMatchObject({
            stepKey: "do:boom",
            status: "errored",
          });
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("pauses an active instance and resumes to completion", async () => {
    let runs = 0;
    const PauseWorkflow = defineWorkflow(
      { name: "pause-management-workflow" },
      async (_event, step) => {
        const value = await step.do("count", () => {
          runs += 1;
          return runs;
        });
        return { value };
      },
    );

    const workflows = { PAUSE: PauseWorkflow };

    type ScenarioVars = {
      pauseResponse?: RouteResponse;
      resumeResponse?: RouteResponse;
      pausedStatus?: { status: string };
      activeStatus?: { status: string };
      finalStatus?: { status: string; output?: { value: number } };
      instance?: WorkflowScenarioInstanceRow | null;
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "pause-resume",
      workflows,
      steps: [
        scenarioSteps.create({ workflow: "PAUSE", id: "pause-1" }),
        scenarioSteps.pause({
          workflow: "PAUSE",
          instanceId: "pause-1",
          storeAs: "pauseResponse",
        }),
        scenarioSteps.runCreateUntilIdle({ workflow: "PAUSE", instanceId: "pause-1" }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("PAUSE", "pause-1"),
          storeAs: "pausedStatus",
        }),
        scenarioSteps.resume({
          workflow: "PAUSE",
          instanceId: "pause-1",
          storeAs: "resumeResponse",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("PAUSE", "pause-1"),
          storeAs: "activeStatus",
        }),
        scenarioSteps.runResumeUntilIdle({ workflow: "PAUSE", instanceId: "pause-1" }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("PAUSE", "pause-1"),
          storeAs: "finalStatus",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getInstance("PAUSE", "pause-1"),
          storeAs: "instance",
        }),
        scenarioSteps.assert((ctx) => {
          assertOkResponse(ctx.vars.pauseResponse as RouteResponse);
          assertOkResponse(ctx.vars.resumeResponse as RouteResponse);
          expect(ctx.vars.pausedStatus?.status).toBe("paused");
          expect(ctx.vars.activeStatus?.status).toBe("active");
          expect(ctx.vars.finalStatus?.status).toBe("complete");
          expect(ctx.vars.finalStatus?.output).toEqual({ value: 1 });
          expect(ctx.vars.instance).toMatchObject({
            status: "complete",
          });
          expect(runs).toBe(1);
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("terminates an active instance and ignores pending ticks", async () => {
    let runs = 0;
    const TerminateWorkflow = defineWorkflow(
      { name: "terminate-management-workflow" },
      async (_event, step) => {
        const value = await step.do("count", () => {
          runs += 1;
          return runs;
        });
        return { value };
      },
    );

    const workflows = { TERM: TerminateWorkflow };

    type ScenarioVars = {
      terminateResponse?: RouteResponse;
      status?: { status: string };
      steps?: WorkflowScenarioStepRow[];
      instance?: WorkflowScenarioInstanceRow | null;
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "terminate-active",
      workflows,
      steps: [
        scenarioSteps.create({ workflow: "TERM", id: "term-1" }),
        scenarioSteps.terminate({
          workflow: "TERM",
          instanceId: "term-1",
          storeAs: "terminateResponse",
        }),
        scenarioSteps.runCreateUntilIdle({ workflow: "TERM", instanceId: "term-1" }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("TERM", "term-1"),
          storeAs: "status",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getSteps("TERM", "term-1"),
          storeAs: "steps",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getInstance("TERM", "term-1"),
          storeAs: "instance",
        }),
        scenarioSteps.assert((ctx) => {
          assertOkResponse(ctx.vars.terminateResponse as RouteResponse);
          expect(ctx.vars.status?.status).toBe("terminated");
          expect(ctx.vars.steps).toHaveLength(0);
          expect(ctx.vars.instance).toMatchObject({
            status: "terminated",
          });
          expect(ctx.vars.instance?.completedAt).toBeInstanceOf(Date);
          expect(runs).toBe(0);
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("ignores wake ticks after termination", async () => {
    const SleepWorkflow = defineWorkflow(
      { name: "terminate-sleep-workflow" },
      async (_event, step) => {
        await step.sleep("nap", "10 minutes");
        return { done: true };
      },
    );

    const workflows = { SLEEP_TERM: SleepWorkflow };

    type ScenarioVars = {
      waitingStatus?: { status: string };
      waitingSteps?: WorkflowScenarioStepRow[];
      wakeAt?: Date;
      terminateResponse?: RouteResponse;
      wakeProcessed?: number;
      afterWakeStatus?: { status: string };
      afterWakeSteps?: WorkflowScenarioStepRow[];
      instance?: WorkflowScenarioInstanceRow | null;
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "terminate-sleep-wake",
      workflows,
      steps: [
        scenarioSteps.create({ workflow: "SLEEP_TERM", id: "sleep-term-1" }),
        scenarioSteps.tick({
          workflow: "SLEEP_TERM",
          instanceId: "sleep-term-1",
          reason: "create",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("SLEEP_TERM", "sleep-term-1"),
          storeAs: "waitingStatus",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getSteps("SLEEP_TERM", "sleep-term-1"),
          storeAs: "waitingSteps",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.vars.waitingSteps?.[0].wakeAt ?? null,
          storeAs: "wakeAt",
        }),
        scenarioSteps.terminate({
          workflow: "SLEEP_TERM",
          instanceId: "sleep-term-1",
          storeAs: "terminateResponse",
        }),
        scenarioSteps.tick({
          workflow: "SLEEP_TERM",
          instanceId: "sleep-term-1",
          reason: "wake",
          timestamp: (ctx) => {
            const wakeAt = ctx.vars.wakeAt;
            if (!wakeAt) {
              throw new Error("MISSING_WAKE_AT");
            }
            return new Date(wakeAt.getTime() + 1);
          },
          storeAs: "wakeProcessed",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("SLEEP_TERM", "sleep-term-1"),
          storeAs: "afterWakeStatus",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getSteps("SLEEP_TERM", "sleep-term-1"),
          storeAs: "afterWakeSteps",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getInstance("SLEEP_TERM", "sleep-term-1"),
          storeAs: "instance",
        }),
        scenarioSteps.assert((ctx) => {
          assertOkResponse(ctx.vars.terminateResponse as RouteResponse);
          expect(ctx.vars.waitingStatus?.status).toBe("waiting");
          expect(ctx.vars.wakeAt).toBeInstanceOf(Date);
          expect(ctx.vars.wakeProcessed).toBe(0);
          expect(ctx.vars.afterWakeStatus?.status).toBe("terminated");
          expect(ctx.vars.instance).toMatchObject({ status: "terminated" });
          expect(ctx.vars.instance?.completedAt).toBeInstanceOf(Date);
          expect(ctx.vars.afterWakeSteps?.[0]).toMatchObject({
            stepKey: "sleep:nap",
            status: "waiting",
          });
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("createBatch creates multiple instances and runs them", async () => {
    const BatchWorkflow = defineWorkflow({ name: "batch-workflow" }, async (event, step) => {
      const result = await step.do("result", () => ({
        instanceId: event.instanceId,
      }));
      return result;
    });

    const workflows = { BATCH: BatchWorkflow };

    type ScenarioVars = {
      created?: Array<{ id: string; details: { status: string } }>;
      status1?: { status: string; output?: { instanceId: string } };
      status2?: { status: string; output?: { instanceId: string } };
      status3?: { status: string; output?: { instanceId: string } };
      instances?: WorkflowScenarioInstanceRow[];
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "batch-create",
      workflows,
      steps: [
        scenarioSteps.createBatch({
          workflow: "BATCH",
          instances: [{ id: "batch-1" }, { id: "batch-2" }, { id: "batch-3" }],
          storeAs: "created",
        }),
        scenarioSteps.runCreateUntilIdle({ workflow: "BATCH", instanceId: "batch-1" }),
        scenarioSteps.runCreateUntilIdle({ workflow: "BATCH", instanceId: "batch-2" }),
        scenarioSteps.runCreateUntilIdle({ workflow: "BATCH", instanceId: "batch-3" }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("BATCH", "batch-1"),
          storeAs: "status1",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("BATCH", "batch-2"),
          storeAs: "status2",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("BATCH", "batch-3"),
          storeAs: "status3",
        }),
        scenarioSteps.read({
          read: async (ctx) => {
            return (
              await ctx.harness.db
                .createUnitOfWork("read")
                .forSchema(workflowsSchema)
                .find("workflow_instance", (b) => b.whereIndex("primary"))
                .executeRetrieve()
            )[0];
          },
          storeAs: "instances",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.created).toHaveLength(3);
          expect(ctx.vars.created?.map((entry) => entry.id)).toEqual([
            "batch-1",
            "batch-2",
            "batch-3",
          ]);
          expect(ctx.vars.created?.map((entry) => entry.details.status)).toEqual([
            "active",
            "active",
            "active",
          ]);

          expect(ctx.vars.status1?.status).toBe("complete");
          expect(ctx.vars.status2?.status).toBe("complete");
          expect(ctx.vars.status3?.status).toBe("complete");
          expect(ctx.vars.status1?.output).toEqual({ instanceId: "batch-1" });
          expect(ctx.vars.status2?.output).toEqual({ instanceId: "batch-2" });
          expect(ctx.vars.status3?.output).toEqual({ instanceId: "batch-3" });
          expect(ctx.vars.instances).toHaveLength(3);
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("createBatch skips existing and duplicate instance ids", async () => {
    const BatchWorkflow = defineWorkflow({ name: "batch-skip-workflow" }, async (event, step) => {
      const value = await step.do("result", () => event.instanceId);
      return { value };
    });

    const workflows = { BATCH_SKIP: BatchWorkflow };

    type ScenarioVars = {
      created?: Array<{ id: string; details: { status: string } }>;
      instances?: WorkflowScenarioInstanceRow[];
      freshStatus?: { status: string; output?: { value: string } };
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "batch-skip",
      workflows,
      steps: [
        scenarioSteps.create({ workflow: "BATCH_SKIP", id: "existing-1" }),
        scenarioSteps.createBatch({
          workflow: "BATCH_SKIP",
          instances: [{ id: "existing-1" }, { id: "dup-1" }, { id: "dup-1" }, { id: "fresh-1" }],
          storeAs: "created",
        }),
        scenarioSteps.read({
          read: async (ctx) => {
            return (
              await ctx.harness.db
                .createUnitOfWork("read")
                .forSchema(workflowsSchema)
                .find("workflow_instance", (b) => b.whereIndex("primary"))
                .executeRetrieve()
            )[0];
          },
          storeAs: "instances",
        }),
        scenarioSteps.runCreateUntilIdle({ workflow: "BATCH_SKIP", instanceId: "dup-1" }),
        scenarioSteps.runCreateUntilIdle({ workflow: "BATCH_SKIP", instanceId: "fresh-1" }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("BATCH_SKIP", "fresh-1"),
          storeAs: "freshStatus",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.created?.map((entry) => entry.id)).toEqual(["dup-1", "fresh-1"]);
          expect(ctx.vars.instances).toHaveLength(3);
          expect(ctx.vars.freshStatus?.status).toBe("complete");
          expect(ctx.vars.freshStatus?.output).toEqual({ value: "fresh-1" });
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("createBatch route returns created instances", async () => {
    const RouteBatchWorkflow = defineWorkflow(
      { name: "batch-route-workflow" },
      async (_event, step) => {
        const value = await step.do("result", () => "ok");
        return { value };
      },
    );

    const workflows = { BATCH_ROUTE: RouteBatchWorkflow };

    type ScenarioVars = {
      response?: RouteResponse;
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "batch-route-response",
      workflows,
      steps: [
        scenarioSteps.read({
          read: (ctx) =>
            (ctx.harness.fragment as AnyFragnoInstantiatedFragment).callRoute(
              "POST",
              "/:workflowName/instances/batch",
              {
                pathParams: { workflowName: RouteBatchWorkflow.name },
                body: { instances: [{ id: "route-1" }, { id: "route-2" }] },
              },
            ),
          storeAs: "response",
        }),
        scenarioSteps.assert((ctx) => {
          const response = assertJsonResponse<{
            instances: Array<{ id: string; details: { status: string } }>;
          }>(ctx.vars.response as RouteResponse);

          expect(response.instances.map((entry) => entry.id)).toEqual(["route-1", "route-2"]);
          expect(response.instances.map((entry) => entry.details.status)).toEqual([
            "active",
            "active",
          ]);
        }),
      ],
    });

    const previousDebug = process.env["FRAGNO_DEBUG_BATCH_ROUTE"];
    process.env["FRAGNO_DEBUG_BATCH_ROUTE"] = "1";
    try {
      await runScenario(scenario);
    } finally {
      if (previousDebug === undefined) {
        delete process.env["FRAGNO_DEBUG_BATCH_ROUTE"];
      } else {
        process.env["FRAGNO_DEBUG_BATCH_ROUTE"] = previousDebug;
      }
    }
  });

  test("step emissions are observable during the callback and cleaned up afterwards", async () => {
    const runtime = createWorkflowsTestRuntime();

    const EmittingWorkflow = defineWorkflow<"scenario-step-emissions", undefined, { ok: true }>(
      { name: "scenario-step-emissions" },
      async (_event, step) => {
        await step.do("stream", async (tx) => {
          tx.emit({ type: "phase", phase: "started" });
          runtime.controls.resolve("stream:started");
          await runtime.controls.wait("stream:release");
          tx.emit({ type: "phase", phase: "complete" });
        });
        return { ok: true };
      },
    );

    const workflows = { EMIT: EmittingWorkflow };
    type ScenarioVars = {
      messages?: unknown[];
      started?: unknown;
      rowsWhileRunning?: unknown[];
      rowsAfterCleanup?: unknown[];
      status?: { status: string; output?: { ok: true } };
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "scenario-step-emissions",
      workflows,
      harness: { runtime },
      steps: [
        scenarioSteps.create({ workflow: "EMIT", id: "emit-1" }),
        scenarioSteps.captureEmissions({
          workflow: "EMIT",
          instanceId: "emit-1",
          storeAs: "messages",
        }),
        scenarioSteps.withRunners({
          runner: [scenarioSteps.runCreateUntilIdle({ workflow: "EMIT", instanceId: "emit-1" })],
          observer: [
            scenarioSteps.waitForEmission({
              capture: "messages",
              match: (message) =>
                (message.payload as { type?: string; phase?: string }).type === "phase" &&
                (message.payload as { phase?: string }).phase === "started",
              storeAs: "started",
            }),
            scenarioSteps.read({
              read: (ctx) => ctx.state.getEmissions("EMIT", "emit-1"),
              storeAs: "rowsWhileRunning",
            }),
            scenarioSteps.resolveControl({ key: "stream:release" }),
          ],
        }),
        scenarioSteps.drainHooks(),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getEmissions("EMIT", "emit-1"),
          storeAs: "rowsAfterCleanup",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("EMIT", "emit-1"),
          storeAs: "status",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.started).toMatchObject({
            stepKey: "do:stream",
            payload: { type: "phase", phase: "started" },
          });
          expect(ctx.vars.messages).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ payload: { type: "phase", phase: "started" } }),
              expect.objectContaining({ payload: { type: "phase", phase: "complete" } }),
            ]),
          );
          expect(ctx.vars.rowsWhileRunning).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ actor: "system", stepKey: "do:stream" }),
              expect.objectContaining({
                actor: "user",
                payload: { type: "phase", phase: "started" },
              }),
            ]),
          );
          expect(ctx.vars.rowsAfterCleanup).toEqual([]);
          expect(ctx.vars.status).toMatchObject({ status: "complete", output: { ok: true } });
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("events can be sent to active scenario steps", async () => {
    const runtime = createWorkflowsTestRuntime();
    const received: unknown[] = [];

    const InboundWorkflow = defineWorkflow<
      "scenario-step-inbound-emissions",
      undefined,
      { ok: true }
    >({ name: "scenario-step-inbound-emissions" }, async (_event, step) => {
      await step.do("interactive", async (tx) => {
        tx.onEvent("command", (event) => {
          received.push(event.payload);
          event.consume();
          runtime.controls.resolve("message:received");
        });
        runtime.controls.resolve("step:ready");
        await runtime.controls.wait("step:release");
      });
      return { ok: true };
    });

    const workflows = { INBOUND: InboundWorkflow };
    type Vars = { events?: unknown[] };
    const scenarioSteps = createScenarioSteps<typeof workflows, Vars>();
    const scenario = defineScenario<typeof workflows, Vars>({
      name: "scenario-step-inbound-emissions",
      workflows,
      harness: { runtime },
      steps: [
        scenarioSteps.create({ workflow: "INBOUND", id: "inbound-1" }),
        scenarioSteps.withRunners({
          runner: [
            scenarioSteps.runCreateUntilIdle({ workflow: "INBOUND", instanceId: "inbound-1" }),
          ],
          sender: [
            scenarioSteps.waitForControl({ key: "step:ready" }),
            scenarioSteps.event({
              workflow: "INBOUND",
              instanceId: "inbound-1",
              event: { type: "command", payload: { command: "continue" } },
            }),
            scenarioSteps.waitForControl({ key: "message:received" }),
            scenarioSteps.resolveControl({ key: "step:release" }),
          ],
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getEvents("INBOUND", "inbound-1"),
          storeAs: "events",
        }),
        scenarioSteps.assert((ctx) => {
          expect(received).toEqual([{ command: "continue" }]);
          expect(ctx.vars.events).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ type: "command", payload: { command: "continue" } }),
            ]),
          );
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("consumed live events are not replayed into consecutive steps", async () => {
    const runtime = createWorkflowsTestRuntime();
    const received: Array<{ step: string; message: unknown }> = [];

    const ConsecutiveInboundWorkflow = defineWorkflow<
      "service-step-message-replay",
      undefined,
      { ok: true }
    >({ name: "service-step-message-replay" }, async (_event, step) => {
      await step.do("first interactive", async (tx) => {
        tx.onEvent("command", (event) => {
          received.push({ step: "first", message: event.payload });
          event.consume();
          runtime.controls.resolve("message:first:received");
        });
        runtime.controls.resolve("step:first:ready");
        await runtime.controls.wait("step:first:release");
      });

      await step.do("second interactive", async (tx) => {
        tx.onEvent("command", (event) => {
          received.push({ step: "second", message: event.payload });
        });
        runtime.controls.resolve("step:second:ready");
        await new Promise((resolve) => setTimeout(resolve, 250));
      });

      return { ok: true };
    });

    const workflows = { INBOUND: ConsecutiveInboundWorkflow };
    const scenarioSteps = createScenarioSteps<typeof workflows, { events?: unknown[] }>();
    const scenario = defineScenario<typeof workflows, { events?: unknown[] }>({
      name: "service-step-message-replay",
      workflows,
      harness: {
        runtime,
        fragmentConfig: {
          stepEmissions: new BufferedPumpRegistry<WorkflowStepLivePump>(),
        },
      },
      steps: [
        scenarioSteps.create({ workflow: "INBOUND", id: "inbound-1" }),
        scenarioSteps.withRunners({
          runner: [
            scenarioSteps.runCreateUntilIdle({ workflow: "INBOUND", instanceId: "inbound-1" }),
          ],
          sender: [
            scenarioSteps.waitForControl({ key: "step:first:ready" }),
            scenarioSteps.event({
              workflow: "INBOUND",
              instanceId: "inbound-1",
              event: { type: "command", payload: { command: "continue" } },
            }),
            scenarioSteps.waitForControl({ key: "message:first:received" }),
            scenarioSteps.resolveControl({ key: "step:first:release" }),
            scenarioSteps.waitForControl({ key: "step:second:ready" }),
          ],
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getEvents("INBOUND", "inbound-1"),
          storeAs: "events",
        }),
        scenarioSteps.assert((ctx) => {
          expect(received).toEqual([{ step: "first", message: { command: "continue" } }]);
          expect(ctx.vars.events).toEqual([
            expect.objectContaining({ type: "command", payload: { command: "continue" } }),
          ]);
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("step emissions are visible during the callback and cleared afterwards", async () => {
    const EmittingStepWorkflow = defineWorkflow(
      { name: "emitting-step-workflow" },
      async (_event, step) => {
        await step.do("stream", async (tx) => {
          tx.emit({ phase: "streaming", count: 1 });
        });
        return { ok: true };
      },
    );

    const workflows = { EMIT: EmittingStepWorkflow };
    type ScenarioVars = {
      messages?: unknown[];
      rowsAfterCleanup?: unknown[];
      status?: { status: string };
    };
    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "step-emissions-clear",
      workflows,
      steps: [
        scenarioSteps.captureEmissions({
          workflow: "EMIT",
          instanceId: "emit-1",
          storeAs: "messages",
        }),
        scenarioSteps.initializeAndRunUntilIdle({ workflow: "EMIT", id: "emit-1" }),
        scenarioSteps.drainHooks(),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("EMIT", "emit-1"),
          storeAs: "status",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getEmissions("EMIT", "emit-1"),
          storeAs: "rowsAfterCleanup",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.status?.status).toBe("complete");
          expect(ctx.vars.messages).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                stepKey: "do:stream",
                payload: { phase: "streaming", count: 1 },
              }),
            ]),
          );
          expect(ctx.vars.rowsAfterCleanup).toEqual([]);
        }),
      ],
    });

    await runScenario(scenario);
  });
});
