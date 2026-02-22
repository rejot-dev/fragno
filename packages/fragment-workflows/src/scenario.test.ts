import { describe, expect, test } from "vitest";
import { defineWorkflow, type WorkflowEvent, type WorkflowStep } from "./workflow";
import { createWorkflowsTestRuntime } from "./test";
import {
  createScenarioSteps,
  defineScenario,
  runScenario,
  type WorkflowScenarioHookRow,
  type WorkflowScenarioStepRow,
} from "./scenario";

const SleepWorkflow = defineWorkflow(
  { name: "sleep-workflow" },
  async (event: WorkflowEvent<{ note: string }>, step: WorkflowStep) => {
    await step.sleep("sleep", "1 hour");
    return { note: event.payload.note };
  },
);

const EventWorkflow = defineWorkflow(
  { name: "event-workflow" },
  async (_event: WorkflowEvent<unknown>, step: WorkflowStep) => {
    return await step.waitForEvent("ready", { type: "ready", timeout: "2 hours" });
  },
);

describe("workflows scenario DSL", () => {
  test("drives sleep + event flows and captures history", async () => {
    const workflows = {
      sleep: SleepWorkflow,
      events: EventWorkflow,
    };

    type ScenarioVars = {
      sleepStatus?: { status: string };
      sleepFinal?: { status: string };
      eventStatus?: { status: string };
      eventFinal?: { status: string };
      sleepHistory?: { steps: unknown[] };
      hooks?: WorkflowScenarioHookRow[];
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, ScenarioVars>();
    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "sleep-and-event",
      workflows,
      steps: [
        scenarioSteps.initializeAndRunUntilIdle({
          workflow: "sleep",
          id: "sleep-1",
          params: { note: "alpha" },
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("sleep", "sleep-1"),
          storeAs: "sleepStatus",
        }),
        scenarioSteps.advanceTimeAndRunUntilIdle({
          workflow: "sleep",
          instanceId: "sleep-1",
          advanceBy: "1 hour",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("sleep", "sleep-1"),
          storeAs: "sleepFinal",
        }),
        scenarioSteps.initializeAndRunUntilIdle({
          workflow: "events",
          id: "event-1",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("events", "event-1"),
          storeAs: "eventStatus",
        }),
        scenarioSteps.eventAndRunUntilIdle({
          workflow: "events",
          instanceId: "event-1",
          event: { type: "ready", payload: { ok: true } },
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getStatus("events", "event-1"),
          storeAs: "eventFinal",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getHistory("sleep", "sleep-1", { order: "asc", pageSize: 50 }),
          storeAs: "sleepHistory",
        }),
        scenarioSteps.read({
          read: (ctx) =>
            ctx.state.internal.getHooks({
              hookName: "onWorkflowEnqueued",
              workflowName: "sleep-workflow",
              instanceId: "sleep-1",
            }),
          storeAs: "hooks",
        }),
        scenarioSteps.assert((ctx) => {
          expect(ctx.vars.sleepStatus?.status).toBe("waiting");
          expect(ctx.vars.sleepFinal?.status).toBe("complete");
          expect(ctx.vars.eventStatus?.status).toBe("waiting");
          expect(ctx.vars.eventFinal?.status).toBe("complete");
          expect(ctx.vars.sleepHistory?.steps.length ?? 0).toBeGreaterThan(0);
          expect(ctx.vars.hooks?.length ?? 0).toBeGreaterThan(0);
        }),
      ],
    });

    const result = await runScenario(scenario);
    expect(result.vars.sleepHistory).toBeDefined();
  });

  test("schedules retries relative to failure time", async () => {
    let attempts = 0;
    const runtime = createWorkflowsTestRuntime({ startAt: 0, seed: 7 });
    const testClock = runtime.time;
    const startMs = testClock.now().getTime();

    const RetryWorkflow = defineWorkflow(
      { name: "retry-workflow" },
      async (_event: WorkflowEvent<unknown>, step: WorkflowStep) => {
        return await step.do(
          "maybe-fail",
          { retries: { limit: 1, delay: "10 minutes", backoff: "constant" } },
          () => {
            attempts += 1;
            if (attempts === 1) {
              testClock.advanceBy("5 minutes");
              throw new Error("RETRY_ME");
            }
            return { ok: true };
          },
        );
      },
    );

    const workflows = {
      retry: RetryWorkflow,
    };

    type RetryVars = {
      steps?: WorkflowScenarioStepRow[];
    };

    const scenarioSteps = createScenarioSteps<typeof workflows, RetryVars>();
    const scenario = defineScenario<typeof workflows, RetryVars>({
      name: "retry-delay",
      workflows,
      harness: { runtime, adapter: { type: "in-memory" } },
      steps: [
        scenarioSteps.initializeAndRunUntilIdle({
          workflow: "retry",
          id: "retry-1",
        }),
        scenarioSteps.read({
          read: (ctx) => ctx.state.getSteps("retry", "retry-1"),
          storeAs: "steps",
        }),
        scenarioSteps.assert((ctx) => {
          const rows = ctx.vars.steps ?? [];
          const retryStep = rows.find((row) => row.stepKey === "do:maybe-fail") ?? rows[0];

          expect(retryStep).toBeDefined();
          expect(retryStep?.status).toBe("waiting");
          expect(retryStep?.nextRetryAt).toBeInstanceOf(Date);

          const expectedMs = startMs + 15 * 60 * 1000;
          expect(retryStep?.nextRetryAt?.getTime()).toBe(expectedMs);
          expect(testClock.now().getTime() - startMs).toBe(5 * 60 * 1000);
        }),
      ],
    });

    await runScenario(scenario);
  });
});
