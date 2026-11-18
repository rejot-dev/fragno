import { expect, test } from "vitest";

import { defineScenario, runScenario } from "./scenario";
import { defineWorkflow, NonRetryableError, type WorkflowStep } from "./workflow";

const harness = {
  // Durable hooks fall due by database time, which follows the scenario clock only in memory.
  adapter: { type: "in-memory" },
  autoTickHooks: true,
} as const;

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function workflowOf(name: string, body: (step: WorkflowStep) => Promise<unknown>) {
  return { WORKFLOW: defineWorkflow({ name }, async (_event, step) => await body(step)) };
}

/** The status of a run of `body` after its first tick. */
async function firstTick(name: string, body: (step: WorkflowStep) => Promise<unknown>) {
  const result = await runScenario(
    defineScenario({
      name,
      workflows: workflowOf(name, body),
      harness,
      steps: ({ workflow, runner }) => [
        workflow.create({ workflow: "WORKFLOW", id: "run-1" }),
        runner.drainHooks(),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("WORKFLOW", "run-1"),
          storeAs: "status",
        }),
      ],
    }),
  );
  return result.vars["status"];
}

/** A run of `body` that receives one `approved` event after its first tick. */
function approvedRun(name: string, body: (step: WorkflowStep) => Promise<unknown>) {
  return defineScenario({
    name,
    workflows: workflowOf(name, body),
    harness,
    steps: ({ workflow, runner }) => [
      workflow.create({ workflow: "WORKFLOW", id: "run-1" }),
      runner.drainHooks(),
      workflow.read({
        read: (ctx) => ctx.state.getStatus("WORKFLOW", "run-1"),
        storeAs: "beforeEvent",
      }),
      workflow.event({
        workflow: "WORKFLOW",
        instanceId: "run-1",
        event: { type: "approved", payload: { by: "ada" } },
      }),
      runner.drainHooks(),
      workflow.read({
        read: (ctx) => ctx.state.getStatus("WORKFLOW", "run-1"),
        storeAs: "afterEvent",
      }),
    ],
  });
}

test("a step that fails for good beside a wait errors the run", async () => {
  const status = await firstTick("failure-beside-wait", async (step) => {
    await Promise.all([
      step.waitForEvent("approval", { type: "approved" }),
      step.do("charge", async () => {
        await delay(10);
        throw new NonRetryableError("Card declined");
      }),
    ]);
    return "charged";
  });

  expect(status).toMatchObject({
    status: "errored",
    error: { message: "Card declined" },
  });
});

test("Promise.allSettled over a wait and a failure settles once the wait does", async () => {
  const result = await runScenario(
    approvedRun("all-settled", async (step) => {
      const settled = await Promise.allSettled([
        step.waitForEvent("approval", { type: "approved" }),
        step.do("charge", () => {
          throw new NonRetryableError("Card declined");
        }),
      ]);
      return settled.map((outcome) => outcome.status);
    }),
  );

  expect(result.vars["beforeEvent"]).toMatchObject({ status: "waiting" });
  expect(result.vars["afterEvent"]).toMatchObject({
    status: "complete",
    output: ["fulfilled", "rejected"],
  });
});

test("a catch around a wait runs only when the wait times out", async () => {
  const caught: string[] = [];
  const workflow = defineWorkflow({ name: "catch-around-wait" }, async (_event, step) => {
    try {
      await step.waitForEvent("approval", { type: "approved", timeout: "1 hour" });
      return "approved";
    } catch (error) {
      caught.push((error as Error).name);
      return "timed out";
    }
  });
  const result = await runScenario(
    defineScenario({
      name: "a catch around a wait",
      workflows: { WORKFLOW: workflow },
      harness,
      steps: ({ workflow, runner }) => [
        workflow.create({ workflow: "WORKFLOW", id: "run-1" }),
        runner.drainHooks(),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("WORKFLOW", "run-1"),
          storeAs: "waiting",
        }),
        runner.advanceTimeAndDrainHooks({ advanceBy: "1 hour" }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("WORKFLOW", "run-1"),
          storeAs: "timedOut",
        }),
      ],
    }),
  );

  expect(result.vars["waiting"]).toMatchObject({ status: "waiting" });
  expect(result.vars["timedOut"]).toMatchObject({ status: "complete", output: "timed out" });
  expect(caught).toEqual(["WaitForEventTimeoutError"]);
});

