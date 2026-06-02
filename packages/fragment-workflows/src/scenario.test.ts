import { describe, expect, test } from "vitest";

import {
  defineScenario,
  runScenario,
  type WorkflowScenarioEventRow,
  type WorkflowScenarioHookRow,
  type WorkflowScenarioStepRow,
} from "./scenario";
import { createWorkflowsTestRuntime } from "./test";
import { defineWorkflow, type WorkflowEvent, type WorkflowStep } from "./workflow";

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
  test("types read assert values and vars as readonly", () => {
    const workflows = { sleep: SleepWorkflow };

    defineScenario<typeof workflows, { saved?: number[] }>({
      name: "readonly-assert-types",
      workflows,
      steps: ({ workflow }) => [
        workflow.read({
          read: () => [1, 2, 3],
          assert: (value, ctx) => {
            // @ts-expect-error read assert values are readonly
            value.push(4);
            // @ts-expect-error assert contexts cannot mutate scenario vars
            ctx.vars.saved = value;
          },
        }),
        workflow.assert((ctx) => {
          // @ts-expect-error scenario assert contexts cannot mutate scenario vars
          ctx.vars.saved = [1];
        }),
      ],
    });
  });

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

    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "sleep-and-event",
      workflows,
      steps: ({ workflow, runner }) => [
        runner.initializeAndRunUntilIdle({
          workflow: "sleep",
          id: "sleep-1",
          params: { note: "alpha" },
        }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("sleep", "sleep-1"),
          storeAs: "sleepStatus",
        }),
        runner.advanceTimeAndRunUntilIdle({
          workflow: "sleep",
          instanceId: "sleep-1",
          advanceBy: "1 hour",
        }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("sleep", "sleep-1"),
          storeAs: "sleepFinal",
        }),
        runner.initializeAndRunUntilIdle({
          workflow: "events",
          id: "event-1",
        }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("events", "event-1"),
          storeAs: "eventStatus",
        }),
        runner.eventAndRunUntilIdle({
          workflow: "events",
          instanceId: "event-1",
          event: { type: "ready", payload: { ok: true } },
        }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("events", "event-1"),
          storeAs: "eventFinal",
        }),
        workflow.read({
          read: (ctx) => ctx.state.getHistory("sleep", "sleep-1", { order: "asc", pageSize: 50 }),
          storeAs: "sleepHistory",
        }),
        workflow.read({
          read: (ctx) =>
            ctx.state.internal.getHooks({
              hookName: "onWorkflowEnqueued",
              workflowName: "sleep-workflow",
              instanceId: "sleep-1",
            }),
          storeAs: "hooks",
        }),
        workflow.assert((ctx) => {
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

  test("treats repeated event ids as idempotent sends", async () => {
    const workflows = {
      events: EventWorkflow,
    };

    type ScenarioVars = {
      eventsBeforeRun?: WorkflowScenarioEventRow[];
      statusAfterDuplicate?: { status: string };
      finalStatus?: { status: string };
      eventsAfterRun?: WorkflowScenarioEventRow[];
    };

    const scenario = defineScenario<typeof workflows, ScenarioVars>({
      name: "event-idempotency",
      workflows,
      steps: ({ workflow, runner }) => [
        runner.initializeAndRunUntilIdle({
          workflow: "events",
          id: "event-idempotency-1",
        }),
        workflow.event({
          workflow: "events",
          instanceId: "event-idempotency-1",
          event: { id: "evt-ready-1", type: "ready", payload: { ok: true } },
        }),
        workflow.event({
          workflow: "events",
          instanceId: "event-idempotency-1",
          event: { id: "evt-ready-1", type: "ready", payload: { ok: true } },
          storeAs: "statusAfterDuplicate",
        }),
        workflow.read({
          read: (ctx) => ctx.state.getEvents("events", "event-idempotency-1"),
          storeAs: "eventsBeforeRun",
        }),
        runner.runUntilIdle({
          workflow: "events",
          instanceId: "event-idempotency-1",
          reason: "event",
        }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("events", "event-idempotency-1"),
          storeAs: "finalStatus",
        }),
        workflow.event({
          workflow: "events",
          instanceId: "event-idempotency-1",
          event: { id: "evt-ready-1", type: "ready", payload: { ok: true } },
        }),
        workflow.read({
          read: (ctx) => ctx.state.getEvents("events", "event-idempotency-1"),
          storeAs: "eventsAfterRun",
        }),
        workflow.assert((ctx) => {
          expect(ctx.vars.statusAfterDuplicate?.status).toBe("waiting");
          expect(ctx.vars.eventsBeforeRun).toHaveLength(1);
          expect(ctx.vars.finalStatus?.status).toBe("complete");
          expect(ctx.vars.eventsAfterRun).toHaveLength(1);
          expect(ctx.vars.eventsAfterRun?.[0]?.consumedByStepKey).toBe("waitForEvent:ready");
        }),
      ],
    });

    await runScenario(scenario);
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

    const scenario = defineScenario<typeof workflows, RetryVars>({
      name: "retry-delay",
      workflows,
      harness: { runtime, adapter: { type: "in-memory" } },
      steps: ({ workflow, runner }) => [
        runner.initializeAndRunUntilIdle({
          workflow: "retry",
          id: "retry-1",
        }),
        workflow.read({
          read: (ctx) => ctx.state.getSteps("retry", "retry-1"),
          storeAs: "steps",
        }),
        workflow.assert((ctx) => {
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
