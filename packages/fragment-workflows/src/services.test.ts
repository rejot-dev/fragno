// Tests for workflow service APIs such as instance control, history, and events.
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { buildDatabaseFragmentsTest } from "@fragno-dev/test";
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

  const waitForHookTick = async (expectedCalls: number) => {
    const start = Date.now();
    while (runner.tick.mock.calls.length < expectedCalls && Date.now() - start < 200) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };

  beforeEach(async () => {
    await testContext.resetDatabase();
    runner.tick.mockReset();
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

  test("createInstance should tick the runner via durable hook", async () => {
    await runService(() =>
      fragment.services.createInstance("demo-workflow", {
        id: "hook-1",
      }),
    );

    await waitForHookTick(1);
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
    await db.create("workflow_instance", {
      workflowName: "demo-workflow",
      instanceId: "terminate-1",
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
    await new Promise((resolve) => setTimeout(resolve, 25));
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
    await new Promise((resolve) => setTimeout(resolve, 20));
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

    const tasks = await db.find("workflow_task", (b) => b.whereIndex("primary"));
    const restartTask = tasks.find((task) => task.runNumber === 1 && task.kind === "run");
    expect(restartTask).toMatchObject({
      workflowName: "demo-workflow",
      instanceId: created.id,
      status: "pending",
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
    await waitForHookTick(1);
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

    const [task] = await db.find("workflow_task", (b) => b.whereIndex("primary"));
    expect(task).toMatchObject({
      workflowName: "demo-workflow",
      instanceId: created.id,
      kind: "wake",
      status: "pending",
    });

    await waitForHookTick(1);
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
      retentionUntil: null,
      runNumber: 0,
      startedAt: null,
      completedAt: null,
      output: null,
      errorName: null,
      errorMessage: null,
    });

    await db.create("workflow_task", {
      instanceRef,
      workflowName: "demo-workflow",
      instanceId,
      runNumber: 0,
      kind: "run",
      runAt: new Date(),
      status: "pending",
      attempts: 0,
      maxAttempts: 1,
      lastError: null,
      lockedUntil: null,
      lockOwner: null,
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

    await new Promise((resolve) => setTimeout(resolve, 20));
    const [event] = await db.find("workflow_event", (b) => b.whereIndex("primary"));
    expect(event).toMatchObject({
      workflowName: "demo-workflow",
      instanceId,
      type: "approval",
    });

    const [task] = await db.find("workflow_task", (b) => b.whereIndex("primary"));
    expect(task.kind).not.toBe("wake");
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
    const instanceRef = await db.create("workflow_instance", {
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

  test("listHistory should include logs with filtering and pagination", async () => {
    const instanceRef = await db.create("workflow_instance", {
      workflowName: "demo-workflow",
      instanceId: "history-logs",
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

    await db.create("workflow_log", {
      instanceRef,
      workflowName: "demo-workflow",
      instanceId: "history-logs",
      runNumber: 1,
      stepKey: "step-1",
      attempt: 1,
      level: "info",
      category: "alpha",
      message: "first",
      data: { ok: true },
      createdAt: new Date(1000),
    });

    await db.create("workflow_log", {
      instanceRef,
      workflowName: "demo-workflow",
      instanceId: "history-logs",
      runNumber: 1,
      stepKey: "step-2",
      attempt: 1,
      level: "error",
      category: "alpha",
      message: "second",
      data: { ok: false },
      createdAt: new Date(2000),
    });

    await db.create("workflow_log", {
      instanceRef,
      workflowName: "demo-workflow",
      instanceId: "history-logs",
      runNumber: 1,
      stepKey: null,
      attempt: null,
      level: "warn",
      category: "beta",
      message: "third",
      data: null,
      createdAt: new Date(3000),
    });

    const withoutLogs = await runService<{
      logs?: unknown;
      logsCursor?: string;
    }>(() =>
      fragment.services.listHistory({
        workflowName: "demo-workflow",
        instanceId: "history-logs",
        runNumber: 1,
      }),
    );

    expect(withoutLogs.logs).toBeUndefined();
    expect(withoutLogs.logsCursor).toBeUndefined();

    const firstPage = await runService<{
      logs: Array<{ message: string }>;
      logsHasNextPage?: boolean;
    }>(() =>
      fragment.services.listHistory({
        workflowName: "demo-workflow",
        instanceId: "history-logs",
        runNumber: 1,
        pageSize: 2,
        includeLogs: true,
        order: "asc",
      }),
    );

    expect(firstPage.logs).toHaveLength(2);
    expect(firstPage.logsHasNextPage).toBe(true);
    expect(firstPage.logs[0]?.message).toBe("first");

    const errorOnly = await runService<{
      logs: Array<{ level: string; message: string }>;
    }>(() =>
      fragment.services.listHistory({
        workflowName: "demo-workflow",
        instanceId: "history-logs",
        runNumber: 1,
        includeLogs: true,
        logLevel: "error",
      }),
    );

    expect(errorOnly.logs).toHaveLength(1);
    expect(errorOnly.logs[0]?.message).toBe("second");
    expect(errorOnly.logs[0]?.level).toBe("error");

    const categoryOnly = await runService<{
      logs: Array<{ category: string }>;
    }>(() =>
      fragment.services.listHistory({
        workflowName: "demo-workflow",
        instanceId: "history-logs",
        runNumber: 1,
        includeLogs: true,
        logCategory: "beta",
      }),
    );

    expect(categoryOnly.logs).toHaveLength(1);
    expect(categoryOnly.logs[0]?.category).toBe("beta");
  });
});