test("a catch around a retried step runs only once its retries run out", async () => {
  const caught: string[] = [];
  const workflow = defineWorkflow({ name: "catch-around-retry" }, async (_event, step) => {
    try {
      return await step.do("flaky", { retries: { limit: 1, delay: "1 minute" } }, () => {
        throw new Error("Still down");
      });
    } catch (error) {
      caught.push((error as Error).message);
      return "gave up";
    }
  });
  const result = await runScenario(
    defineScenario({
      name: "a catch around a retried step",
      workflows: { WORKFLOW: workflow },
      harness,
      steps: ({ workflow, runner }) => [
        workflow.create({ workflow: "WORKFLOW", id: "run-1" }),
        runner.drainHooks(),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("WORKFLOW", "run-1"),
          storeAs: "retrying",
        }),
        runner.advanceTimeAndDrainHooks({ advanceBy: "1 minute" }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("WORKFLOW", "run-1"),
          storeAs: "exhausted",
        }),
      ],
    }),
  );

  expect(result.vars["retrying"]).toMatchObject({ status: "waiting" });
  expect(result.vars["exhausted"]).toMatchObject({ status: "complete", output: "gave up" });
  expect(caught).toEqual(["Still down"]);
});

test("a race keeps the step that won it when the loser settles in a later tick", async () => {
  let attempts = 0;
  const workflow = defineWorkflow({ name: "race-replay" }, async (_event, step) => {
    // The deadline comes first, so only the order the steps settled in can keep the retried step
    // the winner once the deadline has passed too.
    const winner = await Promise.race([
      step.sleep("deadline", "1 hour").then(() => "deadline"),
      step.do("flaky", { retries: { limit: 1, delay: "1 minute" } }, () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("Down the first time");
        }
        return "flaky";
      }),
    ]);
    await step.sleep("cool down", "2 hours");
    return winner;
  });
  const result = await runScenario(
    defineScenario({
      name: "a race replayed after its loser settles",
      workflows: { WORKFLOW: workflow },
      harness,
      steps: ({ workflow, runner }) => [
        workflow.create({ workflow: "WORKFLOW", id: "run-1" }),
        runner.drainHooks(),
        runner.advanceTimeAndDrainHooks({ advanceBy: "1 minute" }),
        runner.advanceTimeAndDrainHooks({ advanceBy: "1 hour" }),
        workflow.read({
          read: (ctx) => ctx.state.getSteps("WORKFLOW", "run-1"),
          storeAs: "steps",
        }),
        runner.advanceTimeAndDrainHooks({ advanceBy: "2 hours" }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("WORKFLOW", "run-1"),
          storeAs: "status",
        }),
      ],
    }),
  );

  // Both steps settled before the last tick replays the race.
  expect(result.vars["steps"]).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ stepKey: "do:flaky", status: "completed" }),
      expect.objectContaining({ stepKey: "sleep:deadline", status: "completed" }),
    ]),
  );
  expect(result.vars["status"]).toMatchObject({ status: "complete", output: "flaky" });
});

test("workflow code that awaits something other than a step errors the run", async () => {
  const status = await firstTick("awaits-outside-step", async (step) => {
    await delay(10);
    return await step.do("after the delay", () => "unreachable");
  });

  expect(status).toMatchObject({
    status: "errored",
    error: { name: "WorkflowStalledError" },
  });
});

test("a step called inside a step.do callback fails that step without retries", async () => {
  const status = await firstTick("nested-step", async (step) => {
    return await step.do("outer", { retries: { limit: 3, delay: "1 minute" } }, async () => {
      await step.sleep("inner", "1 hour");
      return "slept";
    });
  });

  expect(status).toMatchObject({
    status: "errored",
    error: { message: expect.stringContaining("WORKFLOW_STEP_NESTED_IN_DO") },
  });
});

