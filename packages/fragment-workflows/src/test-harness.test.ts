import { describe, expect, test } from "vitest";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "./workflow";
import { createWorkflowsTestHarness } from "./test";

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
});
