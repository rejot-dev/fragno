import { beforeEach, describe, expect, test, vi } from "vitest";
import { buildDatabaseFragmentsTest } from "@fragno-dev/test";
import type { TxResult } from "@fragno-dev/db";
import { instantiate } from "@fragno-dev/core";
import { workflowsFragmentDefinition } from "./definition";

describe("Workflows Fragment Services", async () => {
  const dispatcher = {
    wake: vi.fn(),
  };

  const { fragments, test: testContext } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "drizzle-pglite" })
    .withFragment(
      "workflows",
      instantiate(workflowsFragmentDefinition).withConfig({
        dispatcher,
      }),
    )
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
    dispatcher.wake.mockReset();
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

  test("createInstance should trigger dispatcher wake hook", async () => {
    await runService(() =>
      fragment.services.createInstance("demo-workflow", {
        id: "hook-1",
      }),
    );

    expect(dispatcher.wake).toHaveBeenCalledTimes(1);
    expect(dispatcher.wake).toHaveBeenCalledWith({
      workflowName: "demo-workflow",
      instanceId: "hook-1",
      reason: "create",
    });
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

  test("terminate should mark instance as terminated", async () => {
    const created = await runService<{ id: string }>(() =>
      fragment.services.createInstance("demo-workflow", { id: "terminate-1" }),
    );
    dispatcher.wake.mockClear();

    const terminated = await runService<{ status: string }>(() =>
      fragment.services.terminateInstance("demo-workflow", created.id),
    );

    expect(terminated.status).toBe("terminated");

    const [instance] = await db.find("workflow_instance", (b) => b.whereIndex("primary"));
    expect(instance).toMatchObject({
      workflowName: "demo-workflow",
      instanceId: created.id,
      status: "terminated",
      pauseRequested: false,
    });
    expect(instance.completedAt).toBeInstanceOf(Date);
    expect(dispatcher.wake).not.toHaveBeenCalled();
  });

  test("restart should enqueue new run and reset instance state", async () => {
    const created = await runService<{ id: string }>(() =>
      fragment.services.createInstance("demo-workflow", { id: "restart-1" }),
    );

    const [instance] = await db.find("workflow_instance", (b) => b.whereIndex("primary"));
    await db.update("workflow_instance", instance.id, (b) =>
      b.set({
        status: "complete",
        output: { ok: true },
        errorName: "SomethingWrong",
        errorMessage: "bad",
        completedAt: new Date(),
      }),
    );
    dispatcher.wake.mockClear();

    const restarted = await runService<{ status: string }>(() =>
      fragment.services.restartInstance("demo-workflow", created.id),
    );

    expect(restarted.status).toBe("queued");

    const [restartedInstance] = await db.find("workflow_instance", (b) => b.whereIndex("primary"));
    expect(restartedInstance).toMatchObject({
      workflowName: "demo-workflow",
      instanceId: created.id,
      status: "queued",
      pauseRequested: false,
      runNumber: 1,
      output: null,
      errorName: null,
      errorMessage: null,
      startedAt: null,
      completedAt: null,
    });

    const tasks = await db.find("workflow_task", (b) => b.whereIndex("primary"));
    const restartTask = tasks.find((task) => task.runNumber === 1 && task.kind === "run");
    expect(restartTask).toMatchObject({
      workflowName: "demo-workflow",
      instanceId: created.id,
      status: "pending",
    });

    expect(dispatcher.wake).toHaveBeenCalledTimes(1);
    expect(dispatcher.wake).toHaveBeenCalledWith({
      workflowName: "demo-workflow",
      instanceId: created.id,
      reason: "create",
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

    expect(dispatcher.wake).toHaveBeenCalledWith({
      workflowName: "demo-workflow",
      instanceId: created.id,
      reason: "event",
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

  test("getInstanceRunNumber should return current run", async () => {
    await db.create("workflow_instance", {
      workflowName: "demo-workflow",
      instanceId: "history-1",
      status: "queued",
      params: {},
      pauseRequested: false,
      retentionUntil: null,
      runNumber: 3,
      startedAt: null,
      completedAt: null,
      output: null,
      errorName: null,
      errorMessage: null,
    });

    const runNumber = await runService<number>(() =>
      fragment.services.getInstanceRunNumber("demo-workflow", "history-1"),
    );

    expect(runNumber).toBe(3);
  });

  test("listHistory should return steps and events for a run", async () => {
    await db.create("workflow_instance", {
      workflowName: "demo-workflow",
      instanceId: "history-2",
      status: "queued",
      params: {},
      pauseRequested: false,
      retentionUntil: null,
      runNumber: 1,
      startedAt: null,
      completedAt: null,
      output: null,
      errorName: null,
      errorMessage: null,
    });

    await db.create("workflow_step", {
      workflowName: "demo-workflow",
      instanceId: "history-2",
      runNumber: 1,
      stepKey: "step-1",
      name: "Step One",
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

    await db.create("workflow_step", {
      workflowName: "demo-workflow",
      instanceId: "history-2",
      runNumber: 1,
      stepKey: "step-2",
      name: "Step Two",
      type: "sleep",
      status: "waiting",
      attempts: 0,
      maxAttempts: 1,
      timeoutMs: null,
      nextRetryAt: null,
      wakeAt: new Date(Date.now() + 60_000),
      waitEventType: null,
      result: null,
      errorName: null,
      errorMessage: null,
    });

    await db.create("workflow_event", {
      workflowName: "demo-workflow",
      instanceId: "history-2",
      runNumber: 1,
      type: "approval",
      payload: { approved: true },
      deliveredAt: null,
      consumedByStepKey: null,
    });

    await db.create("workflow_event", {
      workflowName: "demo-workflow",
      instanceId: "history-2",
      runNumber: 1,
      type: "note",
      payload: { note: "extra" },
      deliveredAt: null,
      consumedByStepKey: null,
    });

    const history = await runService<{
      runNumber: number;
      steps: Array<{ stepKey: string }>;
      events: Array<{ type: string }>;
      stepsHasNextPage: boolean;
      eventsHasNextPage: boolean;
    }>(() =>
      fragment.services.listHistory({
        workflowName: "demo-workflow",
        instanceId: "history-2",
        runNumber: 1,
        pageSize: 1,
      }),
    );

    expect(history.runNumber).toBe(1);
    expect(history.steps).toHaveLength(1);
    expect(history.events).toHaveLength(1);
    expect(history.stepsHasNextPage).toBe(true);
    expect(history.eventsHasNextPage).toBe(true);
    expect(history.steps[0]?.stepKey).toBeTruthy();
    expect(history.events[0]?.type).toBeTruthy();
  });
});
