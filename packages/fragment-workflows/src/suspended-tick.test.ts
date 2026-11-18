import { expect, test } from "vitest";

import { defineScenario, runScenario } from "./scenario";
import { defineWorkflow } from "./workflow";

test("a run left waiting for a retry and a sleep at once resumes for each", async () => {
  const runs = { flaky: 0 };
  const workflow = defineWorkflow({ name: "retry-beside-sleep" }, async (_event, step) => {
    await Promise.all([
      step.sleep("pause", "1 hour"),
      step.do("flaky", { retries: { limit: 1, delay: "1 minute" } }, () => {
        runs.flaky += 1;
        if (runs.flaky === 1) {
          throw new Error("Flaky the first time");
        }
        return "recovered";
      }),
    ]);
    return "done";
  });
  await runScenario(
    defineScenario({
      name: "a retry beside a sleep",
      workflows: { WORKFLOW: workflow },
      // Durable hooks fall due by database time, which follows the scenario clock only in memory.
      harness: { adapter: { type: "in-memory" }, autoTickHooks: true },
      steps: ({ workflow, runner }) => [
        workflow.create({ workflow: "WORKFLOW", id: "run-1" }),
        runner.drainHooks(),
        workflow.read({
          read: (ctx) => ctx.state.getSteps("WORKFLOW", "run-1"),
          assert: (steps) => {
            expect(steps).toMatchObject([
              { stepKey: "sleep:pause", status: "waiting" },
              { stepKey: "do:flaky", status: "waiting", attempts: 1 },
            ]);
          },
        }),
        runner.advanceTimeAndDrainHooks({ advanceBy: "1 minute" }),
        workflow.read({
          read: (ctx) => ctx.state.getSteps("WORKFLOW", "run-1"),
          assert: (steps) => {
            expect(steps).toMatchObject([
              { stepKey: "sleep:pause", status: "waiting" },
              { stepKey: "do:flaky", status: "completed", attempts: 2, result: "recovered" },
            ]);
          },
        }),
        runner.advanceTimeAndDrainHooks({ advanceBy: "1 hour" }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("WORKFLOW", "run-1"),
          assert: (status) => {
            expect(status).toMatchObject({ status: "complete", output: "done" });
          },
        }),
      ],
    }),
  );
});

test("a sleep's tick leaves a longer sleep beside it waiting", async () => {
  const workflow = defineWorkflow({ name: "two-sleeps" }, async (_event, step) => {
    await Promise.all([step.sleep("long", "2 hours"), step.sleep("short", "1 hour")]);
    return "done";
  });
  await runScenario(
    defineScenario({
      name: "a short and a long sleep",
      workflows: { WORKFLOW: workflow },
      harness: { adapter: { type: "in-memory" }, autoTickHooks: true },
      steps: ({ workflow, runner }) => [
        workflow.create({ workflow: "WORKFLOW", id: "run-1" }),
        runner.drainHooks(),
        runner.advanceTimeAndDrainHooks({ advanceBy: "1 hour" }),
        workflow.read({
          read: (ctx) => ctx.state.getSteps("WORKFLOW", "run-1"),
          assert: (steps) => {
            expect(steps).toMatchObject([
              { stepKey: "sleep:long", status: "waiting" },
              { stepKey: "sleep:short", status: "completed" },
            ]);
          },
        }),
        runner.advanceTimeAndDrainHooks({ advanceBy: "1 hour" }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("WORKFLOW", "run-1"),
          assert: (status) => {
            expect(status).toMatchObject({ status: "complete", output: "done" });
          },
        }),
      ],
    }),
  );
});

test("a sleep's tick does not time out an event wait beside it", async () => {
  const workflow = defineWorkflow({ name: "sleep-beside-wait" }, async (_event, step) => {
    const [, approval] = await Promise.all([
      step.sleep("pause", "1 hour"),
      step.waitForEvent<{ by: string }>("approval", { type: "approved", timeout: "2 hours" }),
    ]);
    return approval.payload.by;
  });
  await runScenario(
    defineScenario({
      name: "a sleep beside an event wait",
      workflows: { WORKFLOW: workflow },
      harness: { adapter: { type: "in-memory" }, autoTickHooks: true },
      steps: ({ workflow, runner }) => [
        workflow.create({ workflow: "WORKFLOW", id: "run-1" }),
        runner.drainHooks(),
        runner.advanceTimeAndDrainHooks({ advanceBy: "1 hour" }),
        workflow.read({
          read: (ctx) => ctx.state.getSteps("WORKFLOW", "run-1"),
          assert: (steps) => {
            expect(steps).toEqual(
              expect.arrayContaining([
                expect.objectContaining({ stepKey: "sleep:pause", status: "completed" }),
                expect.objectContaining({ stepKey: "waitForEvent:approval", status: "waiting" }),
              ]),
            );
          },
        }),
        workflow.event({
          workflow: "WORKFLOW",
          instanceId: "run-1",
          event: { type: "approved", payload: { by: "ada" } },
        }),
        runner.drainHooks(),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("WORKFLOW", "run-1"),
          assert: (status) => {
            expect(status).toMatchObject({ status: "complete", output: "ada" });
          },
        }),
      ],
    }),
  );
});

test("a retry's tick leaves a later retry beside it waiting", async () => {
  const runs = { soon: 0, later: 0 };
  const workflow = defineWorkflow({ name: "two-retries" }, async (_event, step) => {
    return await Promise.all(
      (["soon", "later"] as const).map((name) =>
        step.do(
          name,
          { retries: { limit: 1, delay: name === "soon" ? "1 minute" : "1 hour" } },
          () => {
            runs[name] += 1;
            if (runs[name] === 1) {
              throw new Error(`${name} fails the first time`);
            }
            return name;
          },
        ),
      ),
    );
  });
  await runScenario(
    defineScenario({
      name: "a soon and a later retry",
      workflows: { WORKFLOW: workflow },
      harness: { adapter: { type: "in-memory" }, autoTickHooks: true },
      steps: ({ workflow, runner }) => [
        workflow.create({ workflow: "WORKFLOW", id: "run-1" }),
        runner.drainHooks(),
        runner.advanceTimeAndDrainHooks({ advanceBy: "1 minute" }),
        workflow.read({
          read: (ctx) => ctx.state.getSteps("WORKFLOW", "run-1"),
          assert: (steps) => {
            expect(steps).toEqual(
              expect.arrayContaining([
                expect.objectContaining({ stepKey: "do:soon", status: "completed", attempts: 2 }),
                expect.objectContaining({ stepKey: "do:later", status: "waiting", attempts: 1 }),
              ]),
            );
          },
        }),
        runner.advanceTimeAndDrainHooks({ advanceBy: "1 hour" }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("WORKFLOW", "run-1"),
          assert: (status) => {
            expect(status).toMatchObject({ status: "complete", output: ["soon", "later"] });
          },
        }),
      ],
    }),
  );
});
