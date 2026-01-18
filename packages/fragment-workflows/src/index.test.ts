import { beforeEach, describe, expect, test } from "vitest";
import { buildDatabaseFragmentsTest } from "@fragno-dev/test";
import { instantiate } from "@fragno-dev/core";
import { workflowsFragmentDefinition } from "./definition";
import { workflowsSchema } from "./schema";
import { NonRetryableError } from "./workflow";

describe("Workflows Fragment", async () => {
  const { fragments, test: testContext } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "drizzle-pglite" })
    .withFragment("workflows", instantiate(workflowsFragmentDefinition))
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
});
