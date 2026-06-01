import { describe, expect, test } from "vitest";

import { BufferedPumpRegistry } from "@fragno-dev/db/buffered-pump";
import { column, idColumn, schema } from "@fragno-dev/db/schema";

import {
  defineFragment,
  instantiate,
  type InstantiatedFragmentFromDefinition,
} from "@fragno-dev/core";
import { withDatabase } from "@fragno-dev/db";

import { createWorkflowsClient } from "./client/vanilla";
import type { WorkflowStepLivePump } from "./runner/step-live-pump";
import { defineScenario, runScenario } from "./scenario";
import { workflowsSchema } from "./schema";
import { createWorkflowsTestRuntime } from "./test";
import {
  defineWorkflow,
  WaitForEventTimeoutError,
  type AnyTxResult,
  type InstanceStatus,
} from "./workflow";

describe("Workflows Runner (Scenario DSL)", () => {
  test("rejects read steps that both store and assert", async () => {
    const NoopWorkflow = defineWorkflow({ name: "noop-workflow" }, async () => ({ ok: true }));
    const workflows = { NOOP: NoopWorkflow };

    await expect(
      runScenario(
        defineScenario({
          name: "read-store-and-assert",
          workflows,
          steps: ({ workflow }) => [
            workflow.read({
              read: () => 1,
              storeAs: "value",
              assert: () => {},
            } as never),
          ],
        }),
      ),
    ).rejects.toThrow("SCENARIO_READ_STEP_STORE_AS_AND_ASSERT_ARE_MUTUALLY_EXCLUSIVE");
  });

  test("runs a simple workflow to completion", async () => {
    const SimpleWorkflow = defineWorkflow({ name: "simple-workflow" }, async () => {
      return { ok: true };
    });

    const workflows = { SIMPLE: SimpleWorkflow };

    const scenario = defineScenario({
      name: "simple-workflow-complete",
      workflows,
      steps: ({ workflow, runner }) => [
        runner.initializeAndRunUntilIdle({ workflow: "SIMPLE", id: "simple-1" }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("SIMPLE", "simple-1"),
          assert: (status) => {
            expect(status).toMatchObject({
              status: "complete",
              output: { ok: true },
            });
          },
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

    const scenario = defineScenario({
      name: "completed-step",
      workflows,
      steps: ({ workflow, runner }) => [
        runner.initializeAndRunUntilIdle({ workflow: "STEP", id: "step-1" }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("STEP", "step-1"),
          assert: (status) => {
            expect(status.status).toBe("complete");
            expect(status.output).toEqual({ value: 42 });
          },
        }),
        workflow.read({
          read: (ctx) => ctx.state.getSteps("STEP", "step-1"),
          assert: (steps) => {
            expect(steps).toHaveLength(1);
            expect(steps[0]).toMatchObject({
              name: "compute",
              type: "do",
              status: "completed",
              stepKey: "do:compute",
            });
          },
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

    const scenario = defineScenario({
      name: "eventful-workflow",
      workflows,
      steps: ({ workflow, runner }) => [
        runner.initializeAndRunUntilIdle({ workflow: "EVENTFUL", id: "eventful-1" }),
        runner.eventAndRunUntilIdle({
          workflow: "EVENTFUL",
          instanceId: "eventful-1",
          event: { type: "ready", payload: { value: 9 } },
        }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("EVENTFUL", "eventful-1"),
          assert: (status) => {
            expect(status.status).toBe("complete");
            expect(status.output).toEqual({ seed: 3, sum: 12, eventValue: 9 });
          },
        }),
        workflow.read({
          read: (ctx) => ctx.state.getSteps("EVENTFUL", "eventful-1"),
          assert: (steps) => {
            expect(steps).toHaveLength(3);
            expect(steps.map((step) => step.stepKey).sort()).toEqual([
              "do:seed",
              "do:sum",
              "waitForEvent:ready",
            ]);
          },
        }),
        workflow.read({
          read: (ctx) => ctx.state.getEvents("EVENTFUL", "eventful-1"),
          assert: (events) => {
            expect(events).toHaveLength(1);
            expect(events[0]).toMatchObject({
              type: "ready",
              consumedByStepKey: "waitForEvent:ready",
            });
            expect(events[0]?.deliveredAt).toBeInstanceOf(Date);
          },
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

    const scenario = defineScenario({
      name: "parallel-steps",
      workflows,
      steps: ({ workflow, runner }) => [
        runner.initializeAndRunUntilIdle({ workflow: "PARALLEL", id: "parallel-1" }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("PARALLEL", "parallel-1"),
          assert: (status) => {
            expect(status.status).toBe("complete");
            expect(status.output).toEqual({ alpha: "A", beta: "B" });
          },
        }),
        workflow.read({
          read: (ctx) => ctx.state.getSteps("PARALLEL", "parallel-1"),
          assert: (steps) => {
            expect(steps).toHaveLength(2);
            expect(steps.map((step) => step.stepKey).sort()).toEqual(["do:alpha", "do:beta"]);
          },
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("Promise.all short-circuits before a sibling step result is persisted", async () => {
    let betaRuns = 0;

    // This is intentionally a weird workflow shape. In durable workflow code,
    // waitForEvent is a suspension point, not a long-lived JS promise waiting in memory.
    // We keep this test because it demonstrates what raw Promise.all does when one
    // branch suspends before a sibling branch has durably committed its result.
    const ParallelShortCircuitWorkflow = defineWorkflow(
      { name: "parallel-short-circuit-workflow" },
      async (_event, step) => {
        const [alpha, beta] = await Promise.all([
          step.waitForEvent("alpha", { type: "alpha" }).then(() => "A"),
          step.do("beta", async () => {
            betaRuns += 1;
            return "B";
          }),
        ]);
        return { alpha, beta };
      },
    );

    const workflows = { PARALLEL_SHORT_CIRCUIT: ParallelShortCircuitWorkflow };

    const scenario = defineScenario({
      name: "parallel-short-circuit-steps",
      workflows,
      steps: ({ workflow, runner }) => [
        workflow.create({ workflow: "PARALLEL_SHORT_CIRCUIT", id: "parallel-short-circuit-1" }),
        runner.tick({
          workflow: "PARALLEL_SHORT_CIRCUIT",
          instanceId: "parallel-short-circuit-1",
          reason: "create",
        }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("PARALLEL_SHORT_CIRCUIT", "parallel-short-circuit-1"),
          assert: (status) => {
            expect(status.status).toBe("waiting");
          },
        }),
        workflow.read({
          read: (ctx) => ctx.state.getSteps("PARALLEL_SHORT_CIRCUIT", "parallel-short-circuit-1"),
          assert: (steps) => {
            expect(steps).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  stepKey: "waitForEvent:alpha",
                  status: "waiting",
                }),
                expect.objectContaining({
                  stepKey: "do:beta",
                  status: "waiting",
                  attempts: 1,
                  result: null,
                }),
              ]),
            );
          },
        }),
        workflow.assert(() => {
          expect(betaRuns).toBe(1);
        }),
        runner.restart(),
        runner.eventAndRunUntilIdle({
          workflow: "PARALLEL_SHORT_CIRCUIT",
          instanceId: "parallel-short-circuit-1",
          event: { type: "alpha" },
        }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("PARALLEL_SHORT_CIRCUIT", "parallel-short-circuit-1"),
          assert: (status) => {
            expect(status).toMatchObject({
              status: "complete",
              output: { alpha: "A", beta: "B" },
            });
          },
        }),
        workflow.read({
          read: (ctx) => ctx.state.getSteps("PARALLEL_SHORT_CIRCUIT", "parallel-short-circuit-1"),
          assert: (steps) => {
            expect(steps).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  stepKey: "waitForEvent:alpha",
                  status: "completed",
                }),
                expect.objectContaining({
                  stepKey: "do:beta",
                  status: "completed",
                  attempts: 2,
                  result: "B",
                }),
              ]),
            );
          },
        }),
        workflow.assert(() => {
          expect(betaRuns).toBe(2);
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("Promise.all short-circuits between two do steps before a sibling result is persisted", async () => {
    let alphaRuns = 0;
    let betaRuns = 0;

    const ParallelDoShortCircuitWorkflow = defineWorkflow(
      { name: "parallel-do-short-circuit-workflow" },
      async (_event, step) => {
        const [alpha, beta] = await Promise.all([
          step.do("alpha", { retries: { limit: 1, delay: 0, backoff: "constant" } }, async () => {
            alphaRuns += 1;
            if (alphaRuns === 1) {
              throw new Error("RETRY_ALPHA");
            }
            return "A";
          }),
          step.do("beta", async () => {
            betaRuns += 1;
            await new Promise((resolve) => setTimeout(resolve, 0));
            return "B";
          }),
        ]);
        return { alpha, beta };
      },
    );

    const workflows = { PARALLEL_DO_SHORT_CIRCUIT: ParallelDoShortCircuitWorkflow };

    const scenario = defineScenario({
      name: "parallel-do-short-circuit-steps",
      workflows,
      steps: ({ workflow, runner }) => [
        workflow.create({
          workflow: "PARALLEL_DO_SHORT_CIRCUIT",
          id: "parallel-do-short-circuit-1",
        }),
        runner.tick({
          workflow: "PARALLEL_DO_SHORT_CIRCUIT",
          instanceId: "parallel-do-short-circuit-1",
          reason: "create",
        }),
        workflow.read({
          read: (ctx) =>
            ctx.state.getStatus("PARALLEL_DO_SHORT_CIRCUIT", "parallel-do-short-circuit-1"),
          assert: (status) => {
            expect(status.status).toBe("waiting");
          },
        }),
        workflow.read({
          read: (ctx) =>
            ctx.state.getSteps("PARALLEL_DO_SHORT_CIRCUIT", "parallel-do-short-circuit-1"),
          assert: (steps) => {
            expect(steps).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  stepKey: "do:alpha",
                  status: "waiting",
                  attempts: 1,
                  result: null,
                }),
                expect.objectContaining({
                  stepKey: "do:beta",
                  status: "waiting",
                  attempts: 1,
                  result: null,
                }),
              ]),
            );
          },
        }),
        workflow.assert(() => {
          expect(alphaRuns).toBe(1);
          expect(betaRuns).toBe(1);
        }),
        runner.restart(),
        runner.retryAndRunUntilIdle({
          workflow: "PARALLEL_DO_SHORT_CIRCUIT",
          instanceId: "parallel-do-short-circuit-1",
        }),
        workflow.read({
          read: (ctx) =>
            ctx.state.getStatus("PARALLEL_DO_SHORT_CIRCUIT", "parallel-do-short-circuit-1"),
          assert: (status) => {
            expect(status).toMatchObject({
              status: "complete",
              output: { alpha: "A", beta: "B" },
            });
          },
        }),
        workflow.read({
          read: (ctx) =>
            ctx.state.getSteps("PARALLEL_DO_SHORT_CIRCUIT", "parallel-do-short-circuit-1"),
          assert: (steps) => {
            expect(steps).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  stepKey: "do:alpha",
                  status: "completed",
                  attempts: 2,
                  result: "A",
                }),
                expect.objectContaining({
                  stepKey: "do:beta",
                  status: "completed",
                  attempts: 2,
                  result: "B",
                }),
              ]),
            );
          },
        }),
        workflow.assert(() => {
          expect(alphaRuns).toBe(2);
          expect(betaRuns).toBe(2);
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("reuses a completed parallel do step after the runner restarts", async () => {
    let alphaRuns = 0;
    let betaRuns = 0;

    const ParallelRestartWorkflow = defineWorkflow(
      { name: "parallel-restart-workflow" },
      async (_event, step) => {
        const [alpha, beta] = await Promise.all([
          step.do("alpha", { retries: { limit: 1, delay: 0, backoff: "constant" } }, async () => {
            alphaRuns += 1;
            if (alphaRuns === 1) {
              await new Promise((resolve) => setTimeout(resolve, 0));
              throw new Error("RETRY_ALPHA");
            }
            return "A";
          }),
          step.do("beta", async () => {
            betaRuns += 1;
            return "B";
          }),
        ]);
        return { alpha, beta };
      },
    );

    const workflows = { PARALLEL_RESTART: ParallelRestartWorkflow };

    const scenario = defineScenario({
      name: "parallel-restart-steps",
      workflows,
      steps: ({ workflow, runner }) => [
        workflow.create({ workflow: "PARALLEL_RESTART", id: "parallel-restart-1" }),
        runner.tick({
          workflow: "PARALLEL_RESTART",
          instanceId: "parallel-restart-1",
          reason: "create",
        }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("PARALLEL_RESTART", "parallel-restart-1"),
          assert: (status) => {
            expect(status.status).toBe("waiting");
          },
        }),
        workflow.read({
          read: (ctx) => ctx.state.getSteps("PARALLEL_RESTART", "parallel-restart-1"),
          assert: (steps) => {
            expect(steps).toHaveLength(2);
            expect(steps).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  stepKey: "do:alpha",
                  parentStepKey: null,
                  depth: 0,
                  status: "waiting",
                  attempts: 1,
                }),
                expect.objectContaining({
                  stepKey: "do:beta",
                  parentStepKey: null,
                  depth: 0,
                  status: "completed",
                  result: "B",
                }),
              ]),
            );
          },
        }),
        workflow.assert(() => {
          expect(alphaRuns).toBe(1);
          expect(betaRuns).toBe(1);
        }),
        runner.restart(),
        runner.retryAndRunUntilIdle({
          workflow: "PARALLEL_RESTART",
          instanceId: "parallel-restart-1",
        }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("PARALLEL_RESTART", "parallel-restart-1"),
          assert: (status) => {
            expect(status).toMatchObject({
              status: "complete",
              output: { alpha: "A", beta: "B" },
            });
          },
        }),
        workflow.read({
          read: (ctx) => ctx.state.getSteps("PARALLEL_RESTART", "parallel-restart-1"),
          assert: (steps) => {
            expect(steps).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  stepKey: "do:alpha",
                  status: "completed",
                  attempts: 2,
                  result: "A",
                }),
                expect.objectContaining({
                  stepKey: "do:beta",
                  status: "completed",
                  attempts: 1,
                  result: "B",
                }),
              ]),
            );
          },
        }),
        workflow.assert(() => {
          expect(alphaRuns).toBe(2);
          expect(betaRuns).toBe(1);
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

    const scenario = defineScenario({
      name: "promise-race-step",
      workflows,
      steps: ({ workflow, runner }) => [
        runner.initializeAndRunUntilIdle({ workflow: "RACE", id: "race-1" }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("RACE", "race-1"),
          assert: (status) => {
            expect(status.status).toBe("complete");
            expect(status.output).toEqual({ raceReturn: "second", cached: "second" });
          },
        }),
        workflow.read({
          read: (ctx) => ctx.state.getSteps("RACE", "race-1"),
          assert: (steps) => {
            expect(steps).toHaveLength(5);
            expect(steps).toEqual(
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
          },
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

    const scenario = defineScenario({
      name: "promise-race-slow-step-event-wait",
      workflows,
      steps: ({ workflow, runner }) => [
        runner.initializeAndRunUntilIdle({ workflow: "RACE_EVENT", id: "race-event-1" }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("RACE_EVENT", "race-event-1"),
          assert: (status) => {
            expect(status.status).toBe("waiting");
          },
        }),
        runner.eventAndRunUntilIdle({
          workflow: "RACE_EVENT",
          instanceId: "race-event-1",
          event: { type: "ready" },
        }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("RACE_EVENT", "race-event-1"),
          assert: (status) => {
            expect(status).toMatchObject({
              status: "complete",
              output: { raceReturn: "event", cached: "event" },
            });
          },
        }),
        workflow.read({
          read: (ctx) => ctx.state.getSteps("RACE_EVENT", "race-event-1"),
          assert: (steps) => {
            expect(steps).toHaveLength(5);
            expect(steps).toEqual(
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
          },
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

    const scenario = defineScenario({
      name: "promise-any-step",
      workflows,
      steps: ({ workflow, runner }) => [
        runner.initializeAndRunUntilIdle({ workflow: "ANY", id: "any-1" }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("ANY", "any-1"),
          assert: (status) => {
            expect(status.status).toBe("complete");
            expect(status.output).toEqual({ anyReturn: "second" });
          },
        }),
        workflow.read({
          read: (ctx) => ctx.state.getSteps("ANY", "any-1"),
          assert: (steps) => {
            expect(steps.map((step) => step.stepKey)).toEqual(
              expect.arrayContaining([
                "do:Promise any",
                "do:Promise any>do:Promise any first",
                "do:Promise any>do:Promise any second",
                "do:Promise any>do:Promise any first>sleep:Promise any first delay",
              ]),
            );
            expect(steps).toHaveLength(4);
          },
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("can resume a waiting workflow after restarting the runner runtime", async () => {
    const RestartWorkflow = defineWorkflow(
      { name: "scenario-restart-runner" },
      async (_event, step) => {
        await step.waitForEvent("ready", { type: "ready" });
        return await step.do("finish", async () => "done");
      },
    );

    const workflows = { RESTART: RestartWorkflow };

    const scenario = defineScenario({
      name: "scenario-restart-runner",
      workflows,
      steps: ({ workflow, runner }) => [
        runner.initializeAndRunUntilIdle({ workflow: "RESTART", id: "restart-1" }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("RESTART", "restart-1"),
          assert: (status) => {
            expect(status?.status).toBe("waiting");
          },
        }),
        runner.restart(),
        runner.eventAndRunUntilIdle({
          workflow: "RESTART",
          instanceId: "restart-1",
          event: { type: "ready" },
        }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("RESTART", "restart-1"),
          assert: (status) => {
            expect(status).toMatchObject({ status: "complete", output: "done" });
          },
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

    const scenario = defineScenario<
      typeof workflows,
      { createTick?: number; eventTick?: number },
      undefined,
      Record<string, never>,
      ["create", "event"]
    >({
      name: "scenario-race-event-second-runner-wins",
      workflows,
      runners: ["create", "event"],
      harness: { runtime },
      steps: ({ workflow, runners, concurrent }) => [
        workflow.create({ workflow: "RACE", id: "race-runner-1" }),
        concurrent({
          create: [
            runners.create.tick({
              workflow: "RACE",
              instanceId: "race-runner-1",
              reason: "create",
              storeAs: "createTick",
            }),
          ],
          event: [
            runners.event.waitForControl({ key: "sleep:started" }),
            workflow.event({
              workflow: "RACE",
              instanceId: "race-runner-1",
              event: { type: "ready" },
            }),
            runners.event.tick({
              workflow: "RACE",
              instanceId: "race-runner-1",
              reason: "event",
              storeAs: "eventTick",
            }),
          ],
        }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("RACE", "race-runner-1"),
          assert: (status) => {
            expect(status).toMatchObject({
              status: "complete",
              output: { raceReturn: "event", cached: "event" },
            });
          },
        }),
        workflow.read({
          read: (ctx) => ctx.state.getSteps("RACE", "race-runner-1"),
          assert: (steps) => {
            expect(steps).toMatchObject([
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
          },
        }),
        workflow.read({
          read: (ctx) => ctx.state.getEvents("RACE", "race-runner-1"),
          assert: (events) => {
            expect(events).toHaveLength(1);
            expect(events?.[0]).toMatchObject({
              type: "ready",
              consumedByStepKey: "do:Promise race>waitForEvent:event branch",
            });
          },
        }),
        workflow.assert((ctx) => {
          expect(ctx.vars.createTick).toBe(1);
          expect(ctx.vars.eventTick).toBe(1);
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
      finalRun?: { processed: number; ticks: number };
    };

    const scenario = defineScenario<
      typeof workflows,
      ScenarioVars,
      undefined,
      Record<string, never>,
      ["create", "event"]
    >({
      name: "scenario-event-before-wait-persisted-enqueues",
      workflows,
      runners: ["create", "event"],
      harness: { runtime },
      steps: ({ workflow, runners, concurrent }) => [
        workflow.create({ workflow: "EARLY_EVENT", id: "early-event-1" }),
        concurrent({
          create: [
            runners.create.tick({
              workflow: "EARLY_EVENT",
              instanceId: "early-event-1",
              reason: "create",
              storeAs: "createTick",
            }),
            runners.create.resolveControl({ key: "create:tick:done" }),
          ],
          event: [
            runners.event.waitForControl({ key: "slow:started" }),
            workflow.event({
              workflow: "EARLY_EVENT",
              instanceId: "early-event-1",
              event: { type: "ready" },
              storeAs: "eventStatus",
            }),
            runners.event.waitForControl({ key: "create:tick:done" }),
            workflow.read({
              read: (ctx) => ctx.state.getStatus("EARLY_EVENT", "early-event-1"),
              assert: (status) => {
                expect(status.status).toBe("waiting");
              },
            }),
            workflow.read({
              read: (ctx) => ctx.state.getEvents("EARLY_EVENT", "early-event-1"),
              assert: (events) => {
                expect(events).toHaveLength(1);
                expect(events?.[0]).toMatchObject({
                  type: "ready",
                  consumedByStepKey: null,
                  deliveredAt: null,
                });
              },
            }),
            workflow.read({
              read: (ctx) =>
                ctx.state.internal.getHooks({
                  hookName: "onWorkflowEnqueued",
                  workflowName: "scenario-event-before-wait-persisted",
                  instanceId: "early-event-1",
                }),
              assert: (hooks) => {
                expect(hooks).toEqual(
                  expect.arrayContaining([
                    expect.objectContaining({
                      hookName: "onWorkflowEnqueued",
                      status: "pending",
                      payload: expect.objectContaining({ reason: "event" }),
                    }),
                  ]),
                );
              },
            }),
            runners.event.runUntilIdle({
              workflow: "EARLY_EVENT",
              instanceId: "early-event-1",
              reason: "event",
              storeAs: "finalRun",
            }),
          ],
        }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("EARLY_EVENT", "early-event-1"),
          assert: (status) => {
            expect(status).toMatchObject({ status: "complete", output: "done" });
          },
        }),
        workflow.read({
          read: (ctx) => ctx.state.getEvents("EARLY_EVENT", "early-event-1"),
          assert: (events) => {
            expect(events?.[0]).toMatchObject({
              type: "ready",
              consumedByStepKey: "waitForEvent:ready",
            });
          },
        }),
        workflow.assert((ctx) => {
          expect(ctx.vars.eventStatus?.status).toBe("active");
          expect(ctx.vars.createTick).toBe(1);
          expect(ctx.vars.finalRun).toEqual({ processed: 1, ticks: 2 });
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

    const scenario = defineScenario({
      name: "scenario-stale-runner-occ",
      workflows,
      vars() {
        return {
          firstTick: 0,
          secondTick: 0,
        };
      },
      runners: ["first", "second"],
      harness: { runtime },
      steps: ({ workflow, runners, concurrent }) => [
        workflow.create({ workflow: "OCC", id: "occ-1" }),
        concurrent({
          first: [
            runners.first.tick({
              workflow: "OCC",
              instanceId: "occ-1",
              reason: "create",
              storeAs: "firstTick",
            }),
          ],
          second: [
            runners.second.waitForControl({ key: "first:started" }),
            runners.second.tick({
              workflow: "OCC",
              instanceId: "occ-1",
              reason: "create",
              storeAs: "secondTick",
            }),
            runners.second.resolveControl({ key: "first:release" }),
          ],
        }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("OCC", "occ-1"),
          assert: (status) => {
            expect(status).toMatchObject({
              status: "complete",
              output: { value: "committed" },
            });
          },
        }),
        workflow.read({
          read: (ctx) => ctx.state.getSteps("OCC", "occ-1"),
          assert: (steps) => {
            expect(steps).toHaveLength(1);
            expect(steps?.[0]).toMatchObject({
              stepKey: "do:racy work",
              status: "completed",
              result: "committed",
            });
          },
        }),
        workflow.assert((ctx) => {
          expect(ctx.vars.firstTick).toBe(0);
          expect(ctx.vars.secondTick).toBe(1);
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("concurrent clients attached to separate runners observe their runner's racy step emissions", async () => {
    const runtime = createWorkflowsTestRuntime();
    let invocationCount = 0;

    const ClientEmissionWorkflow = defineWorkflow(
      { name: "scenario-client-runner-emission-race" },
      async (_event, step) => {
        const value = await step.do("racy client message", async (tx) => {
          invocationCount += 1;
          const runner = invocationCount === 1 ? "first" : "second";
          tx.emit({ runner, message: `${runner}:started` });

          runtime.controls.resolve(`${runner}:started`);
          await runtime.controls.wait(`${runner}:release`);

          tx.emit({ runner, message: `${runner}:finished` });
          return runner;
        });

        const shared = await step.do("shared client message", async (tx) => {
          tx.emit({ runner: value, message: "shared:started" });
          runtime.controls.resolve("shared:started");
          await runtime.controls.wait("shared:release");
          tx.emit({ runner: value, message: "shared:finished" });
          return "shared";
        });

        return { value, shared };
      },
    );

    const workflows = { CLIENT_EMIT: ClientEmissionWorkflow };

    const hasPayloadMessage = (
      messages: readonly { payload: unknown }[] | undefined,
      runner: string,
      message: string,
    ) =>
      Boolean(
        messages?.some(
          (entry) =>
            typeof entry.payload === "object" &&
            entry.payload !== null &&
            "runner" in entry.payload &&
            "message" in entry.payload &&
            entry.payload.runner === runner &&
            entry.payload.message === message,
        ),
      );

    const hasStepControl = (
      messages: readonly { stepKey: string; payload: unknown }[] | undefined,
      stepKey: string,
      control: string,
    ) =>
      Boolean(
        messages?.some(
          (entry) =>
            entry.stepKey === stepKey &&
            typeof entry.payload === "object" &&
            entry.payload !== null &&
            "control" in entry.payload &&
            entry.payload.control === control,
        ),
      );

    const scenario = defineScenario({
      name: "scenario-client-runner-emission-race",
      workflows,
      vars() {
        return {
          firstMessages: undefined as unknown,
          secondMessages: undefined as unknown,
          firstSharedMessages: undefined as unknown,
          secondSharedMessages: undefined as unknown,
          firstCommittedMessages: undefined as unknown,
          secondCommittedMessages: undefined as unknown,
        };
      },
      runners: ["first", "second", "observer"],
      harness: { runtime },
      clients: ({ clientConfig }) => ({
        first: createWorkflowsClient(clientConfig("workflows", { runner: "first" })),
        second: createWorkflowsClient(clientConfig("workflows", { runner: "second" })),
      }),
      stores: ({ clients }) => ({
        firstInstance: () =>
          clients.first.useInstance({
            path: {
              workflowName: "scenario-client-runner-emission-race",
              instanceId: "client-emission-race-1",
            },
          }),
        secondInstance: () =>
          clients.second.useInstance({
            path: {
              workflowName: "scenario-client-runner-emission-race",
              instanceId: "client-emission-race-1",
            },
          }),
        firstCurrentStep: () =>
          clients.first.useCurrentStepEmissions({
            path: {
              workflowName: "scenario-client-runner-emission-race",
              instanceId: "client-emission-race-1",
            },
          }),
        secondCurrentStep: () =>
          clients.second.useCurrentStepEmissions({
            path: {
              workflowName: "scenario-client-runner-emission-race",
              instanceId: "client-emission-race-1",
            },
          }),
      }),
      steps: ({ workflow, runners, concurrent, stores }) => [
        workflow.create({ workflow: "CLIENT_EMIT", id: "client-emission-race-1" }),
        stores.firstInstance.waitFor(
          (state) => !state.loading && state.data?.id === "client-emission-race-1",
        ),
        stores.secondInstance.waitFor(
          (state) => !state.loading && state.data?.id === "client-emission-race-1",
        ),
        concurrent({
          first: [
            runners.first.tick({
              workflow: "CLIENT_EMIT",
              instanceId: "client-emission-race-1",
              reason: "create",
            }),
          ],
          second: [
            runners.second.waitForControl({ key: "first:started" }),
            runners.second.tick({
              workflow: "CLIENT_EMIT",
              instanceId: "client-emission-race-1",
              reason: "create",
            }),
          ],
          observer: [
            runners.observer.waitForControl({ key: "first:started" }),
            runners.observer.waitForControl({ key: "second:started" }),
            stores.firstCurrentStep.waitFor(
              (state) => !state.loading && hasPayloadMessage(state.data, "first", "first:started"),
              {
                storeAs: "firstMessages",
                select: (state) => state.data,
              },
            ),
            stores.secondCurrentStep.waitFor(
              (state) =>
                !state.loading && hasPayloadMessage(state.data, "second", "second:started"),
              {
                storeAs: "secondMessages",
                select: (state) => state.data,
              },
            ),
            runners.observer.resolveControl({ key: "second:release" }),
            runners.observer.waitForControl({ key: "shared:started" }),
            workflow.read({
              read: (ctx) => ctx.state.getEmissions("CLIENT_EMIT", "client-emission-race-1"),
              assert: (emissions) => {
                expect(emissions).toEqual(
                  expect.arrayContaining([
                    expect.objectContaining({
                      stepKey: "do:racy client message",
                      payload: { runner: "second", message: "second:finished" },
                    }),
                  ]),
                );
                expect(emissions).not.toEqual(
                  expect.arrayContaining([
                    expect.objectContaining({
                      stepKey: "do:shared client message",
                    }),
                  ]),
                );
              },
            }),
            stores.firstCurrentStep.waitFor(
              (state) =>
                !state.loading &&
                hasStepControl(state.data, "do:shared client message", "step-started") &&
                hasPayloadMessage(state.data, "second", "shared:started"),
              {
                storeAs: "firstSharedMessages",
                select: (state) => state.data,
              },
            ),
            stores.secondCurrentStep.waitFor(
              (state) =>
                !state.loading &&
                hasStepControl(state.data, "do:shared client message", "step-started") &&
                hasPayloadMessage(state.data, "second", "shared:started"),
              {
                storeAs: "secondSharedMessages",
                select: (state) => state.data,
              },
            ),
            workflow.assert((ctx) => {
              expect(ctx.vars.firstSharedMessages).toEqual(
                expect.arrayContaining([
                  expect.objectContaining({
                    stepKey: "do:racy client message",
                    payload: { runner: "first", message: "first:started" },
                  }),
                  expect.objectContaining({
                    stepKey: "do:shared client message",
                    actor: "system",
                    payload: { control: "step-started" },
                  }),
                  expect.objectContaining({
                    stepKey: "do:shared client message",
                    actor: "user",
                    payload: { runner: "second", message: "shared:started" },
                  }),
                ]),
              );
              expect(ctx.vars.secondSharedMessages).toEqual(
                expect.arrayContaining([
                  expect.objectContaining({
                    stepKey: "do:shared client message",
                    actor: "system",
                    payload: { control: "step-started" },
                  }),
                  expect.objectContaining({
                    stepKey: "do:shared client message",
                    actor: "user",
                    payload: { runner: "second", message: "shared:started" },
                  }),
                ]),
              );
            }),
            workflow.read({
              read: (ctx) => ctx.state.getEmissions("CLIENT_EMIT", "client-emission-race-1"),
              assert: (emissions) => {
                expect(emissions).toEqual(
                  expect.arrayContaining([
                    expect.objectContaining({
                      stepKey: "do:shared client message",
                      actor: "system",
                      payload: { control: "step-started" },
                    }),
                    expect.objectContaining({
                      stepKey: "do:shared client message",
                      actor: "user",
                      payload: { runner: "second", message: "shared:started" },
                    }),
                  ]),
                );
              },
            }),
            runners.observer.resolveControl({ key: "shared:release" }),
            runners.observer.resolveControl({ key: "first:release" }),
          ],
        }),
        stores.firstCurrentStep.waitFor(
          (state) =>
            !state.loading &&
            hasStepControl(state.data, "do:racy client message", "step-committed"),
          {
            storeAs: "firstCommittedMessages",
            select: (state) => state.data,
          },
        ),
        stores.secondCurrentStep.waitFor(
          (state) =>
            !state.loading &&
            hasStepControl(state.data, "do:racy client message", "step-committed"),
          {
            storeAs: "secondCommittedMessages",
            select: (state) => state.data,
          },
        ),
        workflow.assert((ctx) => {
          expect(ctx.vars.firstCommittedMessages).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                stepKey: "do:racy client message",
                actor: "system",
                payload: expect.objectContaining({ control: "step-committed" }),
              }),
            ]),
          );
          expect(ctx.vars.firstCommittedMessages).not.toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                stepKey: "do:racy client message",
                payload: { runner: "first", message: "first:started" },
              }),
            ]),
          );
          expect(ctx.vars.secondCommittedMessages).not.toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                stepKey: "do:racy client message",
                payload: { runner: "first", message: "first:started" },
              }),
            ]),
          );
        }),

        workflow.read({
          read: (ctx) => ctx.state.getSteps("CLIENT_EMIT", "client-emission-race-1"),
          assert: (steps) => {
            expect(steps).toHaveLength(2);
            expect(steps).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  stepKey: "do:racy client message",
                  status: "completed",
                  result: "second",
                }),
                expect.objectContaining({
                  stepKey: "do:shared client message",
                  status: "completed",
                  result: "shared",
                }),
              ]),
            );
          },
        }),
        workflow.assert((ctx) => {
          expect(invocationCount).toBe(2);
          expect(ctx.vars.firstMessages).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                payload: { runner: "first", message: "first:started" },
              }),
            ]),
          );
          expect(ctx.vars.secondMessages).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                payload: { runner: "second", message: "second:started" },
              }),
            ]),
          );
          expect(ctx.vars.firstMessages).not.toEqual(
            expect.arrayContaining([expect.objectContaining({ payload: { runner: "second" } })]),
          );
          expect(ctx.vars.secondMessages).not.toEqual(
            expect.arrayContaining([expect.objectContaining({ payload: { runner: "first" } })]),
          );
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

    const scenario = defineScenario<
      typeof workflows,
      {
        restartedRunnerTick?: number;
        eventRunnerRun?: { processed: number; ticks: number };
      },
      undefined,
      Record<string, never>,
      ["restarted", "active"]
    >({
      name: "scenario-independent-runners",
      workflows,
      runners: ["restarted", "active"],
      steps: ({ workflow, runners, concurrent }) => [
        runners.active.initializeAndRunUntilIdle({ workflow: "RUNNER", id: "runner-1" }),
        concurrent({
          restarted: [
            runners.restarted.restart(),
            runners.restarted.tick({
              workflow: "RUNNER",
              instanceId: "runner-1",
              reason: "event",
              storeAs: "restartedRunnerTick",
            }),
          ],
          active: [
            runners.active.eventAndRunUntilIdle({
              workflow: "RUNNER",
              instanceId: "runner-1",
              event: { type: "ready" },
              runStoreAs: "eventRunnerRun",
            }),
          ],
        }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("RUNNER", "runner-1"),
          assert: (status) => {
            expect(status).toMatchObject({ status: "complete", output: "done" });
          },
        }),
        workflow.assert((ctx) => {
          expect(
            (ctx.vars.restartedRunnerTick ?? 0) + (ctx.vars.eventRunnerRun?.processed ?? 0),
          ).toBeGreaterThan(0);
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("can resume a sleeping workflow after restarting the runner runtime", async () => {
    const SleepWorkflow = defineWorkflow(
      { name: "scenario-restart-sleep" },
      async (_event, step) => {
        await step.sleep("pause", 1000);
        return "awake";
      },
    );

    const workflows = { SLEEP: SleepWorkflow };

    const scenario = defineScenario({
      name: "scenario-restart-sleep",
      workflows,
      steps: ({ workflow, runner }) => [
        runner.initializeAndRunUntilIdle({ workflow: "SLEEP", id: "sleep-kill-1" }),
        runner.restart(),
        runner.advanceTimeAndRunUntilIdle({
          workflow: "SLEEP",
          instanceId: "sleep-kill-1",
          advanceBy: 1000,
        }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("SLEEP", "sleep-kill-1"),
          assert: (status) => {
            expect(status).toMatchObject({ status: "complete", output: "awake" });
          },
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("restart recreates the workflow fragment runtime", async () => {
    const RestartWorkflow = defineWorkflow({ name: "scenario-restart-runtime" }, async () => "ok");

    const workflows = { RESTART: RestartWorkflow };

    const scenario = defineScenario({
      name: "scenario-restart-runtime",
      workflows,
      steps: ({ workflow }) => [
        workflow.read({
          read: (ctx) => ctx.harness.fragment,
          assert: (fragmentBeforeRestart, _ctx) => {
            void _ctx;
            expect(fragmentBeforeRestart).toBeTruthy();
          },
        }),
        workflow.read({
          read: async (ctx) => {
            const fragmentBeforeRestart = ctx.harness.fragment;
            await ctx.harness.restart();
            return ctx.harness.fragment !== fragmentBeforeRestart;
          },
          assert: (fragmentWasRecreated) => {
            expect(fragmentWasRecreated).toBe(true);
          },
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
    };

    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "scenario-step-emission-wait",
      workflows,
      steps: ({ workflow, runner }) => [
        runner.initializeAndRunUntilIdle({ workflow: "EMIT_WAIT", id: "emit-wait-1" }),
        workflow.read({
          read: (ctx) => ctx.state.getEmissions("EMIT_WAIT", "emit-wait-1"),
          assert: (emissionsAfterSuspend) => {
            expect(emissionsAfterSuspend).toEqual(
              expect.arrayContaining([
                expect.objectContaining({ actor: "system", stepKey: "do:approval" }),
                expect.objectContaining({
                  actor: "user",
                  stepKey: "do:approval",
                  payload: { phase: "waiting", approved: false },
                }),
              ]),
            );
          },
        }),
        runner.eventAndRunUntilIdle({
          workflow: "EMIT_WAIT",
          instanceId: "emit-wait-1",
          event: { type: "ready" },
        }),
        runner.drainHooks(),
        workflow.read({
          read: (ctx) => ctx.state.getEmissions("EMIT_WAIT", "emit-wait-1"),
          assert: (emissionsAfterComplete) => {
            expect(emissionsAfterComplete).toEqual([]);
          },
        }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("EMIT_WAIT", "emit-wait-1"),
          assert: (status) => {
            expect(status).toMatchObject({ status: "complete", output: "done" });
          },
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("concurrent event ticks for one waiting instance do not terminal-error the workflow", async () => {
    const runtime = createWorkflowsTestRuntime();
    let consumeCount = 0;

    const ConcurrentEventTickWorkflow = defineWorkflow(
      { name: "scenario-concurrent-event-ticks" },
      async (_event, step) => {
        const ready = await step.waitForEvent<{ ok: true }>("ready", {
          type: "ready",
          onConsume: async () => {
            consumeCount += 1;
            runtime.controls.resolve(`consume:${consumeCount}:started`);
            if (consumeCount === 1) {
              await runtime.controls.wait("consume:first:release");
            }
          },
        });

        return { ready: ready.payload };
      },
    );

    const workflows = { CONCURRENT_EVENT_TICK: ConcurrentEventTickWorkflow };
    type ScenarioVars = {
      tickResults?: PromiseSettledResult<number>[];
    };

    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "scenario-concurrent-event-ticks",
      workflows,
      harness: {
        runtime,
        fragmentConfig: {
          stepEmissions: new BufferedPumpRegistry<WorkflowStepLivePump>(),
        },
      },
      steps: ({ workflow, runner }) => [
        runner.initializeAndRunUntilIdle({
          workflow: "CONCURRENT_EVENT_TICK",
          id: "concurrent-event-tick-1",
        }),
        workflow.event({
          workflow: "CONCURRENT_EVENT_TICK",
          instanceId: "concurrent-event-tick-1",
          event: { type: "ready", payload: { ok: true } },
        }),
        workflow.read({
          read: async (ctx) => {
            const workflowName = "scenario-concurrent-event-ticks";
            const rows = (
              await ctx.harness.db
                .createUnitOfWork("concurrent-event-tick-instance")
                .forSchema(workflowsSchema)
                .find("workflow_instance", (b) =>
                  b.whereIndex("idx_workflow_instance_workflowName_id", (eb) =>
                    eb.and(
                      eb("workflowName", "=", workflowName),
                      eb("id", "=", "concurrent-event-tick-1"),
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
              instanceRef: String(instance.id),
              reason: "event",
            } as const;

            const first = ctx.harness.createRunner().tick(payload);
            await runtime.controls.wait("consume:1:started");

            const second = ctx.harness.createRunner().tick(payload);
            await new Promise((resolve) => setTimeout(resolve, 10));

            runtime.controls.resolve("consume:first:release");
            return await Promise.allSettled([first, second]);
          },
          storeAs: "tickResults",
        }),
        workflow.assert((ctx) => {
          const tickResults = ctx.vars.tickResults ?? [];
          expect(tickResults.every((result) => result.status === "fulfilled")).toBe(true);
          expect(
            tickResults
              .map((result) => (result.status === "fulfilled" ? result.value : -1))
              .sort((a, b) => a - b),
          ).toEqual([0, 1]);
        }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("CONCURRENT_EVENT_TICK", "concurrent-event-tick-1"),
          assert: (status) => {
            expect(status).toMatchObject({
              status: "complete",
              output: { ready: { ok: true } },
            });
          },
        }),
        workflow.read({
          read: (ctx) => ctx.state.getEvents("CONCURRENT_EVENT_TICK", "concurrent-event-tick-1"),
          assert: (events) => {
            expect(events).toEqual([
              expect.objectContaining({
                type: "ready",
                consumedByStepKey: "waitForEvent:ready",
              }),
            ]);
          },
        }),
        workflow.assert(() => {
          expect(consumeCount).toBe(1);
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
      emissionsWhileBothStarted?: unknown[];
    };

    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "scenario-concurrent-step-emissions",
      workflows,
      harness: { runtime },
      steps: ({ workflow }) => [
        workflow.create({ workflow: "CONCURRENT_EMIT", id: "concurrent-emit-1" }),
        workflow.read({
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
          assert: (ticks) => {
            expect(ticks).toEqual([0, 1]);
          },
        }),
        workflow.read({
          read: (ctx) => ctx.state.getEmissions("CONCURRENT_EMIT", "concurrent-emit-1"),
          assert: (emissionsAfterRace) => {
            expect(emissionsAfterRace).toEqual(
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
            const outEmissions = emissionsAfterRace.filter(
              (emission) => (emission as { actor?: string }).actor === "user",
            );
            const epochsByAttempt = new Map<number, Set<string>>();
            for (const emission of outEmissions) {
              const { epoch, payload } = emission as {
                epoch: string;
                payload: { attempt: number };
              };
              const epochs = epochsByAttempt.get(payload.attempt) ?? new Set<string>();
              epochs.add(epoch);
              epochsByAttempt.set(payload.attempt, epochs);
            }

            expect(epochsByAttempt.get(1)?.size).toBe(1);
            expect(epochsByAttempt.get(2)?.size).toBe(1);
            expect(epochsByAttempt.get(1)).not.toEqual(epochsByAttempt.get(2));
          },
        }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("CONCURRENT_EMIT", "concurrent-emit-1"),
          assert: (status) => {
            expect(status).toMatchObject({
              status: "complete",
              output: { value: "attempt-2" },
            });
          },
        }),
        workflow.assert((ctx) => {
          expect(invocationCount).toBe(2);
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
          expect(producedEmissions).toEqual(
            expect.arrayContaining([
              { attempt: 1, phase: "started" },
              { attempt: 1, phase: "finished" },
              { attempt: 2, phase: "started" },
              { attempt: 2, phase: "finished" },
            ]),
          );
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
    };

    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "scenario-step-emission-replay",
      workflows,
      steps: ({ workflow, runner }) => [
        runner.initializeAndRunUntilIdle({ workflow: "STEP_REPLAY", id: "step-replay-1" }),
        runner.drainHooks(),
        workflow.read({
          read: (ctx) => ctx.state.getEmissions("STEP_REPLAY", "step-replay-1"),
          assert: (emissionsAfterFirstRun) => {
            expect(emissionsAfterFirstRun).toEqual([]);
          },
        }),
        runner.restart(),
        runner.eventAndRunUntilIdle({
          workflow: "STEP_REPLAY",
          instanceId: "step-replay-1",
          event: { type: "ready" },
        }),
        runner.drainHooks(),
        workflow.read({
          read: (ctx) => ctx.state.getEmissions("STEP_REPLAY", "step-replay-1"),
          assert: (emissionsAfterRestart) => {
            expect(emissionsAfterRestart).toEqual([]);
          },
        }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("STEP_REPLAY", "step-replay-1"),
          assert: (status) => {
            expect(status).toMatchObject({ status: "complete", output: "done" });
          },
        }),
        workflow.assert(() => {
          expect(publishExecutions).toBe(1);
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
    const scenario = defineScenario<typeof workflows, { messages?: unknown[] }>({
      name: "scenario-step-emission-error",
      workflows,
      steps: ({ workflow, runner }) => [
        runner.initializeAndRunUntilIdle({ workflow: "ERROR", id: "error-1" }),
        runner.drainHooks(),
        workflow.read({
          read: (ctx) => ctx.state.getEmissions("ERROR", "error-1"),
          assert: (emissionsAfterError) => {
            expect(emissionsAfterError).toEqual([]);
          },
        }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("ERROR", "error-1"),
          assert: (status) => {
            expect(status).toMatchObject({
              status: "errored",
              error: { name: "Error", message: "boom" },
            });
          },
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
    const scenario = defineScenario<typeof workflows, { messages?: unknown[] }>({
      name: "scenario-step-emission-retry",
      workflows,
      steps: ({ workflow, runner }) => [
        runner.initializeAndRunUntilIdle({ workflow: "RETRY", id: "retry-1" }),
        runner.drainHooks(),
        workflow.read({
          read: (ctx) => ctx.state.getEmissions("RETRY", "retry-1"),
          assert: (emissionsAfterRetrySuspend) => {
            expect(emissionsAfterRetrySuspend).toEqual([]);
          },
        }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("RETRY", "retry-1"),
          assert: (status) => {
            expect(status?.status).toBe("waiting");
          },
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

    const scenario = defineScenario<
      typeof workflows,
      { status?: { status: string; output?: { value: boolean } } }
    >({
      name: "scenario-controls",
      workflows,
      harness: { runtime },
      steps: ({ workflow, runner }) => [
        runner.initializeAndRunUntilIdle({ workflow: "CONTROL", id: "control-1" }),
        workflow.read({
          read: (ctx) => ctx.runtime.controls.get("control:ready"),
          assert: (control) => {
            expect(control).toMatchObject({
              key: "control:ready",
              status: "pending",
              pendingCount: 0,
            });
          },
        }),
        runner.resolveControl({ key: "control:ready", value: false }),
        runner.eventAndRunUntilIdle({
          workflow: "CONTROL",
          instanceId: "control-1",
          event: { type: "ready" },
        }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("CONTROL", "control-1"),
          assert: (status) => {
            expect(status).toMatchObject({
              status: "complete",
              output: { value: false },
            });
          },
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
    };

    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "fetch-step",
      workflows,
      steps: ({ workflow, runner }) => [
        runner.initializeAndRunUntilIdle({ workflow: "FETCH", id: "fetch-1" }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("FETCH", "fetch-1"),
          assert: (status) => {
            expect(status?.status).toBe("complete");
            expect(status?.output).toEqual({
              status: 200,
              json: { ok: true, source: "fake" },
            });
          },
        }),
        workflow.read({
          read: (ctx) => ctx.state.getSteps("FETCH", "fetch-1"),
          assert: (steps) => {
            expect(steps).toHaveLength(1);
            expect(steps?.[0]).toMatchObject({
              name: "fetch",
              type: "do",
              status: "completed",
              stepKey: "do:fetch",
            });
          },
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

    const scenario = defineScenario({
      name: "wait-for-event",
      workflows,
      steps: ({ workflow, runner }) => [
        runner.initializeAndRunUntilIdle({ workflow: "WAIT", id: "wait-1" }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("WAIT", "wait-1"),
          assert: (waitingStatus) => {
            expect(waitingStatus?.status).toBe("waiting");
          },
        }),
        workflow.read({
          read: (ctx) => ctx.state.getSteps("WAIT", "wait-1"),
          assert: (steps) => {
            expect(steps?.[0]).toMatchObject({
              stepKey: "waitForEvent:ready",
              status: "waiting",
            });
          },
        }),
        runner.eventAndRunUntilIdle({
          workflow: "WAIT",
          instanceId: "wait-1",
          event: { type: "ready", payload: { ok: true } },
        }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("WAIT", "wait-1"),
          assert: (finalStatus) => {
            expect(finalStatus?.status).toBe("complete");
            expect(finalStatus?.output).toEqual({ ok: true });
          },
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

    const scenario = defineScenario({
      name: "sleep-waiting",
      workflows,
      steps: ({ workflow, runner }) => [
        runner.initializeAndRunUntilIdle({ workflow: "SLEEP", id: "sleep-1" }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("SLEEP", "sleep-1"),
          assert: (status) => {
            expect(status?.status).toBe("waiting");
          },
        }),
        workflow.read({
          read: (ctx) => ctx.state.getSteps("SLEEP", "sleep-1"),
          assert: (steps) => {
            expect(steps?.[0]).toMatchObject({
              stepKey: "sleep:nap",
              status: "waiting",
            });
            expect(steps?.[0].wakeAt).toBeInstanceOf(Date);
          },
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
    const scenario = defineScenario({
      name: "sleep-wake",
      workflows,
      steps: ({ workflow, runner }) => [
        runner.initializeAndRunUntilIdle({ workflow: "SLEEP_WAKE", id: "sleep-wake-1" }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("SLEEP_WAKE", "sleep-wake-1"),
          assert: (waiting) => {
            expect(waiting?.status).toBe("waiting");
          },
        }),
        runner.advanceTimeAndRunUntilIdle({
          workflow: "SLEEP_WAKE",
          instanceId: "sleep-wake-1",
          advanceBy: "10 minutes",
        }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("SLEEP_WAKE", "sleep-wake-1"),
          assert: (finalStatus) => {
            expect(finalStatus?.status).toBe("complete");
            expect(finalStatus?.output).toEqual({ done: true });
          },
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
      firstWakeAt?: Date;
    };

    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "sequential-sleep-wake",
      workflows,
      steps: ({ workflow, runner }) => [
        workflow.create({ workflow: "SEQUENTIAL_SLEEP", id: "sequential-sleep-1" }),
        runner.tick({
          workflow: "SEQUENTIAL_SLEEP",
          instanceId: "sequential-sleep-1",
          reason: "create",
        }),
        workflow.read({
          read: async (ctx) => {
            const steps = await ctx.state.getSteps("SEQUENTIAL_SLEEP", "sequential-sleep-1");
            return steps.find((step) => step.stepKey === "sleep:first")?.wakeAt ?? null;
          },
          storeAs: "firstWakeAt",
        }),
        runner.tick({
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
        workflow.read({
          read: (ctx) => ctx.state.getStatus("SEQUENTIAL_SLEEP", "sequential-sleep-1"),
          assert: (afterWakeStatus) => {
            expect(afterWakeStatus?.status).toBe("waiting");
          },
        }),
        workflow.read({
          read: (ctx) => ctx.state.getSteps("SEQUENTIAL_SLEEP", "sequential-sleep-1"),
          assert: (steps) => {
            const firstStep = steps.find((step) => step.stepKey === "sleep:first");
            const secondStep = steps.find((step) => step.stepKey === "sleep:second");

            expect(firstStep).toMatchObject({ status: "completed" });
            expect(secondStep).toMatchObject({ status: "waiting" });
            expect(secondStep?.wakeAt).toBeInstanceOf(Date);
          },
        }),
        workflow.assert((ctx) => {
          expect(ctx.vars.firstWakeAt).toBeInstanceOf(Date);
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

    const scenario = defineScenario<typeof workflows, Record<string, never>>({
      name: "sleep-early-wake",
      workflows,
      steps: ({ workflow, runner }) => [
        workflow.create({ workflow: "SLEEP_EARLY", id: "sleep-early-1" }),
        runner.tick({
          workflow: "SLEEP_EARLY",
          instanceId: "sleep-early-1",
          reason: "create",
        }),
        // After the first tick the workflow is waiting with a persisted wakeAt.
        workflow.read({
          read: (ctx) => ctx.state.getStatus("SLEEP_EARLY", "sleep-early-1"),
          assert: (waiting) => {
            expect(waiting?.status).toBe("waiting");
          },
        }),
        workflow.read({
          read: async (ctx) => {
            const waitingSteps = await ctx.state.getSteps("SLEEP_EARLY", "sleep-early-1");
            return waitingSteps[0]?.wakeAt ?? null;
          },
          assert: (wakeAt) => {
            expect(wakeAt).toBeInstanceOf(Date);
          },
        }),
        // Simulate an early wake hook (or duplicate hook) firing before wakeAt.
        // The runner should suspend again and keep the step waiting.
        runner.tick({
          workflow: "SLEEP_EARLY",
          instanceId: "sleep-early-1",
          reason: "wake",
        }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("SLEEP_EARLY", "sleep-early-1"),
          assert: (afterWake) => {
            expect(afterWake?.status).toBe("waiting");
          },
        }),
        workflow.read({
          read: (ctx) => ctx.state.getSteps("SLEEP_EARLY", "sleep-early-1"),
          assert: (afterSteps) => {
            expect(afterSteps?.[0]).toMatchObject({
              stepKey: "sleep:nap",
              status: "waiting",
            });
          },
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
      firstWakeAt?: Date;
    };

    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "sleep-replay-no-reschedule",
      workflows,
      steps: ({ workflow, runner }) => [
        workflow.create({ workflow: "SLEEP_REPLAY", id: "sleep-replay-1" }),
        runner.tick({
          workflow: "SLEEP_REPLAY",
          instanceId: "sleep-replay-1",
          reason: "create",
        }),
        workflow.read({
          read: (ctx) => ctx.state.getSteps("SLEEP_REPLAY", "sleep-replay-1"),
          assert: (waitingSteps) => {
            expect(waitingSteps?.[0].wakeAt).toBeInstanceOf(Date);
          },
        }),
        workflow.read({
          read: async (ctx) => {
            const hooks = await ctx.state.internal.getHooks({
              hookName: "onWorkflowEnqueued",
              status: "pending",
              workflowName: "sleep-replay-workflow",
              instanceId: "sleep-replay-1",
            });
            const wakeHooks = hooks.filter((hook) => {
              const payload = hook.payload as { reason?: string };
              return payload.reason === "wake";
            });
            expect(wakeHooks).toHaveLength(1);
            return wakeHooks[0]?.nextRetryAt ?? undefined;
          },
          storeAs: "firstWakeAt",
        }),
        // Replay the run before wakeAt. We should NOT enqueue another wake hook.
        runner.tick({
          workflow: "SLEEP_REPLAY",
          instanceId: "sleep-replay-1",
          reason: "create",
        }),
        workflow.read({
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
          assert: (secondWakeHooks, ctx) => {
            expect(secondWakeHooks).toHaveLength(1);
            expect(secondWakeHooks[0]?.nextRetryAt?.getTime()).toBe(
              ctx.vars.firstWakeAt?.getTime(),
            );
          },
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

    const scenario = defineScenario<typeof workflows, Record<string, never>>({
      name: "sleep-until",
      workflows,
      steps: ({ workflow, runner }) => [
        workflow.read({
          read: (ctx) => {
            wakeAt = new Date(ctx.clock.now().getTime() + 5 * 60 * 1000);
            return wakeAt;
          },
          assert: (scheduledWakeAt) => {
            expect(scheduledWakeAt).toBeInstanceOf(Date);
          },
        }),
        runner.initializeAndRunUntilIdle({ workflow: "SLEEP_UNTIL", id: "sleep-until-1" }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("SLEEP_UNTIL", "sleep-until-1"),
          assert: (waiting) => {
            expect(waiting?.status).toBe("waiting");
          },
        }),
        workflow.read({
          read: (ctx) => ctx.state.getSteps("SLEEP_UNTIL", "sleep-until-1"),
          assert: (steps) => {
            expect(steps?.[0]).toMatchObject({
              stepKey: "sleep:alarm",
              status: "waiting",
            });
            expect(steps?.[0].wakeAt?.getTime()).toBe(wakeAt?.getTime());
          },
        }),
        runner.advanceTimeAndRunUntilIdle({
          workflow: "SLEEP_UNTIL",
          instanceId: "sleep-until-1",
          setTo: () => {
            if (!wakeAt) {
              throw new Error("MISSING_WAKE_AT");
            }
            return wakeAt;
          },
        }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("SLEEP_UNTIL", "sleep-until-1"),
          assert: (finalStatus) => {
            expect(finalStatus?.status).toBe("complete");
            expect(finalStatus?.output).toEqual({ done: true });
          },
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

    const scenario = defineScenario<typeof workflows, Record<string, never>>({
      name: "wait-timeout-early",
      workflows,
      steps: ({ workflow, runner }) => [
        workflow.create({ workflow: "TIMEOUT_EARLY", id: "timeout-early-1" }),
        runner.tick({
          workflow: "TIMEOUT_EARLY",
          instanceId: "timeout-early-1",
          reason: "create",
        }),
        // First tick should put the workflow into waiting state with a wakeAt timeout.
        workflow.read({
          read: (ctx) => ctx.state.getStatus("TIMEOUT_EARLY", "timeout-early-1"),
          assert: (waiting) => {
            expect(waiting?.status).toBe("waiting");
          },
        }),
        workflow.read({
          read: async (ctx) => {
            const waitingSteps = await ctx.state.getSteps("TIMEOUT_EARLY", "timeout-early-1");
            return waitingSteps[0] ?? null;
          },
          assert: (waitingStep) => {
            expect(waitingStep).toMatchObject({
              stepKey: "waitForEvent:ready",
              status: "waiting",
              waitEventType: "ready",
            });
            expect(waitingStep?.wakeAt).toBeInstanceOf(Date);
          },
        }),
        // Simulate a wake hook arriving early (before the timeout deadline).
        // The runner should keep waiting instead of timing out early.
        runner.tick({
          workflow: "TIMEOUT_EARLY",
          instanceId: "timeout-early-1",
          reason: "wake",
        }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("TIMEOUT_EARLY", "timeout-early-1"),
          assert: (afterWake) => {
            // If this fails, we are using the hook timestamp as "now" and timing out
            // without checking the persisted wakeAt deadline.
            expect(afterWake?.status).toBe("waiting");
          },
        }),
        workflow.read({
          read: (ctx) => ctx.state.getSteps("TIMEOUT_EARLY", "timeout-early-1"),
          assert: (afterSteps) => {
            expect(afterSteps?.[0]).toMatchObject({
              stepKey: "waitForEvent:ready",
              status: "waiting",
              waitEventType: "ready",
            });
          },
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
      wakeAt?: Date;
    };

    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "wait-timeout",
      workflows,
      steps: ({ workflow, runner }) => [
        runner.initializeAndRunUntilIdle({ workflow: "TIMEOUT", id: "timeout-1" }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("TIMEOUT", "timeout-1"),
          assert: (waiting) => {
            expect(waiting?.status).toBe("waiting");
          },
        }),
        workflow.read({
          read: async (ctx) => {
            const waitingSteps = await ctx.state.getSteps("TIMEOUT", "timeout-1");
            expect(waitingSteps?.[0]).toMatchObject({
              stepKey: "waitForEvent:ready",
              status: "waiting",
              waitEventType: "ready",
            });
            expect(waitingSteps?.[0].wakeAt).toBeInstanceOf(Date);
            return waitingSteps[0]?.wakeAt ?? null;
          },
          storeAs: "wakeAt",
        }),
        runner.advanceTimeAndRunUntilIdle({
          workflow: "TIMEOUT",
          instanceId: "timeout-1",
          setTo: (ctx) => new Date(ctx.vars.wakeAt!.getTime() + 1),
        }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("TIMEOUT", "timeout-1"),
          assert: (finalStatus) => {
            expect(finalStatus?.status).toBe("errored");
            expect(finalStatus?.error?.message).toBe("WAIT_FOR_EVENT_TIMEOUT");
          },
        }),
        workflow.read({
          read: (ctx) => ctx.state.getSteps("TIMEOUT", "timeout-1"),
          assert: (finalSteps) => {
            expect(finalSteps?.[0]).toMatchObject({
              stepKey: "waitForEvent:ready",
              status: "errored",
              errorMessage: "WAIT_FOR_EVENT_TIMEOUT",
            });
          },
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
      wakeAt?: Date;
    };

    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "wait-timeout-graceful",
      workflows,
      steps: ({ workflow, runner }) => [
        runner.initializeAndRunUntilIdle({ workflow: "GRACEFUL", id: "graceful-1" }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("GRACEFUL", "graceful-1"),
          assert: (waiting) => {
            expect(waiting?.status).toBe("waiting");
          },
        }),
        workflow.read({
          read: async (ctx) => {
            const waitingSteps = await ctx.state.getSteps("GRACEFUL", "graceful-1");
            return waitingSteps[0]?.wakeAt ?? null;
          },
          storeAs: "wakeAt",
        }),
        runner.advanceTimeAndRunUntilIdle({
          workflow: "GRACEFUL",
          instanceId: "graceful-1",
          setTo: (ctx) => new Date((ctx.vars.wakeAt as Date).getTime() + 1),
        }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("GRACEFUL", "graceful-1"),
          assert: (finalStatus) => {
            expect(finalStatus?.status).toBe("complete");
            expect(finalStatus?.output).toEqual({ ok: true, timedOut: true });
          },
        }),
        workflow.read({
          read: (ctx) => ctx.state.getSteps("GRACEFUL", "graceful-1"),
          assert: (finalSteps) => {
            expect(finalSteps?.[0]).toMatchObject({
              stepKey: "waitForEvent:ready",
              status: "errored",
              errorMessage: "WAIT_FOR_EVENT_TIMEOUT",
            });
          },
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
      wakeAt?: Date;
    };

    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "timeout-mutation",
      workflows,
      harness: {
        configureBuilder: (builder) =>
          builder.withFragment("timeoutMutation", instantiate(timeoutMutationFragmentDefinition)),
      },
      steps: ({ workflow, runner }) => [
        runner.initializeAndRunUntilIdle({
          workflow: "TIMEOUT_MUTATE",
          id: "tm-1",
        }),
        workflow.read({
          read: async (ctx) => {
            const waitingSteps = await ctx.state.getSteps("TIMEOUT_MUTATE", "tm-1");
            return waitingSteps.find((s) => s.stepKey === "waitForEvent:approval")?.wakeAt ?? null;
          },
          storeAs: "wakeAt",
        }),
        runner.advanceTimeAndRunUntilIdle({
          workflow: "TIMEOUT_MUTATE",
          instanceId: "tm-1",
          setTo: (ctx) => new Date((ctx.vars.wakeAt as Date).getTime() + 1),
        }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("TIMEOUT_MUTATE", "tm-1"),
          assert: (finalStatus) => {
            expect(finalStatus?.status).toBe("complete");
            expect(finalStatus?.output).toEqual({ finalStatus: "timed-out" });
          },
        }),
        workflow.read({
          read: async (ctx) => {
            return (
              await ctx.harness.fragments["timeoutMutation"].db
                .createUnitOfWork("read")
                .forSchema(timeoutMutationSchema)
                .find("session_status", (b) => b.whereIndex("primary"))
                .executeRetrieve()
            )[0];
          },
          assert: (rows) => {
            // The "mark-timed-out" step completed successfully (no terminal error),
            // so tx.mutate runs and tx.onTerminalError.mutate does NOT.
            const statuses = rows.map((r) => r.status).sort();
            expect(statuses).toEqual(["done", "waiting"]);
            expect(statuses).not.toContain("error-cleanup");
          },
        }),
      ],
    });

    await runScenario(scenario);
  });

  test("waitForEvent onConsume can persist data before the wait step completes", async () => {
    const consumeMutationSchema = schema("wait_for_event_on_consume_test", (s) =>
      s.addTable("consumed_event", (t) =>
        t
          .addColumn("id", idColumn())
          .addColumn("approvalId", column("string"))
          .addColumn("decision", column("string"))
          .addColumn(
            "createdAt",
            column("timestamp").defaultTo((b) => b.now()),
          )
          .createIndex("idx_consumed_event_approval", ["approvalId"]),
      ),
    );

    const consumeMutationFragmentDefinition = defineFragment("wait-for-event-on-consume-fragment")
      .extend(withDatabase(consumeMutationSchema))
      .providesService("consumedEvents", ({ defineService }) =>
        defineService({
          record: function (approvalId: string, decision: string) {
            return this.serviceTx(consumeMutationSchema)
              .mutate(({ uow }) => {
                uow.create("consumed_event", { approvalId, decision });
              })
              .build();
          },
        }),
      )
      .build();

    let consumeMutationFragment: InstantiatedFragmentFromDefinition<
      typeof consumeMutationFragmentDefinition
    >;

    const OnConsumeMutationWorkflow = defineWorkflow(
      { name: "wait-for-event-on-consume-workflow" },
      async (_event, step) => {
        const approval = await step.waitForEvent<{ approvalId: string; decision: string }>(
          "approval",
          {
            type: "approval",
            onConsume: (tx, event) => {
              tx.mutate((ctx) => {
                ctx.forSchema(consumeMutationSchema).create("consumed_event", {
                  approvalId: event.payload.approvalId,
                  decision: event.payload.decision,
                });
              });
              tx.serviceCalls(() => [
                consumeMutationFragment.services.consumedEvents.record(
                  event.payload.approvalId,
                  "service-approved",
                ) as AnyTxResult,
              ]);
              tx.emit({
                type: "approval_consumed",
                approvalId: event.payload.approvalId,
                decision: event.payload.decision,
              });
            },
          },
        );
        return { decision: approval.payload.decision };
      },
    );

    const workflows = { ON_CONSUME_MUTATE: OnConsumeMutationWorkflow };
    const scenario = defineScenario({
      name: "wait-for-event-on-consume-mutation",
      workflows,
      harness: {
        configureBuilder: (builder) =>
          builder.withFragmentFactory(
            "consumeMutation",
            consumeMutationFragmentDefinition,
            ({ adapter }) => {
              const fragment = instantiate(consumeMutationFragmentDefinition)
                .withOptions({ databaseAdapter: adapter })
                .build();
              consumeMutationFragment = fragment;
              return fragment;
            },
          ),
      },
      steps: ({ workflow, runner }) => [
        workflow.create({ workflow: "ON_CONSUME_MUTATE", id: "on-consume-1" }),
        workflow.event({
          workflow: "ON_CONSUME_MUTATE",
          instanceId: "on-consume-1",
          event: {
            type: "approval",
            payload: { approvalId: "approval-1", decision: "approved" },
          },
        }),
        runner.runUntilIdle({
          workflow: "ON_CONSUME_MUTATE",
          instanceId: "on-consume-1",
          reason: "create",
        }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("ON_CONSUME_MUTATE", "on-consume-1"),
          assert: (status) => {
            expect(status).toMatchObject({ status: "complete", output: { decision: "approved" } });
          },
        }),
        workflow.read({
          read: async (ctx) => {
            return (
              await ctx.harness.fragments["consumeMutation"].db
                .createUnitOfWork("read")
                .forSchema(consumeMutationSchema)
                .find("consumed_event", (b) => b.whereIndex("primary"))
                .executeRetrieve()
            )[0];
          },
          assert: (rows) => {
            expect(rows).toHaveLength(2);
            expect(rows).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  approvalId: "approval-1",
                  decision: "approved",
                }),
                expect.objectContaining({
                  approvalId: "approval-1",
                  decision: "service-approved",
                }),
              ]),
            );
          },
        }),
        workflow.read({
          read: (ctx) => ctx.state.getEmissions("ON_CONSUME_MUTATE", "on-consume-1"),
          assert: (emissions) => {
            expect(emissions).toContainEqual(
              expect.objectContaining({
                stepKey: "waitForEvent:approval",
                payload: {
                  type: "approval_consumed",
                  approvalId: "approval-1",
                  decision: "approved",
                },
              }),
            );
          },
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
      wakeAt?: Date;
      lateTicks?: { processed: number; ticks: number };
    };

    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "wait-timeout-event",
      workflows,
      steps: ({ workflow, runner }) => [
        workflow.create({ workflow: "TIMEOUT_EVENT", id: "timeout-event-1" }),
        runner.tick({
          workflow: "TIMEOUT_EVENT",
          instanceId: "timeout-event-1",
          reason: "create",
        }),
        workflow.read({
          read: async (ctx) => {
            const waitingSteps = await ctx.state.getSteps("TIMEOUT_EVENT", "timeout-event-1");
            return waitingSteps[0]?.wakeAt ?? null;
          },
          storeAs: "wakeAt",
        }),
        runner.eventAndRunUntilIdle({
          workflow: "TIMEOUT_EVENT",
          instanceId: "timeout-event-1",
          event: { type: "ready", payload: { ok: true } },
        }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("TIMEOUT_EVENT", "timeout-event-1"),
          assert: (status) => {
            expect(status?.status).toBe("complete");
            expect(status?.output).toEqual({ ok: true });
          },
        }),
        workflow.read({
          read: (ctx) => ctx.state.getSteps("TIMEOUT_EVENT", "timeout-event-1"),
          assert: (steps) => {
            expect(steps?.[0]).toMatchObject({
              stepKey: "waitForEvent:ready",
              status: "completed",
            });
          },
        }),
        workflow.read({
          read: (ctx) => ctx.state.getEvents("TIMEOUT_EVENT", "timeout-event-1"),
          assert: (events) => {
            expect(events).toHaveLength(1);
            expect(events?.[0]).toMatchObject({
              type: "ready",
              consumedByStepKey: "waitForEvent:ready",
            });
          },
        }),
        runner.advanceTimeAndRunUntilIdle({
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
        workflow.read({
          read: (ctx) => ctx.state.getStatus("TIMEOUT_EVENT", "timeout-event-1"),
          assert: (afterAdvanceStatus) => {
            expect(afterAdvanceStatus?.status).toBe("complete");
            expect(afterAdvanceStatus?.output).toEqual({ ok: true });
          },
        }),
        workflow.read({
          read: (ctx) => ctx.state.getSteps("TIMEOUT_EVENT", "timeout-event-1"),
          assert: (afterAdvanceSteps) => {
            expect(afterAdvanceSteps?.[0]).toMatchObject({
              stepKey: "waitForEvent:ready",
              status: "completed",
            });
          },
        }),
        workflow.read({
          read: (ctx) => ctx.state.getEvents("TIMEOUT_EVENT", "timeout-event-1"),
          assert: (afterAdvanceEvents) => {
            expect(afterAdvanceEvents).toHaveLength(1);
          },
        }),
        workflow.assert((ctx) => {
          expect(ctx.vars.lateTicks?.processed).toBe(0);
          expect(ctx.vars.lateTicks?.ticks).toBe(1);
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

    type ScenarioVars = Record<string, never>;

    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "history-ordering",
      workflows,
      steps: ({ workflow, runner }) => [
        workflow.create({ workflow: "HISTORY", id: "history-1" }),
        runner.tick({ workflow: "HISTORY", instanceId: "history-1", reason: "create" }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("HISTORY", "history-1"),
          assert: (status) => {
            expect(status?.status).toBe("waiting");
          },
        }),
        workflow.event({
          workflow: "HISTORY",
          instanceId: "history-1",
          event: { type: "ready", payload: { ok: true } },
        }),
        runner.tick({ workflow: "HISTORY", instanceId: "history-1", reason: "event" }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("HISTORY", "history-1"),
          assert: (status) => {
            expect(status?.status).toBe("complete");
          },
        }),
        workflow.read({
          read: (ctx) => ctx.state.getHistory("HISTORY", "history-1", { order: "desc" }),
          assert: (history) => {
            const stepKeys = history.steps.map((step) => step.stepKey).sort();
            expect(stepKeys).toEqual(["do:result", "do:seed", "waitForEvent:ready"]);

            const stepTimestamps = history.steps.map((step) =>
              new Date(step.createdAt as Date | string).getTime(),
            );
            expect([...stepTimestamps].sort((a, b) => b - a)).toEqual(stepTimestamps);

            expect(history.events).toHaveLength(1);
            expect(history.events[0]).toMatchObject({
              type: "ready",
              payload: { ok: true },
              consumedByStepKey: "waitForEvent:ready",
            });
            const deliveredAt = history.events[0]?.deliveredAt;
            expect(deliveredAt).toBeTruthy();
            expect(new Date(deliveredAt as Date | string).toString()).not.toBe("Invalid Date");
          },
        }),
        workflow.read({
          read: (ctx) => ctx.state.getHistory("HISTORY", "history-1", { order: "desc" }),
          assert: (historyByRun) => {
            expect(historyByRun.steps).toHaveLength(3);
            expect(historyByRun.events).toHaveLength(1);
          },
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

    type ScenarioVars = Record<string, never>;

    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "event-order",
      workflows,
      steps: ({ workflow, runner }) => [
        workflow.create({ workflow: "EVENT_ORDER", id: "event-order-1" }),
        runner.tick({
          workflow: "EVENT_ORDER",
          instanceId: "event-order-1",
          reason: "create",
        }),
        workflow.event({
          workflow: "EVENT_ORDER",
          instanceId: "event-order-1",
          event: { type: "ready", payload: { value: 1 } },
          timestamp: new Date(1000),
        }),
        workflow.event({
          workflow: "EVENT_ORDER",
          instanceId: "event-order-1",
          event: { type: "ready", payload: { value: 2 } },
          timestamp: new Date(1001),
        }),
        runner.tick({
          workflow: "EVENT_ORDER",
          instanceId: "event-order-1",
          reason: "event",
        }),
        workflow.read({
          read: async (ctx) => {
            const status = await ctx.state.getStatus("EVENT_ORDER", "event-order-1");
            const events = (
              await ctx.harness.db
                .createUnitOfWork("read")
                .forSchema(workflowsSchema)
                .find("workflow_event", (b) => b.whereIndex("primary"))
                .executeRetrieve()
            )[0];
            return { status, events };
          },
          assert: ({ status, events }) => {
            expect(status?.status).toBe("complete");
            expect(events).toHaveLength(2);

            const [firstEvent, secondEvent] = events;

            expect(status?.output).toEqual({
              first: (firstEvent.payload as { value: number }).value,
              second: (secondEvent.payload as { value: number }).value,
            });
            expect(firstEvent).toMatchObject({
              consumedByStepKey: "waitForEvent:first",
            });
            expect(secondEvent).toMatchObject({
              consumedByStepKey: "waitForEvent:second",
            });
          },
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

    type ScenarioVars = Record<string, never>;

    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "event-reason-ticks",
      workflows,
      steps: ({ workflow, runner }) => [
        workflow.create({ workflow: "EVENT_REASON", id: "event-reason-1" }),
        runner.tick({
          workflow: "EVENT_REASON",
          instanceId: "event-reason-1",
          reason: "create",
        }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("EVENT_REASON", "event-reason-1"),
          assert: (statusAfterCreate) => {
            expect(statusAfterCreate?.status).toBe("waiting");
          },
        }),
        runner.tick({
          workflow: "EVENT_REASON",
          instanceId: "event-reason-1",
          reason: "event",
        }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("EVENT_REASON", "event-reason-1"),
          assert: (statusAfterEventTick) => {
            expect(statusAfterEventTick?.status).toBe("waiting");
          },
        }),
        workflow.read({
          read: (ctx) => ctx.state.getSteps("EVENT_REASON", "event-reason-1"),
          assert: (steps) => {
            expect(steps?.[0]).toMatchObject({
              stepKey: "waitForEvent:ready",
              status: "waiting",
              waitEventType: "ready",
            });
          },
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
      pauseResponse?: InstanceStatus;
      resumeResponse?: InstanceStatus;
    };

    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "resume-reason-ticks",
      workflows,
      steps: ({ workflow, runner }) => [
        workflow.create({ workflow: "RESUME_REASON", id: "resume-reason-1" }),
        runner.tick({
          workflow: "RESUME_REASON",
          instanceId: "resume-reason-1",
          reason: "create",
        }),
        workflow.pause({
          workflow: "RESUME_REASON",
          instanceId: "resume-reason-1",
          storeAs: "pauseResponse",
        }),
        runner.tick({
          workflow: "RESUME_REASON",
          instanceId: "resume-reason-1",
          reason: "event",
        }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("RESUME_REASON", "resume-reason-1"),
          assert: (pausedStatus) => {
            expect(pausedStatus?.status).toBe("paused");
          },
        }),
        workflow.resume({
          workflow: "RESUME_REASON",
          instanceId: "resume-reason-1",
          storeAs: "resumeResponse",
        }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("RESUME_REASON", "resume-reason-1"),
          assert: (activeStatus) => {
            expect(activeStatus?.status).toBe("active");
          },
        }),
        runner.tick({
          workflow: "RESUME_REASON",
          instanceId: "resume-reason-1",
          reason: "resume",
        }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("RESUME_REASON", "resume-reason-1"),
          assert: (finalStatus) => {
            expect(finalStatus?.status).toBe("waiting");
          },
        }),
        workflow.read({
          read: (ctx) => ctx.state.getSteps("RESUME_REASON", "resume-reason-1"),
          assert: (steps) => {
            expect(steps?.[0]).toMatchObject({
              stepKey: "waitForEvent:ready",
              status: "waiting",
              waitEventType: "ready",
            });
          },
        }),
        workflow.assert((ctx) => {
          expect(ctx.vars.pauseResponse).toBeDefined();
          expect(ctx.vars.resumeResponse?.status).toBe("active");
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
      pauseResponse?: InstanceStatus;
      resumeResponse?: InstanceStatus;
    };

    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "pause-event-consumption",
      workflows,
      steps: ({ workflow, runner }) => [
        workflow.create({ workflow: "PAUSE_EVENT", id: "pause-event-1" }),
        runner.tick({
          workflow: "PAUSE_EVENT",
          instanceId: "pause-event-1",
          reason: "create",
        }),
        workflow.pause({
          workflow: "PAUSE_EVENT",
          instanceId: "pause-event-1",
          storeAs: "pauseResponse",
        }),
        runner.tick({
          workflow: "PAUSE_EVENT",
          instanceId: "pause-event-1",
          reason: "event",
        }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("PAUSE_EVENT", "pause-event-1"),
          assert: (pausedStatus) => {
            expect(pausedStatus?.status).toBe("paused");
          },
        }),
        workflow.event({
          workflow: "PAUSE_EVENT",
          instanceId: "pause-event-1",
          event: { type: "ready", payload: { ok: true } },
        }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("PAUSE_EVENT", "pause-event-1"),
          assert: (pausedStatus) => {
            expect(pausedStatus?.status).toBe("paused");
          },
        }),
        workflow.read({
          read: (ctx) => ctx.state.getEvents("PAUSE_EVENT", "pause-event-1"),
          assert: (eventsBefore) => {
            const readyBefore = eventsBefore.find((event) => event.type === "ready");
            expect(readyBefore).toMatchObject({
              type: "ready",
              consumedByStepKey: null,
              deliveredAt: null,
            });
          },
        }),
        workflow.resume({
          workflow: "PAUSE_EVENT",
          instanceId: "pause-event-1",
          storeAs: "resumeResponse",
        }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("PAUSE_EVENT", "pause-event-1"),
          assert: (activeStatus) => {
            expect(activeStatus?.status).toBe("active");
          },
        }),
        runner.tick({
          workflow: "PAUSE_EVENT",
          instanceId: "pause-event-1",
          reason: "resume",
        }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("PAUSE_EVENT", "pause-event-1"),
          assert: (finalStatus) => {
            expect(finalStatus?.status).toBe("complete");
            expect(finalStatus?.output).toEqual({ ok: true });
          },
        }),
        workflow.read({
          read: (ctx) => ctx.state.getEvents("PAUSE_EVENT", "pause-event-1"),
          assert: (eventsAfter) => {
            const readyAfter = eventsAfter.find((event) => event.type === "ready");
            expect(readyAfter).toMatchObject({
              type: "ready",
              consumedByStepKey: "waitForEvent:ready",
            });
            expect(readyAfter?.deliveredAt).toBeInstanceOf(Date);
          },
        }),
        workflow.assert((ctx) => {
          expect(ctx.vars.pauseResponse).toBeDefined();
          expect(ctx.vars.resumeResponse?.status).toBe("active");
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

    type ScenarioVars = Record<string, never>;

    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "step-tx-mutations",
      workflows,
      harness: {
        configureBuilder: (builder) =>
          builder.withFragment("mutations", instantiate(mutationsFragmentDefinition)),
      },
      steps: ({ workflow, runner }) => [
        runner.initializeAndRunUntilIdle({ workflow: "MUTATE", id: "mutate-1" }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("MUTATE", "mutate-1"),
          assert: (status) => {
            expect(status?.status).toBe("complete");
            expect(status?.output).toEqual({ result: "mutated" });
          },
        }),
        workflow.read({
          read: async (ctx) => {
            return (
              await ctx.harness.fragments["mutations"].db
                .createUnitOfWork("read")
                .forSchema(mutationsSchema)
                .find("mutation_record", (b) => b.whereIndex("primary"))
                .executeRetrieve()
            )[0];
          },
          assert: (mutationRows) => {
            expect(mutationRows).toHaveLength(1);
            expect(mutationRows?.[0]).toMatchObject({ note: "fromTx-mutate-1" });
          },
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

    type ScenarioVars = Record<string, never>;

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
      steps: ({ workflow, runner }) => [
        runner.initializeAndRunUntilIdle({ workflow: "SERVICE_CALL", id: "service-call-1" }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("SERVICE_CALL", "service-call-1"),
          assert: (status) => {
            expect(status?.status).toBe("errored");
            expect(status?.error?.message).toBe("WORKFLOW_STEP_TX_RETRIEVE_NOT_SUPPORTED");
          },
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

    type ScenarioVars = Record<string, never>;

    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "retry-success",
      workflows,
      steps: ({ workflow, runner }) => [
        runner.initializeAndRunUntilIdle({ workflow: "RETRY", id: "retry-1" }),
        runner.retryAndRunUntilIdle({ workflow: "RETRY", instanceId: "retry-1" }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("RETRY", "retry-1"),
          assert: (status) => {
            expect(status?.status).toBe("complete");
            expect(status?.output).toEqual({ result: "ok" });
          },
        }),
        workflow.read({
          read: (ctx) => ctx.state.getSteps("RETRY", "retry-1"),
          assert: (steps) => {
            expect(steps?.[0]).toMatchObject({
              stepKey: "do:unstable",
              status: "completed",
              attempts: 2,
            });
          },
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

    const scenario = defineScenario<typeof workflows, Record<string, never>>({
      name: "retry-early",
      workflows,
      steps: ({ workflow, runner }) => [
        workflow.create({ workflow: "RETRY_EARLY", id: "retry-early-1" }),
        runner.tick({
          workflow: "RETRY_EARLY",
          instanceId: "retry-early-1",
          reason: "create",
        }),
        // First tick should record a failed attempt and a nextRetryAt timestamp.
        workflow.read({
          read: (ctx) => ctx.state.getStatus("RETRY_EARLY", "retry-early-1"),
          assert: (waiting) => {
            expect(waiting?.status).toBe("waiting");
          },
        }),
        workflow.read({
          read: async (ctx) => {
            const waitingSteps = await ctx.state.getSteps("RETRY_EARLY", "retry-early-1");
            return waitingSteps[0] ?? null;
          },
          assert: (waitingStep) => {
            expect(waitingStep).toMatchObject({
              stepKey: "do:unstable",
              status: "waiting",
              attempts: 1,
            });
            expect(waitingStep?.nextRetryAt).toBeInstanceOf(Date);
          },
        }),
        // Simulate an early retry hook before nextRetryAt.
        // The runner should suspend again and not execute the retry yet.
        runner.tick({
          workflow: "RETRY_EARLY",
          instanceId: "retry-early-1",
          reason: "retry",
        }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("RETRY_EARLY", "retry-early-1"),
          assert: (afterRetry) => {
            // If this fails, we are retrying early based on the hook timestamp instead
            // of honoring the persisted nextRetryAt.
            expect(afterRetry?.status).toBe("waiting");
          },
        }),
        workflow.read({
          read: (ctx) => ctx.state.getSteps("RETRY_EARLY", "retry-early-1"),
          assert: (afterSteps) => {
            expect(afterSteps?.[0]).toMatchObject({
              stepKey: "do:unstable",
              status: "waiting",
              attempts: 1,
            });
          },
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

    type ScenarioVars = Record<string, never>;

    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "errored-step",
      workflows,
      steps: ({ workflow, runner }) => [
        runner.initializeAndRunUntilIdle({ workflow: "ERROR", id: "error-1" }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("ERROR", "error-1"),
          assert: (status) => {
            expect(status?.status).toBe("errored");
          },
        }),
        workflow.read({
          read: (ctx) => ctx.state.getSteps("ERROR", "error-1"),
          assert: (steps) => {
            expect(steps?.[0]).toMatchObject({
              stepKey: "do:boom",
              status: "errored",
            });
          },
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
      pauseResponse?: InstanceStatus;
      resumeResponse?: InstanceStatus;
    };

    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "pause-resume",
      workflows,
      steps: ({ workflow, runner }) => [
        workflow.create({ workflow: "PAUSE", id: "pause-1" }),
        workflow.pause({
          workflow: "PAUSE",
          instanceId: "pause-1",
          storeAs: "pauseResponse",
        }),
        runner.runCreateUntilIdle({ workflow: "PAUSE", instanceId: "pause-1" }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("PAUSE", "pause-1"),
          assert: (pausedStatus) => {
            expect(pausedStatus?.status).toBe("paused");
          },
        }),
        workflow.resume({
          workflow: "PAUSE",
          instanceId: "pause-1",
          storeAs: "resumeResponse",
        }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("PAUSE", "pause-1"),
          assert: (activeStatus) => {
            expect(activeStatus?.status).toBe("active");
          },
        }),
        runner.runResumeUntilIdle({ workflow: "PAUSE", instanceId: "pause-1" }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("PAUSE", "pause-1"),
          assert: (finalStatus) => {
            expect(finalStatus?.status).toBe("complete");
            expect(finalStatus?.output).toEqual({ value: 1 });
          },
        }),
        workflow.read({
          read: (ctx) => ctx.state.getInstance("PAUSE", "pause-1"),
          assert: (instance) => {
            expect(instance).toMatchObject({
              status: "complete",
            });
          },
        }),
        workflow.assert((ctx) => {
          expect(ctx.vars.pauseResponse).toBeDefined();
          expect(ctx.vars.resumeResponse?.status).toBe("active");
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
      terminateResponse?: InstanceStatus;
    };

    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "terminate-active",
      workflows,
      steps: ({ workflow, runner }) => [
        workflow.create({ workflow: "TERM", id: "term-1" }),
        workflow.terminate({
          workflow: "TERM",
          instanceId: "term-1",
          storeAs: "terminateResponse",
        }),
        runner.runCreateUntilIdle({ workflow: "TERM", instanceId: "term-1" }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("TERM", "term-1"),
          assert: (status) => {
            expect(status?.status).toBe("terminated");
          },
        }),
        workflow.read({
          read: (ctx) => ctx.state.getSteps("TERM", "term-1"),
          assert: (steps) => {
            expect(steps).toHaveLength(0);
          },
        }),
        workflow.read({
          read: (ctx) => ctx.state.getInstance("TERM", "term-1"),
          assert: (instance) => {
            expect(instance).toMatchObject({
              status: "terminated",
            });
            expect(instance?.completedAt).toBeInstanceOf(Date);
          },
        }),
        workflow.assert((ctx) => {
          expect(ctx.vars.terminateResponse?.status).toBe("terminated");
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
      wakeAt?: Date;
      terminateResponse?: InstanceStatus;
      wakeProcessed?: number;
    };

    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "terminate-sleep-wake",
      workflows,
      steps: ({ workflow, runner }) => [
        workflow.create({ workflow: "SLEEP_TERM", id: "sleep-term-1" }),
        runner.tick({
          workflow: "SLEEP_TERM",
          instanceId: "sleep-term-1",
          reason: "create",
        }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("SLEEP_TERM", "sleep-term-1"),
          assert: (waitingStatus) => {
            expect(waitingStatus?.status).toBe("waiting");
          },
        }),
        workflow.read({
          read: async (ctx) => {
            const waitingSteps = await ctx.state.getSteps("SLEEP_TERM", "sleep-term-1");
            return waitingSteps[0]?.wakeAt ?? null;
          },
          storeAs: "wakeAt",
        }),
        workflow.terminate({
          workflow: "SLEEP_TERM",
          instanceId: "sleep-term-1",
          storeAs: "terminateResponse",
        }),
        runner.tick({
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
        workflow.read({
          read: (ctx) => ctx.state.getStatus("SLEEP_TERM", "sleep-term-1"),
          assert: (afterWakeStatus) => {
            expect(afterWakeStatus?.status).toBe("terminated");
          },
        }),
        workflow.read({
          read: (ctx) => ctx.state.getSteps("SLEEP_TERM", "sleep-term-1"),
          assert: (afterWakeSteps) => {
            expect(afterWakeSteps?.[0]).toMatchObject({
              stepKey: "sleep:nap",
              status: "waiting",
            });
          },
        }),
        workflow.read({
          read: (ctx) => ctx.state.getInstance("SLEEP_TERM", "sleep-term-1"),
          assert: (instance) => {
            expect(instance).toMatchObject({ status: "terminated" });
            expect(instance?.completedAt).toBeInstanceOf(Date);
          },
        }),
        workflow.assert((ctx) => {
          expect(ctx.vars.terminateResponse?.status).toBe("terminated");
          expect(ctx.vars.wakeAt).toBeInstanceOf(Date);
          expect(ctx.vars.wakeProcessed).toBe(0);
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
    };

    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "batch-create",
      workflows,
      steps: ({ workflow, runner }) => [
        workflow.createBatch({
          workflow: "BATCH",
          instances: [{ id: "batch-1" }, { id: "batch-2" }, { id: "batch-3" }],
          storeAs: "created",
        }),
        runner.runCreateUntilIdle({ workflow: "BATCH", instanceId: "batch-1" }),
        runner.runCreateUntilIdle({ workflow: "BATCH", instanceId: "batch-2" }),
        runner.runCreateUntilIdle({ workflow: "BATCH", instanceId: "batch-3" }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("BATCH", "batch-1"),
          assert: (status1) => {
            expect(status1?.status).toBe("complete");
            expect(status1?.output).toEqual({ instanceId: "batch-1" });
          },
        }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("BATCH", "batch-2"),
          assert: (status2) => {
            expect(status2?.status).toBe("complete");
            expect(status2?.output).toEqual({ instanceId: "batch-2" });
          },
        }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("BATCH", "batch-3"),
          assert: (status3) => {
            expect(status3?.status).toBe("complete");
            expect(status3?.output).toEqual({ instanceId: "batch-3" });
          },
        }),
        workflow.read({
          read: async (ctx) => {
            return (
              await ctx.harness.db
                .createUnitOfWork("read")
                .forSchema(workflowsSchema)
                .find("workflow_instance", (b) => b.whereIndex("primary"))
                .executeRetrieve()
            )[0];
          },
          assert: (instances) => {
            expect(instances).toHaveLength(3);
          },
        }),
        workflow.assert((ctx) => {
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
    };

    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "batch-skip",
      workflows,
      steps: ({ workflow, runner }) => [
        workflow.create({ workflow: "BATCH_SKIP", id: "existing-1" }),
        workflow.createBatch({
          workflow: "BATCH_SKIP",
          instances: [{ id: "existing-1" }, { id: "dup-1" }, { id: "dup-1" }, { id: "fresh-1" }],
          storeAs: "created",
        }),
        workflow.read({
          read: async (ctx) => {
            return (
              await ctx.harness.db
                .createUnitOfWork("read")
                .forSchema(workflowsSchema)
                .find("workflow_instance", (b) => b.whereIndex("primary"))
                .executeRetrieve()
            )[0];
          },
          assert: (instances) => {
            expect(instances).toHaveLength(3);
          },
        }),
        runner.runCreateUntilIdle({ workflow: "BATCH_SKIP", instanceId: "dup-1" }),
        runner.runCreateUntilIdle({ workflow: "BATCH_SKIP", instanceId: "fresh-1" }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("BATCH_SKIP", "fresh-1"),
          assert: (freshStatus) => {
            expect(freshStatus?.status).toBe("complete");
            expect(freshStatus?.output).toEqual({ value: "fresh-1" });
          },
        }),
        workflow.assert((ctx) => {
          expect(ctx.vars.created?.map((entry) => entry.id)).toEqual(["dup-1", "fresh-1"]);
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

    type ScenarioVars = Record<string, never>;

    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "batch-route-response",
      workflows,
      steps: ({ runner }) => [
        runner.callRoute({
          method: "POST",
          path: "/:workflowName/instances/batch",
          options: {
            pathParams: { workflowName: RouteBatchWorkflow.name },
            body: { instances: [{ id: "route-1" }, { id: "route-2" }] },
          },
          assert: (routeResponse) => {
            expect(routeResponse).toMatchObject({ type: "json" });
            if (routeResponse.type !== "json") {
              throw new Error(`Expected json response, received ${routeResponse.type}`);
            }

            const response = routeResponse.data as {
              instances: Array<{ id: string; details: { status: string } }>;
            };
            expect(response.instances.map((entry) => entry.id)).toEqual(["route-1", "route-2"]);
            expect(response.instances.map((entry) => entry.details.status)).toEqual([
              "active",
              "active",
            ]);
          },
        }),
      ],
    });

    await runScenario(scenario);
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
    };

    const scenario = defineScenario<
      typeof workflows,
      ScenarioVars,
      undefined,
      Record<string, never>,
      ["workflowRunner", "observer"]
    >({
      name: "scenario-step-emissions",
      workflows,
      runners: ["workflowRunner", "observer"],
      harness: { runtime },
      steps: ({ workflow, runners, concurrent }) => [
        workflow.create({ workflow: "EMIT", id: "emit-1" }),
        concurrent({
          workflowRunner: [
            runners.workflowRunner.runCreateUntilIdle({ workflow: "EMIT", instanceId: "emit-1" }),
          ],
          observer: [
            runners.observer.waitForEmission({
              workflow: "EMIT",
              instanceId: "emit-1",
              match: (message) =>
                (message.payload as { type?: string; phase?: string }).type === "phase" &&
                (message.payload as { phase?: string }).phase === "started",
              storeAs: "started",
            }),
            workflow.read({
              read: (ctx) => ctx.state.getEmissions("EMIT", "emit-1"),
              assert: (rowsWhileRunning) => {
                expect(rowsWhileRunning).toEqual(
                  expect.arrayContaining([
                    expect.objectContaining({ actor: "system", stepKey: "do:stream" }),
                    expect.objectContaining({
                      actor: "user",
                      payload: { type: "phase", phase: "started" },
                    }),
                  ]),
                );
              },
            }),
            runners.observer.resolveControl({ key: "stream:release" }),
          ],
        }),
        runners.workflowRunner.waitForEmission({
          workflow: "EMIT",
          instanceId: "emit-1",
          match: (message) =>
            (message.payload as { type?: string; phase?: string }).type === "phase" &&
            (message.payload as { phase?: string }).phase === "complete",
        }),
        runners.workflowRunner.drainHooks(),
        workflow.read({
          read: (ctx) => ctx.state.getEmissions("EMIT", "emit-1"),
          assert: (rowsAfterCleanup) => {
            expect(rowsAfterCleanup).toEqual([]);
          },
        }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("EMIT", "emit-1"),
          assert: (status) => {
            expect(status).toMatchObject({ status: "complete", output: { ok: true } });
          },
        }),
        workflow.assert((ctx) => {
          expect(ctx.vars.started).toMatchObject({
            stepKey: "do:stream",
            payload: { type: "phase", phase: "started" },
          });
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
    const scenario = defineScenario<
      typeof workflows,
      Record<string, never>,
      undefined,
      Record<string, never>,
      ["workflowRunner", "sender"]
    >({
      name: "scenario-step-inbound-emissions",
      workflows,
      runners: ["workflowRunner", "sender"],
      harness: { runtime },
      steps: ({ workflow, runners, concurrent }) => [
        workflow.create({ workflow: "INBOUND", id: "inbound-1" }),
        concurrent({
          workflowRunner: [
            runners.workflowRunner.runCreateUntilIdle({
              workflow: "INBOUND",
              instanceId: "inbound-1",
            }),
          ],
          sender: [
            runners.sender.waitForControl({ key: "step:ready" }),
            workflow.event({
              workflow: "INBOUND",
              instanceId: "inbound-1",
              event: { type: "command", payload: { command: "continue" } },
            }),
            runners.sender.waitForControl({ key: "message:received" }),
            runners.sender.resolveControl({ key: "step:release" }),
          ],
        }),
        workflow.read({
          read: (ctx) => ctx.state.getEvents("INBOUND", "inbound-1"),
          assert: (events) => {
            expect(events).toEqual(
              expect.arrayContaining([
                expect.objectContaining({ type: "command", payload: { command: "continue" } }),
              ]),
            );
          },
        }),
        workflow.assert(() => {
          expect(received).toEqual([{ command: "continue" }]);
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
    const scenario = defineScenario({
      name: "service-step-message-replay",
      workflows,
      runners: ["workflowRunner", "sender"],
      harness: {
        runtime,
        fragmentConfig: {
          stepEmissions: new BufferedPumpRegistry<WorkflowStepLivePump>(),
        },
      },
      steps: ({ workflow, runners, concurrent }) => [
        workflow.create({ workflow: "INBOUND", id: "inbound-1" }),
        concurrent({
          workflowRunner: [
            runners.workflowRunner.runCreateUntilIdle({
              workflow: "INBOUND",
              instanceId: "inbound-1",
            }),
          ],
          sender: [
            runners.sender.waitForControl({ key: "step:first:ready" }),
            workflow.event({
              workflow: "INBOUND",
              instanceId: "inbound-1",
              event: { type: "command", payload: { command: "continue" } },
            }),
            runners.sender.waitForControl({ key: "message:first:received" }),
            runners.sender.resolveControl({ key: "step:first:release" }),
            runners.sender.waitForControl({ key: "step:second:ready" }),
          ],
        }),
        workflow.read({
          read: (ctx) => ctx.state.getEvents("INBOUND", "inbound-1"),
          assert: (events) => {
            expect(events).toEqual([
              expect.objectContaining({ type: "command", payload: { command: "continue" } }),
            ]);
          },
        }),
        workflow.assert(() => {
          expect(received).toEqual([{ step: "first", message: { command: "continue" } }]);
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
    };
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "step-emissions-clear",
      workflows,
      steps: ({ workflow, runner }) => [
        runner.initializeAndRunUntilIdle({ workflow: "EMIT", id: "emit-1" }),
        runner.drainHooks(),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("EMIT", "emit-1"),
          assert: (status) => {
            expect(status?.status).toBe("complete");
          },
        }),
        workflow.read({
          read: (ctx) => ctx.state.getEmissions("EMIT", "emit-1"),
          assert: (rowsAfterCleanup) => {
            expect(rowsAfterCleanup).toEqual([]);
          },
        }),
      ],
    });

    await runScenario(scenario);
  });
});
