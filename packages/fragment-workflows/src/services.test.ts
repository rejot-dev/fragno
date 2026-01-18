import { beforeEach, describe, expect, test } from "vitest";
import { buildDatabaseFragmentsTest } from "@fragno-dev/test";
import type { TxResult } from "@fragno-dev/db";
import { instantiate } from "@fragno-dev/core";
import { workflowsFragmentDefinition } from "./definition";

describe("Workflows Fragment Services", async () => {
  const { fragments, test: testContext } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "drizzle-pglite" })
    .withFragment("workflows", instantiate(workflowsFragmentDefinition))
    .build();

  const { fragment, db } = fragments.workflows;

  const runService = <T>(call: () => unknown) =>
    fragment.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [call() as TxResult<unknown, unknown>] as const)
        .transform(({ serviceResult: [result] }) => result)
        .execute();
    }) as Promise<T>;

  beforeEach(async () => {
    await testContext.resetDatabase();
  });

  test("createInstance should create instance and task records", async () => {
    const result = await runService<{ id: string; details: { status: string } }>(() =>
      fragment.services.createInstance("demo-workflow", {
        params: { source: "service-test" },
      }),
    );

    expect(result.id).toBeTruthy();
    expect(result.details.status).toBe("queued");

    const [instance] = await db.find("workflow_instance", (b) => b.whereIndex("primary"));
    const [task] = await db.find("workflow_task", (b) => b.whereIndex("primary"));

    expect(instance).toMatchObject({
      workflowName: "demo-workflow",
      instanceId: result.id,
      status: "queued",
      pauseRequested: false,
      runNumber: 0,
    });
    expect(task).toMatchObject({
      workflowName: "demo-workflow",
      instanceId: result.id,
      runNumber: 0,
      kind: "run",
      status: "pending",
      attempts: 0,
    });
    expect(task.runAt).toBeInstanceOf(Date);
  });

  test("createBatch should skip existing instance IDs", async () => {
    const existing = await runService<{ id: string }>(() =>
      fragment.services.createInstance("demo-workflow", {
        id: "existing-1",
      }),
    );

    const created = await runService<{ id: string }[]>(() =>
      fragment.services.createBatch("demo-workflow", [
        { id: existing.id },
        { id: "fresh-1", params: { source: "batch" } },
      ]),
    );

    expect(created).toHaveLength(1);
    expect(created[0].id).toBe("fresh-1");

    const instances = await db.find("workflow_instance", (b) => b.whereIndex("primary"));
    expect(instances).toHaveLength(2);
  });

  test("pause and resume should update status and task", async () => {
    const created = await runService<{ id: string }>(() =>
      fragment.services.createInstance("demo-workflow", { id: "pause-1" }),
    );

    const paused = await runService<{ status: string }>(() =>
      fragment.services.pauseInstance("demo-workflow", created.id),
    );
    expect(paused.status).toBe("paused");

    const resumed = await runService<{ status: string }>(() =>
      fragment.services.resumeInstance("demo-workflow", created.id),
    );
    expect(resumed.status).toBe("queued");

    const [task] = await db.find("workflow_task", (b) => b.whereIndex("primary"));
    expect(task).toMatchObject({
      workflowName: "demo-workflow",
      instanceId: created.id,
      kind: "resume",
      status: "pending",
    });
  });

  test("sendEvent should buffer and wake waiting instance", async () => {
    const created = await runService<{ id: string }>(() =>
      fragment.services.createInstance("demo-workflow", { id: "event-1" }),
    );
    const [instance] = await db.find("workflow_instance", (b) => b.whereIndex("primary"));

    await db.update("workflow_instance", instance.id, (b) =>
      b.set({ status: "waiting", updatedAt: new Date() }),
    );

    await db.create("workflow_step", {
      workflowName: "demo-workflow",
      instanceId: created.id,
      runNumber: 0,
      stepKey: "wait-1",
      name: "Wait for approval",
      type: "waitForEvent",
      status: "waiting",
      attempts: 0,
      maxAttempts: 1,
      timeoutMs: null,
      nextRetryAt: null,
      wakeAt: null,
      waitEventType: "approval",
      result: null,
      errorName: null,
      errorMessage: null,
    });

    const status = await runService<{ status: string }>(() =>
      fragment.services.sendEvent("demo-workflow", created.id, {
        type: "approval",
        payload: { approved: true },
      }),
    );

    expect(status.status).toBe("waiting");

    const [event] = await db.find("workflow_event", (b) => b.whereIndex("primary"));
    expect(event).toMatchObject({
      workflowName: "demo-workflow",
      instanceId: created.id,
      type: "approval",
      payload: { approved: true },
    });

    const [task] = await db.find("workflow_task", (b) => b.whereIndex("primary"));
    expect(task).toMatchObject({
      workflowName: "demo-workflow",
      instanceId: created.id,
      kind: "wake",
      status: "pending",
    });
  });

  test("sendEvent should reject terminal instances", async () => {
    const created = await runService<{ id: string }>(() =>
      fragment.services.createInstance("demo-workflow", { id: "event-2" }),
    );
    const [instance] = await db.find("workflow_instance", (b) => b.whereIndex("primary"));

    await db.update("workflow_instance", instance.id, (b) =>
      b.set({ status: "complete", updatedAt: new Date() }),
    );

    await expect(
      runService(() => fragment.services.sendEvent("demo-workflow", created.id, { type: "noop" })),
    ).rejects.toThrow("INSTANCE_TERMINAL");
  });
});
