import { describe, expect, test } from "vitest";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "./workflow";
import { createWorkflowsTestHarness, type WorkflowsTestClock } from "./test";

class SleepWorkflow extends WorkflowEntrypoint<unknown, { note: string }> {
  async run(event: WorkflowEvent<{ note: string }>, step: WorkflowStep) {
    await step.sleep("sleep", "1 hour");
    return { note: event.payload.note };
  }
}

class EventWorkflow extends WorkflowEntrypoint {
  async run(_event: WorkflowEvent<unknown>, step: WorkflowStep) {
    return await step.waitForEvent("ready", { type: "ready", timeout: "2 hours" });
  }
}

describe("createWorkflowsTestHarness", () => {
  test("drives workflows with a controllable clock", async () => {
    const workflows = {
      sleep: { name: "sleep-workflow", workflow: SleepWorkflow },
      events: { name: "event-workflow", workflow: EventWorkflow },
    };

    const harness = await createWorkflowsTestHarness({
      workflows,
      adapter: { type: "drizzle-pglite" },
    });

    const sleepId = await harness.createInstance("sleep", { params: { note: "alpha" } });
    await harness.runUntilIdle();

    let status = await harness.getStatus("sleep", sleepId);
    expect(status.status).toBe("waiting");

    harness.clock.advanceBy("1 hour");
    await harness.runUntilIdle();

    status = await harness.getStatus("sleep", sleepId);
    expect(status.status).toBe("complete");

    const eventId = await harness.createInstance("events");
    await harness.runUntilIdle();

    status = await harness.getStatus("events", eventId);
    expect(status.status).toBe("waiting");

    await harness.sendEvent("events", eventId, { type: "ready", payload: { ok: true } });
    await harness.runUntilIdle();

    status = await harness.getStatus("events", eventId);
    expect(status.status).toBe("complete");
  });

  test("schedules retries relative to failure time", async () => {
    let attempts = 0;
    let testClock: WorkflowsTestClock | null = null;

    class RetryDelayWorkflow extends WorkflowEntrypoint {
      async run(_event: WorkflowEvent<unknown>, step: WorkflowStep) {
        return await step.do(
          "retry-delay",
          { retries: { limit: 1, delay: 60_000, backoff: "constant" } },
          () => {
            attempts += 1;
            if (attempts === 1) {
              if (!testClock) {
                throw new Error("Missing test clock");
              }
              testClock.advanceBy(5 * 60_000);
              throw new Error("RETRY_ME");
            }
            return { ok: true };
          },
        );
      }
    }

    const workflows = {
      retryDelay: { name: "retry-delay-workflow", workflow: RetryDelayWorkflow },
    };

    const harness = await createWorkflowsTestHarness({
      workflows,
      adapter: { type: "drizzle-pglite" },
    });
    testClock = harness.clock;

    const startMs = testClock.now().getTime();
    await harness.createInstance("retryDelay");
    await harness.runUntilIdle();

    const nowMs = testClock.now().getTime();
    expect(nowMs - startMs).toBe(5 * 60_000);

    const [step] = await harness.db.find("workflow_step", (b) => b.whereIndex("primary"));
    expect(step?.status).toBe("waiting");
    expect(step?.nextRetryAt).toBeInstanceOf(Date);
    expect(step?.nextRetryAt?.getTime()).toBe(nowMs + 60_000);
  });
});
