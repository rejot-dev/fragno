import { describe, expect, test } from "vitest";
import { buildDatabaseFragmentsTest } from "@fragno-dev/test";
import {
  defineWorkflow,
  type WorkflowEnqueuedHookPayload,
  type WorkflowEvent,
  type WorkflowStep,
} from "./workflow";
import { createWorkflowsTestHarness, type WorkflowsTestClock } from "./test";

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

describe.skip("createWorkflowsTestHarness (skipped: new runner in progress)", () => {
  const buildPayload = (
    instance: {
      id: { internalId?: bigint };
      instanceId: string;
      workflowName: string;
      runNumber: number;
    },
    reason: WorkflowEnqueuedHookPayload["reason"],
  ): WorkflowEnqueuedHookPayload => {
    if (!instance.id.internalId) {
      throw new Error("Missing instance ref");
    }
    return {
      workflowName: instance.workflowName,
      instanceId: instance.instanceId,
      instanceRef: instance.id.internalId.toString(),
      runNumber: instance.runNumber,
      reason,
    };
  };

  test("drives workflows with a controllable clock", async () => {
    const workflows = {
      sleep: SleepWorkflow,
      events: EventWorkflow,
    };

    const harness = await createWorkflowsTestHarness({
      workflows,
      adapter: { type: "in-memory" },
      testBuilder: buildDatabaseFragmentsTest(),
    });

    const sleepId = await harness.createInstance("sleep", { params: { note: "alpha" } });
    const [sleepInstance] = await harness.db.find("workflow_instance", (b) =>
      b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
        eb.and(eb("workflowName", "=", "sleep-workflow"), eb("instanceId", "=", sleepId)),
      ),
    );
    if (!sleepInstance) {
      throw new Error("Missing sleep instance");
    }
    await harness.runUntilIdle(buildPayload(sleepInstance, "create"));

    let sleepStatus = await harness.getStatus("sleep", sleepId);
    expect(sleepStatus.status).toBe("waiting");

    harness.clock.advanceBy("1 hour");
    await harness.runUntilIdle(buildPayload(sleepInstance, "wake"));

    sleepStatus = await harness.getStatus("sleep", sleepId);
    expect(sleepStatus.status).toBe("complete");

    const eventId = await harness.createInstance("events");
    const [eventInstance] = await harness.db.find("workflow_instance", (b) =>
      b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
        eb.and(eb("workflowName", "=", "event-workflow"), eb("instanceId", "=", eventId)),
      ),
    );
    if (!eventInstance) {
      throw new Error("Missing event instance");
    }
    await harness.runUntilIdle(buildPayload(eventInstance, "create"));

    let eventStatus = await harness.getStatus("events", eventId);
    expect(eventStatus.status).toBe("waiting");

    await harness.sendEvent("events", eventId, { type: "ready", payload: { ok: true } });
    await harness.runUntilIdle(buildPayload(eventInstance, "event"));

    eventStatus = await harness.getStatus("events", eventId);
    expect(eventStatus.status).toBe("complete");
  });

  test("schedules retries relative to failure time", async () => {
    let attempts = 0;
    let testClock: WorkflowsTestClock | null = null;

    const RetryDelayWorkflow = defineWorkflow(
      { name: "retry-delay-workflow" },
      async (_event: WorkflowEvent<unknown>, step: WorkflowStep) => {
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
      },
    );

    const workflows = {
      retryDelay: RetryDelayWorkflow,
    };

    const harness = await createWorkflowsTestHarness({
      workflows,
      adapter: { type: "in-memory" },
      testBuilder: buildDatabaseFragmentsTest(),
    });
    testClock = harness.clock;

    const startMs = testClock.now().getTime();
    const retryId = await harness.createInstance("retryDelay");
    const [retryInstance] = await harness.db.find("workflow_instance", (b) =>
      b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
        eb.and(eb("workflowName", "=", "retry-delay-workflow"), eb("instanceId", "=", retryId)),
      ),
    );
    if (!retryInstance) {
      throw new Error("Missing retry instance");
    }
    await harness.runUntilIdle(buildPayload(retryInstance, "create"));

    const nowMs = testClock.now().getTime();
    expect(nowMs - startMs).toBe(5 * 60_000);

    const [step] = await harness.db.find("workflow_step", (b) => b.whereIndex("primary"));
    expect(step?.status).toBe("waiting");
    expect(step?.nextRetryAt).toBeInstanceOf(Date);
    expect(step?.nextRetryAt?.getTime()).toBe(nowMs + 60_000);
  });
});
