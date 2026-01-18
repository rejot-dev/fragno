import { beforeEach, describe, expect, test } from "vitest";
import { buildDatabaseFragmentsTest } from "@fragno-dev/test";
import { instantiate } from "@fragno-dev/core";
import { workflowsFragmentDefinition } from "./definition";
import { createWorkflowsRunner } from "./runner";
import type { WorkflowEvent, WorkflowStep } from "./workflow";
import { WorkflowEntrypoint } from "./workflow";
import { workflowsRoutesFactory } from "./routes";

describe("Workflows Runner", async () => {
  let doCallCount = 0;
  let concurrentCallCount = 0;
  let priorityOrder: string[] = [];

  class DemoWorkflow extends WorkflowEntrypoint<unknown, { count: number }> {
    async run(event: WorkflowEvent<{ count: number }>, step: WorkflowStep) {
      const first = await step.do("calc", () => {
        doCallCount += 1;
        return { count: event.payload.count + 1 };
      });
      const second = await step.do("calc", () => {
        doCallCount += 1;
        return { count: 999 };
      });
      return { first, second };
    }
  }

  class EventWorkflow extends WorkflowEntrypoint {
    async run(_event: WorkflowEvent<unknown>, step: WorkflowStep) {
      return await step.waitForEvent("wait-ready", { type: "ready", timeout: "1 hour" });
    }
  }

  class SlowWorkflow extends WorkflowEntrypoint {
    async run(_event: WorkflowEvent<unknown>, step: WorkflowStep) {
      return await step.do("slow-step", async () => {
        await new Promise((resolve) => setTimeout(resolve, 250));
        return { ok: true };
      });
    }
  }

  class ConcurrentWorkflow extends WorkflowEntrypoint {
    async run(_event: WorkflowEvent<unknown>, step: WorkflowStep) {
      return await step.do("single-run", async () => {
        concurrentCallCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { ok: true };
      });
    }
  }

  class PauseSleepWorkflow extends WorkflowEntrypoint {
    async run(_event: WorkflowEvent<unknown>, step: WorkflowStep) {
      await step.sleep("pause-sleep", "50 ms");
      return { ok: true };
    }
  }

  class PriorityWorkflow extends WorkflowEntrypoint {
    async run(event: WorkflowEvent<unknown>, step: WorkflowStep) {
      return await step.do("record-order", () => {
        priorityOrder.push(event.instanceId);
        return { ok: true };
      });
    }
  }

  const workflows = {
    demo: { name: "demo-workflow", workflow: DemoWorkflow },
    events: { name: "event-workflow", workflow: EventWorkflow },
    slow: { name: "slow-workflow", workflow: SlowWorkflow },
    concurrent: { name: "concurrent-workflow", workflow: ConcurrentWorkflow },
    pauseSleep: { name: "pause-sleep-workflow", workflow: PauseSleepWorkflow },
    priority: { name: "priority-workflow", workflow: PriorityWorkflow },
  };

  const { fragments, test: testContext } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "drizzle-pglite" })
    .withFragment(
      "workflows",
      instantiate(workflowsFragmentDefinition)
        .withConfig({
          workflows,
        })
        .withRoutes([workflowsRoutesFactory]),
    )
    .build();

  const { fragment, db } = fragments.workflows;
  const runner = createWorkflowsRunner({ db, workflows });

  const createInstance = async (workflowName: string, params: unknown) => {
    const response = await fragment.callRoute("POST", "/workflows/:workflowName/instances", {
      pathParams: { workflowName },
      body: { params },
    });
    if (response.type !== "json") {
      throw new Error("Expected json response");
    }
    return response.data.id as string;
  };

  beforeEach(async () => {
    await testContext.resetDatabase();
    doCallCount = 0;
    concurrentCallCount = 0;
    priorityOrder = [];
  });

  test("tick should execute workflow and reuse cached steps", async () => {
    const id = await createInstance("demo-workflow", { count: 1 });

    const processed = await runner.tick({ maxInstances: 1, maxSteps: 10 });
    expect(processed).toBe(1);

    const instance = await db.findFirst("workflow_instance", (b) =>
      b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
        eb.and(eb("workflowName", "=", "demo-workflow"), eb("instanceId", "=", id)),
      ),
    );

    expect(instance?.status).toBe("complete");
    expect(instance?.output).toEqual({
      first: { count: 2 },
      second: { count: 2 },
    });
    expect(doCallCount).toBe(1);

    const steps = await db.find("workflow_step", (b) => b.whereIndex("primary"));
    expect(steps).toHaveLength(1);
    expect(steps[0].status).toBe("completed");
  });

  test("tick should consume buffered events for waitForEvent", async () => {
    const id = await createInstance("event-workflow", {});

    await db.create("workflow_event", {
      workflowName: "event-workflow",
      instanceId: id,
      runNumber: 0,
      type: "ready",
      payload: { ok: true },
      deliveredAt: null,
      consumedByStepKey: null,
    });

    const processed = await runner.tick({ maxInstances: 1, maxSteps: 5 });
    expect(processed).toBe(1);

    const instance = await db.findFirst("workflow_instance", (b) =>
      b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
        eb.and(eb("workflowName", "=", "event-workflow"), eb("instanceId", "=", id)),
      ),
    );

    expect(instance?.status).toBe("complete");
    expect(instance?.output).toEqual({
      type: "ready",
      payload: { ok: true },
      timestamp: expect.any(String),
    });

    const [event] = await db.find("workflow_event", (b) => b.whereIndex("primary"));
    expect(event.deliveredAt).toBeInstanceOf(Date);
    expect(event.consumedByStepKey).toBe("wait-ready");
  });

  test("tick should renew task lease while executing", async () => {
    const leaseMs = 100;
    const leaseRunner = createWorkflowsRunner({
      db,
      workflows,
      leaseMs,
      runnerId: "lease-runner",
    });

    const id = await createInstance("slow-workflow", {});

    const tickPromise = leaseRunner.tick({ maxInstances: 1, maxSteps: 5 });

    const fetchTask = () =>
      db.findFirst("workflow_task", (b) =>
        b.whereIndex("idx_workflow_task_workflowName_instanceId_runNumber", (eb) =>
          eb.and(
            eb("workflowName", "=", "slow-workflow"),
            eb("instanceId", "=", id),
            eb("runNumber", "=", 0),
          ),
        ),
      );

    let initialTask: Awaited<ReturnType<typeof fetchTask>> = null;
    const startWait = Date.now();
    while (!initialTask && Date.now() - startWait < 500) {
      const candidate = await fetchTask();
      if (candidate?.lockOwner === "lease-runner") {
        initialTask = candidate;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(initialTask).not.toBeNull();
    expect(initialTask?.lockOwner).toBe("lease-runner");
    expect(initialTask?.lockedUntil).toBeInstanceOf(Date);

    await new Promise((resolve) => setTimeout(resolve, leaseMs + 60));

    const renewedTask = await fetchTask();
    expect(renewedTask).not.toBeNull();
    expect(renewedTask?.lockOwner).toBe("lease-runner");
    expect(renewedTask?.lockedUntil?.getTime()).toBeGreaterThan(
      initialTask?.lockedUntil?.getTime() ?? 0,
    );

    await tickPromise;
  });

  test("concurrent ticks should only process a task once", async () => {
    const id = await createInstance("concurrent-workflow", {});

    const runnerA = createWorkflowsRunner({
      db,
      workflows,
      runnerId: "runner-a",
    });
    const runnerB = createWorkflowsRunner({
      db,
      workflows,
      runnerId: "runner-b",
    });

    const [processedA, processedB] = await Promise.all([
      runnerA.tick({ maxInstances: 1, maxSteps: 5 }),
      runnerB.tick({ maxInstances: 1, maxSteps: 5 }),
    ]);

    expect(processedA + processedB).toBe(1);
    expect(concurrentCallCount).toBe(1);

    const instance = await db.findFirst("workflow_instance", (b) =>
      b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
        eb.and(eb("workflowName", "=", "concurrent-workflow"), eb("instanceId", "=", id)),
      ),
    );

    expect(instance?.status).toBe("complete");
  });

  test("tick should prioritize wake/retry/resume before run tasks", async () => {
    const now = new Date();
    const createInstanceRecord = (instanceId: string) =>
      db.create("workflow_instance", {
        workflowName: "priority-workflow",
        instanceId,
        status: "queued",
        params: {},
        pauseRequested: false,
        retentionUntil: null,
        runNumber: 0,
        startedAt: null,
        completedAt: null,
        output: null,
        errorName: null,
        errorMessage: null,
      });

    await Promise.all([
      createInstanceRecord("run-1"),
      createInstanceRecord("wake-1"),
      createInstanceRecord("retry-1"),
      createInstanceRecord("resume-1"),
    ]);

    const createTask = (instanceId: string, kind: "run" | "wake" | "retry" | "resume") =>
      db.create("workflow_task", {
        workflowName: "priority-workflow",
        instanceId,
        runNumber: 0,
        kind,
        runAt: now,
        status: "pending",
        attempts: 0,
        maxAttempts: 1,
        lastError: null,
        lockedUntil: null,
        lockOwner: null,
      });

    await Promise.all([
      createTask("run-1", "run"),
      createTask("wake-1", "wake"),
      createTask("retry-1", "retry"),
      createTask("resume-1", "resume"),
    ]);

    for (let i = 0; i < 4; i += 1) {
      const processed = await runner.tick({ maxInstances: 1, maxSteps: 5 });
      expect(processed).toBe(1);
    }

    expect(priorityOrder).toEqual(["wake-1", "retry-1", "resume-1", "run-1"]);
  });

  test("pause should not freeze sleep timers", async () => {
    const id = await createInstance("pause-sleep-workflow", {});

    const processed = await runner.tick({ maxInstances: 1, maxSteps: 5 });
    expect(processed).toBe(1);

    const waiting = await db.findFirst("workflow_instance", (b) =>
      b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
        eb.and(
          eb("workflowName", "=", "pause-sleep-workflow"),
          eb("instanceId", "=", id),
        ),
      ),
    );

    expect(waiting?.status).toBe("waiting");

    await fragment.callRoute("POST", "/workflows/:workflowName/instances/:instanceId/pause", {
      pathParams: { workflowName: "pause-sleep-workflow", instanceId: id },
    });

    await new Promise((resolve) => setTimeout(resolve, 80));

    await fragment.callRoute("POST", "/workflows/:workflowName/instances/:instanceId/resume", {
      pathParams: { workflowName: "pause-sleep-workflow", instanceId: id },
    });

    const resumedProcessed = await runner.tick({ maxInstances: 1, maxSteps: 5 });
    expect(resumedProcessed).toBe(1);

    const completed = await db.findFirst("workflow_instance", (b) =>
      b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
        eb.and(
          eb("workflowName", "=", "pause-sleep-workflow"),
          eb("instanceId", "=", id),
        ),
      ),
    );

    expect(completed?.status).toBe("complete");
    expect(completed?.output).toEqual({ ok: true });

    const [step] = await db.find("workflow_step", (b) => b.whereIndex("primary"));
    expect(step).toMatchObject({ stepKey: "pause-sleep", status: "completed" });
  });
});