test("a race keeps its winner when a failed step after it is retried", async () => {
  let finishes = 0;
  const workflow = defineWorkflow({ name: "race-then-failure" }, async (_event, step) => {
    const winner = await Promise.race([
      step.do("slow-1", async () => {
        await delay(20);
        return "slow-1";
      }),
      step.do("slow-2", async () => {
        await delay(20);
        return "slow-2";
      }),
      step.do("fast", () => "fast"),
    ]);
    // Fails while the slow steps still run, so the tick ends before they finish.
    await step.do("finish", () => {
      finishes += 1;
      if (finishes === 1) {
        throw new NonRetryableError("Down the first time");
      }
    });
    return winner;
  });
  const result = await runScenario(
    defineScenario({
      name: "a race before a retried failure",
      workflows: { WORKFLOW: workflow },
      steps: ({ workflow, runner }) => [
        runner.initializeAndRunUntilIdle({ workflow: "WORKFLOW", id: "run-1" }),
        workflow.retryFailedStep({ workflow: "WORKFLOW", instanceId: "run-1" }),
        runner.retryAndRunUntilIdle({ workflow: "WORKFLOW", instanceId: "run-1" }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("WORKFLOW", "run-1"),
          storeAs: "status",
        }),
      ],
    }),
  );

  expect(result.vars["status"]).toMatchObject({ status: "complete", output: "fast" });
});

test("a retried step does not hold back the steps that settled after its failure", async () => {
  let attempts = 0;
  let deliver = (_message: string) => {};
  const workflow = defineWorkflow({ name: "retry-before-sibling" }, async (_event, step) => {
    const [, received] = await Promise.all([
      (async () => {
        // Settles after "receive" failed, so it replays after it.
        await step.do("config", async () => {
          await delay(10);
          return "config";
        });
        await step.do("send", () => deliver("message"));
      })(),
      // The latest step, so management may retry it.
      step.do("receive", async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new NonRetryableError("Connection failed");
        }
        return await new Promise<string>((resolve) => {
          deliver = resolve;
        });
      }),
    ]);
    return received;
  });
  const result = await runScenario(
    defineScenario({
      name: "a retried step before a sibling",
      workflows: { WORKFLOW: workflow },
      steps: ({ workflow, runner }) => [
        runner.initializeAndRunUntilIdle({ workflow: "WORKFLOW", id: "run-1" }),
        workflow.retryFailedStep({ workflow: "WORKFLOW", instanceId: "run-1" }),
        runner.retryAndRunUntilIdle({ workflow: "WORKFLOW", instanceId: "run-1" }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("WORKFLOW", "run-1"),
          storeAs: "status",
        }),
      ],
    }),
  );

  expect(result.vars["status"]).toMatchObject({ status: "complete", output: "message" });
}, 2000);

test("a step added before replayed steps does not hold them back", async () => {
  // Stands in for deploying new code while the run sleeps.
  let deployed = false;
  const result = await runScenario(
    defineScenario({
      name: "a step added before replayed steps",
      workflows: workflowOf("added-step", async (step) => {
        if (deployed) {
          await step.do("added", () => "added");
        }
        const value = await step.do("original", () => {
          deployed = true;
          return "original";
        });
        await step.sleep("pause", "1 hour");
        return value;
      }),
      harness,
      steps: ({ workflow, runner }) => [
        workflow.create({ workflow: "WORKFLOW", id: "run-1" }),
        runner.drainHooks(),
        runner.advanceTimeAndDrainHooks({ advanceBy: "1 hour" }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("WORKFLOW", "run-1"),
          storeAs: "status",
        }),
      ],
    }),
  );

  expect(result.vars["status"]).toMatchObject({ status: "complete", output: "original" });
});

test("a step that fails before it starts records nothing", async () => {
  const result = await runScenario(
    defineScenario({
      name: "an invalid sleep duration",
      workflows: workflowOf("invalid-duration", async (step) => {
        try {
          await step.sleep("pause", "soon" as never);
        } catch {
          // The run carries on without the pause.
        }
        return await step.do("after", () => "after");
      }),
      harness,
      steps: ({ workflow, runner }) => [
        workflow.create({ workflow: "WORKFLOW", id: "run-1" }),
        runner.drainHooks(),
        workflow.read({
          read: async (ctx) => ({
            status: await ctx.state.getStatus("WORKFLOW", "run-1"),
            steps: await ctx.state.getSteps("WORKFLOW", "run-1"),
          }),
          storeAs: "run",
        }),
      ],
    }),
  );

  const run = result.vars["run"] as { status: unknown; steps: Array<{ stepKey: string }> };
  expect(run.status).toMatchObject({ status: "complete", output: "after" });
  expect(run.steps.map((step) => step.stepKey)).toEqual(["do:after"]);
});
