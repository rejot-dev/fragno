import { assert, beforeEach, describe, expect, test } from "vitest";
import { buildDatabaseFragmentsTest } from "@fragno-dev/test";
import { instantiate } from "@fragno-dev/core";
import { workflowsFragmentDefinition } from "./definition";
import { workflowsRoutesFactory } from "./routes";
import { workflowsSchema } from "./schema";
import { NonRetryableError, WorkflowEntrypoint } from "./workflow";
import type { WorkflowEvent, WorkflowStep } from "./workflow";

describe("Workflows Fragment", async () => {
  class DemoWorkflow extends WorkflowEntrypoint {
    run(_event: WorkflowEvent<unknown>, _step: WorkflowStep) {
      return undefined;
    }
  }

  const workflows = {
    DEMO: { name: "demo-workflow", workflow: DemoWorkflow },
  } as const;

  const { fragments, test: testContext } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "drizzle-pglite" })
    .withFragment(
      "workflows",
      instantiate(workflowsFragmentDefinition)
        .withConfig({ workflows })
        .withRoutes([workflowsRoutesFactory]),
    )
    .build();

  const { fragment, db } = fragments.workflows;

  beforeEach(async () => {
    await testContext.resetDatabase();
  });

  test("should expose workflows schema", () => {
    expect(fragment.$internal.deps.schema).toBe(workflowsSchema);
    expect(fragment.$internal.deps.namespace).toBe("workflows");
  });

  test("should persist workflow records", async () => {
    const workflowName = "demo-workflow";
    const instanceId = "instance-1";

    await db.create("workflow_instance", {
      instanceId,
      workflowName,
      status: "pending",
      params: { source: "tests" },
      pauseRequested: false,
      retentionUntil: null,
      runNumber: 0,
    });

    await db.create("workflow_step", {
      workflowName,
      instanceId,
      runNumber: 0,
      stepKey: "step-1",
      name: "Start",
      type: "do",
      status: "completed",
      attempts: 1,
      maxAttempts: 3,
      timeoutMs: null,
      nextRetryAt: null,
      wakeAt: null,
      waitEventType: null,
      result: { ok: true },
      errorName: null,
      errorMessage: null,
    });

    await db.create("workflow_event", {
      workflowName,
      instanceId,
      runNumber: 0,
      type: "approval",
      payload: { approved: true },
      deliveredAt: null,
      consumedByStepKey: null,
    });

    await db.create("workflow_task", {
      workflowName,
      instanceId,
      runNumber: 0,
      kind: "run",
      runAt: new Date(),
      status: "pending",
      maxAttempts: 5,
      lastError: null,
      lockedUntil: null,
      lockOwner: null,
    });

    const [instance] = await db.find("workflow_instance", (b) => b.whereIndex("primary"));
    const [step] = await db.find("workflow_step", (b) => b.whereIndex("primary"));
    const [event] = await db.find("workflow_event", (b) => b.whereIndex("primary"));
    const [task] = await db.find("workflow_task", (b) => b.whereIndex("primary"));

    expect(instance).toMatchObject({
      workflowName,
      instanceId,
      status: "pending",
      params: { source: "tests" },
      pauseRequested: false,
      retentionUntil: null,
      runNumber: 0,
    });
    expect(instance.createdAt).toBeInstanceOf(Date);
    expect(instance.updatedAt).toBeInstanceOf(Date);

    expect(step).toMatchObject({
      workflowName,
      instanceId,
      runNumber: 0,
      stepKey: "step-1",
      name: "Start",
      type: "do",
      status: "completed",
      attempts: 1,
      maxAttempts: 3,
      timeoutMs: null,
      nextRetryAt: null,
      wakeAt: null,
      waitEventType: null,
      result: { ok: true },
      errorName: null,
      errorMessage: null,
    });
    expect(step.createdAt).toBeInstanceOf(Date);
    expect(step.updatedAt).toBeInstanceOf(Date);

    expect(event).toMatchObject({
      workflowName,
      instanceId,
      runNumber: 0,
      type: "approval",
      payload: { approved: true },
      deliveredAt: null,
      consumedByStepKey: null,
    });
    expect(event.createdAt).toBeInstanceOf(Date);

    expect(task).toMatchObject({
      workflowName,
      instanceId,
      runNumber: 0,
      kind: "run",
      status: "pending",
      attempts: 0,
      maxAttempts: 5,
      lastError: null,
      lockedUntil: null,
      lockOwner: null,
    });
    expect(task.runAt).toBeInstanceOf(Date);
    expect(task.createdAt).toBeInstanceOf(Date);
    expect(task.updatedAt).toBeInstanceOf(Date);
  });

  test("should expose NonRetryableError defaults", () => {
    const error = new NonRetryableError("no retry");

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("no retry");
    expect(error.name).toBe("NonRetryableError");
  });

  describe("Routes", () => {
    test("GET /workflows should list registered workflows", async () => {
      const response = await fragment.callRoute("GET", "/workflows");
      assert(response.type === "json");

      expect(response.data).toMatchObject({
        workflows: [{ name: "demo-workflow" }],
      });
    });

    test("POST /workflows/:workflowName/instances should create a workflow instance", async () => {
      const response = await fragment.callRoute("POST", "/workflows/:workflowName/instances", {
        pathParams: { workflowName: "demo-workflow" },
        body: { id: "route-1", params: { source: "route-test" } },
      });
      assert(response.type === "json");

      expect(response.data).toMatchObject({
        id: "route-1",
        details: { status: "queued" },
      });

      const [instance] = await db.find("workflow_instance", (b) => b.whereIndex("primary"));
      expect(instance).toMatchObject({
        workflowName: "demo-workflow",
        instanceId: "route-1",
      });
    });

    test("GET /workflows/:workflowName/instances/:instanceId/history should return history", async () => {
      await db.create("workflow_instance", {
        workflowName: "demo-workflow",
        instanceId: "history-route",
        status: "queued",
        params: {},
        pauseRequested: false,
        retentionUntil: null,
        runNumber: 2,
        startedAt: null,
        completedAt: null,
        output: null,
        errorName: null,
        errorMessage: null,
      });

      await db.create("workflow_step", {
        workflowName: "demo-workflow",
        instanceId: "history-route",
        runNumber: 2,
        stepKey: "step-1",
        name: "Example",
        type: "do",
        status: "completed",
        attempts: 1,
        maxAttempts: 1,
        timeoutMs: null,
        nextRetryAt: null,
        wakeAt: null,
        waitEventType: null,
        result: { ok: true },
        errorName: null,
        errorMessage: null,
      });

      await db.create("workflow_event", {
        workflowName: "demo-workflow",
        instanceId: "history-route",
        runNumber: 2,
        type: "approval",
        payload: { approved: true },
        deliveredAt: null,
        consumedByStepKey: null,
      });

      const response = await fragment.callRoute(
        "GET",
        "/workflows/:workflowName/instances/:instanceId/history",
        {
          pathParams: { workflowName: "demo-workflow", instanceId: "history-route" },
        },
      );

      assert(response.type === "json");
      expect(response.data.runNumber).toBe(2);
      expect(response.data.steps).toHaveLength(1);
      expect(response.data.events).toHaveLength(1);
    });
  });
});
