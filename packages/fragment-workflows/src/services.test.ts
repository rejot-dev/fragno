// Tests for workflow service APIs such as instance control, history, and events.
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { buildDatabaseFragmentsTest, drainDurableHooks } from "@fragno-dev/test";
import type { TxResult } from "@fragno-dev/db";
import { defaultFragnoRuntime, instantiate } from "@fragno-dev/core";
import { workflowsFragmentDefinition } from "./definition";
import type { WorkflowInstanceCurrentStep, WorkflowInstanceMetadata } from "./workflow";

describe("Workflows Fragment Services", () => {
  const runner = {
    tick: vi.fn(),
  };

  const setup = async () => {
    const { fragments, test: testContext } = await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "drizzle-pglite" })
      .withFragment(
        "workflows",
        instantiate(workflowsFragmentDefinition).withConfig({
          runner,
          runtime: defaultFragnoRuntime,
        }),
      )
      .build();

    const { fragment, db } = fragments.workflows;
    return { fragments, testContext, fragment, db };
  };

  type Setup = Awaited<ReturnType<typeof setup>>;

  let testContext: Setup["testContext"];
  let fragment: Setup["fragment"];
  let db: Setup["db"];

  beforeAll(async () => {
    ({ testContext, fragment, db } = await setup());
  });

  const runService = <T>(call: () => unknown) =>
    fragment.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [call() as TxResult<unknown, unknown>] as const)
        .transform(({ serviceResult: [result] }) => result)
        .execute();
    }) as Promise<T>;

  beforeEach(async () => {
    await drainDurableHooks(fragment);
    await testContext.resetDatabase();
    runner.tick.mockReset();
  });

  test("createInstance should create instance records", async () => {
    const result = await runService<{ id: string; details: { status: string } }>(() =>
      fragment.services.createInstance("demo-workflow", {
        params: { source: "service-test" },
      }),
    );

    expect(result.id).toBeTruthy();
    expect(result.details.status).toBe("queued");

    const [instance] = await db.find("workflow_instance", (b) => b.whereIndex("primary"));
    expect(instance).toMatchObject({
      workflowName: "demo-workflow",
      instanceId: result.id,
      status: "queued",
      pauseRequested: false,
      runNumber: 0,
    });
  });

  test("createInstance should tick the runner via durable hook", async () => {
    await runService(() =>
      fragment.services.createInstance("demo-workflow", {
        id: "hook-1",
      }),
    );

    await drainDurableHooks(fragment);
    expect(runner.tick).toHaveBeenCalledTimes(1);
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

  test("pause and resume should update status", async () => {
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

    expect(runner.tick).toHaveBeenCalledTimes(1);
  });

  test("terminate should mark instance as terminated", async () => {
    await db.create("workflow_instance", {
      workflowName: "demo-workflow",
      instanceId: "terminate-1",
      status: "queued",
      params: {},
      pauseRequested: false,
      runNumber: 0,
      startedAt: null,
      completedAt: null,
      output: null,
      errorName: null,
      errorMessage: null,
    });
    await drainDurableHooks(fragment);
    runner.tick.mockClear();
    const tickCallsBefore = runner.tick.mock.calls.length;

    const terminated = await runService<{ status: string }>(() =>
      fragment.services.terminateInstance("demo-workflow", "terminate-1"),
    );

    expect(terminated.status).toBe("terminated");

    const [instance] = await db.find("workflow_instance", (b) => b.whereIndex("primary"));
    expect(instance).toMatchObject({
      workflowName: "demo-workflow",
      instanceId: "terminate-1",
      status: "terminated",
      pauseRequested: false,
    });
    expect(instance.completedAt).toBeInstanceOf(Date);
    await drainDurableHooks(fragment);
    expect(runner.tick.mock.calls.length).toBe(tickCallsBefore);
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
    runner.tick.mockClear();

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

    expect(runner.tick).toHaveBeenCalledTimes(1);
  });

  test("sendEvent should buffer and wake waiting instance", async () => {
    const created = await runService<{ id: string }>(() =>
      fragment.services.createInstance("demo-workflow", { id: "event-1" }),
    );
    const [instance] = await db.find("workflow_instance", (b) => b.whereIndex("primary"));

    await db.update("workflow_instance", instance.id, (b) =>
      b.set({ status: "waiting", updatedAt: new Date() }),
    );
    await drainDurableHooks(fragment);
    runner.tick.mockClear();

    await db.create("workflow_step", {
      instanceRef: instance.id,
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

    await drainDurableHooks(fragment);
    expect(runner.tick).toHaveBeenCalledTimes(1);
  });

  test("sendEvent should not wake when waitForEvent has timed out", async () => {
    const instanceId = "event-timeout";
    const instanceRef = await db.create("workflow_instance", {
      workflowName: "demo-workflow",
      instanceId,
      status: "waiting",
      params: {},
      pauseRequested: false,
      runNumber: 0,
      startedAt: null,
      completedAt: null,
      output: null,
      errorName: null,
      errorMessage: null,
    });

    runner.tick.mockClear();

    await db.create("workflow_step", {
      instanceRef,
      workflowName: "demo-workflow",
      instanceId,
      runNumber: 0,
      stepKey: "wait-timeout",
      name: "Wait for approval",
      type: "waitForEvent",
      status: "waiting",
      attempts: 0,
      maxAttempts: 1,
      timeoutMs: null,
      nextRetryAt: null,
      wakeAt: new Date("2000-01-01T00:00:00.000Z"),
      waitEventType: "approval",
      result: null,
      errorName: null,
      errorMessage: null,
    });

    await runService(() =>
      fragment.services.sendEvent("demo-workflow", instanceId, {
        type: "approval",
        payload: { approved: true },
      }),
    );

    await drainDurableHooks(fragment);
    const [event] = await db.find("workflow_event", (b) => b.whereIndex("primary"));
    expect(event).toMatchObject({
      workflowName: "demo-workflow",
      instanceId,
      type: "approval",
    });

    expect(runner.tick).not.toHaveBeenCalled();
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

  test("getInstanceMetadata and getInstanceCurrentStep should return operator metadata", async () => {
    const created = await runService<{ id: string }>(() =>
      fragment.services.createInstance("demo-workflow", {
        id: "meta-1",
        params: { source: "meta-test" },
      }),
    );

    const [instance] = await db.find("workflow_instance", (b) => b.whereIndex("primary"));

    const startedAt = new Date("2024-01-02T00:00:00.000Z");
    const updatedAt = new Date("2024-01-02T00:00:10.000Z");

    await db.update("workflow_instance", instance.id, (b) =>
      b.set({
        status: "waiting",
        pauseRequested: true,
        startedAt,
        updatedAt,
      }),
    );

    const firstStepAt = new Date("2024-01-02T00:00:20.000Z");
    const currentStepAt = new Date("2024-01-02T00:00:30.000Z");

    await db.create("workflow_step", {
      instanceRef: instance.id,
      workflowName: "demo-workflow",
      instanceId: created.id,
      runNumber: 0,
      stepKey: "step-1",
      name: "first",
      type: "do",
      status: "complete",
      attempts: 1,
      maxAttempts: 3,
      timeoutMs: null,
      nextRetryAt: null,
      wakeAt: null,
      waitEventType: null,
      result: null,
      errorName: null,
      errorMessage: null,
      createdAt: firstStepAt,
      updatedAt: firstStepAt,
    });

    await db.create("workflow_step", {
      instanceRef: instance.id,
      workflowName: "demo-workflow",
      instanceId: created.id,
      runNumber: 0,
      stepKey: "step-2",
      name: "await-approval",
      type: "waitForEvent",
      status: "waiting",
      attempts: 0,
      maxAttempts: 1,
      timeoutMs: null,
      nextRetryAt: null,
      wakeAt: null,
      waitEventType: "approved",
      result: null,
      errorName: null,
      errorMessage: null,
      createdAt: currentStepAt,
      updatedAt: currentStepAt,
    });

    const meta = await runService<WorkflowInstanceMetadata>(() =>
      fragment.services.getInstanceMetadata("demo-workflow", created.id),
    );

    expect(meta).toMatchObject({
      workflowName: "demo-workflow",
      runNumber: 0,
      params: { source: "meta-test" },
      pauseRequested: true,
      completedAt: null,
    });
    expect(meta.createdAt).toBeInstanceOf(Date);
    expect(meta.updatedAt).toBeInstanceOf(Date);
    expect(meta.startedAt).toBeInstanceOf(Date);

    const currentStep = await runService<WorkflowInstanceCurrentStep | undefined>(() =>
      fragment.services.getInstanceCurrentStep({
        workflowName: "demo-workflow",
        instanceId: created.id,
        runNumber: meta.runNumber,
      }),
    );

    expect(currentStep).toMatchObject({
      stepKey: "step-2",
      name: "await-approval",
      type: "waitForEvent",
      status: "waiting",
      attempts: 0,
      maxAttempts: 1,
      waitEventType: "approved",
    });
  });

  test("getInstanceRunNumber should return current run", async () => {
    await db.create("workflow_instance", {
      workflowName: "demo-workflow",
      instanceId: "history-1",
      status: "queued",
      params: {},
      pauseRequested: false,
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
    const instanceRef = await db.create("workflow_instance", {
      workflowName: "demo-workflow",
      instanceId: "history-2",
      status: "queued",
      params: {},
      pauseRequested: false,
      runNumber: 1,
      startedAt: null,
      completedAt: null,
      output: null,
      errorName: null,
      errorMessage: null,
    });

    await db.create("workflow_step", {
      instanceRef,
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
      instanceRef,
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
      instanceRef,
      workflowName: "demo-workflow",
      instanceId: "history-2",
      runNumber: 1,
      type: "approval",
      payload: { approved: true },
      deliveredAt: null,
      consumedByStepKey: null,
    });

    await db.create("workflow_event", {
      instanceRef,
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
    }>(() =>
      fragment.services.listHistory({
        workflowName: "demo-workflow",
        instanceId: "history-2",
        runNumber: 1,
      }),
    );

    expect(history.runNumber).toBe(1);
    expect(history.steps).toHaveLength(2);
    expect(history.events).toHaveLength(2);
    expect(history.steps[0]?.stepKey).toBeTruthy();
    expect(history.events[0]?.type).toBeTruthy();
  });
});
